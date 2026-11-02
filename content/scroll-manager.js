/**
 * LLPE - Scroll Manager
 * -----------------------------------------------
 * Controlled asynchronous scrolling loop for the
 * LinkedIn search-results page.
 *
 * Flow per iteration:
 *   discover visible posts -> expand -> extract -> dedupe -> persist
 *   -> scroll down -> wait for lazy loading -> bottom detection
 *   -> verification wait -> stop if no new posts
 *
 * Features:
 *  - Configurable scroll limit + delay (from storage settings)
 *  - Start / Pause / Resume / Stop
 *  - requestAnimationFrame where appropriate
 *  - MutationObserver for lazy-load signal
 *  - No infinite while(true), no blocking sleep loops
 *
 * Namespace:
 *   globalThis.LLPE.ScrollManager
 */
(function registerScrollManager(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const {
    Helpers, Storage, Logger, PostDetector, PostExpander, PostExtractor, Deduplicator
  } = NS;

  const DEFAULT_SCROLL_LIMIT = 100;
  const DEFAULT_SCROLL_DELAY = 2000;
  const BOTTOM_TOLERANCE = 120;
  const MIN_SCROLL_STEP = 500;
  const MAX_VERIFY_WAIT_MS = 2500;
  const NEW_POST_OBSERVE_MS = 2500;

  class ScrollManager {
    constructor() {
      this._running = false;
      this._stopped = false;
      this._paused = false;
      this._pausePromise = null;
      this._pauseResolve = null;
      this._scrollCount = 0;
      this._processed = new Set();
      this._deduper = null;
      this._settings = { ...Storage.DEFAULT_SETTINGS };
      this._observer = null;
      this._currentAuthor = '';
    }

    /** Initialize from stored settings + processed IDs. */
    async init() {
      this._settings = await Storage.getSettings();
      const state = await Storage.getState();
      const processedIds = Array.isArray(state.processedIds) ? state.processedIds : [];
      this._processed = new Set(processedIds);
      this._deduper = Deduplicator.create(processedIds.map((id) => `id:${id}`));
    }

    get isRunning() { return this._running; }
    get isPaused() { return this._paused; }

    /** Pause the loop at the next safe checkpoint. */
    pause() {
      if (!this._running || this._paused) {return;}
      this._paused = true;
      this._pausePromise = new Promise((resolve) => { this._pauseResolve = resolve; });
      Logger.info('[ScrollManager] pause requested');
    }

    /** Resume from pause. */
    resume() {
      if (!this._paused) {return;}
      this._paused = false;
      if (this._pauseResolve) {this._pauseResolve();}
      this._pausePromise = null;
      this._pauseResolve = null;
      Logger.info('[ScrollManager] resume requested');
    }

    /** Request a safe stop. */
    stop() {
      if (!this._running) {return;}
      this._stopped = true;
      // Unblock a pending pause wait so the loop can exit.
      if (this._pauseResolve) {
        this._pauseResolve();
        this._pauseResolve = null;
        this._pausePromise = null;
      }
      Logger.info('[ScrollManager] stop requested');
    }

    /** Wait while paused (resolves on resume or stop). */
    async _waitIfPaused() {
      while (this._paused && !this._stopped) {
        await this._pausePromise;
        this._pausePromise = null;
        this._pauseResolve = null;
      }
    }

    /** Scroll by one viewport-ish step using rAF + explicit wait. */
    async _scrollStep() {
      return new Promise((resolve) => {
        const step = () => {
          const maxY = Math.max(0, document.documentElement.scrollHeight - global.innerHeight);
          const target = Math.min(global.scrollY + Math.max(MIN_SCROLL_STEP, global.innerHeight * 0.75), maxY);
          global.scrollTo({ top: target, behavior: 'smooth' });
          resolve();
        };
        // Use rAF when available to keep rendering smooth.
        if (typeof global.requestAnimationFrame === 'function') {
          global.requestAnimationFrame(step);
        } else {
          step();
        }
      });
    }

    /** Detect whether the page is at/near the bottom. */
    _isAtBottom() {
      const scrollHeight = document.documentElement.scrollHeight;
      const pos = global.scrollY + global.innerHeight;
      return pos >= scrollHeight - BOTTOM_TOLERANCE;
    }

    /** Wait for new posts to appear (MutationObserver + polling). */
    async _waitForNewPosts(knownKeys) {
      const deadline = Date.now() + NEW_POST_OBSERVE_MS;
      const postCount = () => PostDetector.discoverPosts().length;

      return new Promise((resolve) => {
        let observed = false;
        const observer = new MutationObserver(() => {
          const count = postCount();
          if (count > knownKeys.size) {
            observed = true;
            observer.disconnect();
            resolve(true);
          }
        });
        try {
          observer.observe(document.body, { childList: true, subtree: true });
        } catch {
          /* observer unavailable */
        }

        const poll = setInterval(() => {
          if (Date.now() >= deadline) {
            clearInterval(poll);
            observer.disconnect();
            resolve(false);
          } else if (observed) {
            clearInterval(poll);
            observer.disconnect();
            resolve(true);
          }
        }, 250);
      });
    }

    /**
     * Process all currently discovered posts.
     * Returns count of newly added records.
     */
    async _processPosts() {
      const posts = PostDetector.discoverPosts();
      let added = 0;

      for (const post of posts) {
        if (this._stopped || this._paused) {break;}

        // Quick key to skip already-processed posts cheaply.
        const postUrl = PostExtractor.findPostUrl(post);
        const quickKey = postUrl
          ? `url:${Helpers.normalizeUrlForCompare(postUrl)}`
          : `id:${PostExtractor.derivePostId(post, '')}`;
        if (this._processed.has(quickKey)) {continue;}

        // Scroll the post into view before expanding.
        try {
          post.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        } catch {
          /* ignore */
        }
        await Helpers.sleep(150);

        // Expand truncated post text before extracting.
        let livePost = post;
        await PostExpander.expandPost(post);

        // Re-locate the post after DOM churn (stale element safety).
        if (!post.isConnected) {
          const key = PostExtractor.derivePostId(post, PostExtractor.findPostUrl(post));
          livePost = PostDetector.findContainerByKey(key) || post;
          // React may have replaced the container with a collapsed copy;
          // re-expand idempotently so the extracted text is the full text.
          if (livePost && livePost !== post && livePost.isConnected) {
            await PostExpander.expandPost(livePost);
          }
        }

        const record = await PostExtractor.extractPost(livePost, {
          searchKeyword: Helpers.searchKeywordFromUrl(global.location?.href || '')
        });
        if (!record) {
          Logger.debug('[ScrollManager] record null, skipping');
          this._processed.add(quickKey);
          continue;
        }

        // Deduplicate against in-memory + stored results.
        const dedupeKey = Deduplicator.buildDedupeKey(record);
        const isNew = this._deduper.isNewAndAdd(record);

        if (isNew) {
          const { added: stored } = await Storage.appendResult(record);
          if (stored) {
            added++;
            this._processed.add(quickKey);
            this._currentAuthor = record.authorName;
            Logger.info(`[ScrollManager] saved record: ${record.postId} (${record.authorName})`);
          } else {
            // Stored dedupe says duplicate (e.g., reload).
            Logger.debug('[ScrollManager] duplicate skipped (storage)');
          }
        } else {
          Logger.debug('[ScrollManager] duplicate skipped (memory)');
          this._processed.add(quickKey);
        }
      }

      await this._persistProgress();
      return added;
    }

    /** Persist counters to storage (incremental, crash-safe). */
    async _persistProgress() {
      const postsFound = PostDetector.discoverPosts().length;
      const results = await Storage.getResults();
      await Storage.saveState({
        status: this._paused ? 'PAUSED' : 'RUNNING',
        postsFound,
        postsProcessed: this._processed.size,
        uniqueRecords: results.length,
        emailsFound: results.filter((r) => r.emails?.length || r.email).length,
        currentAuthor: this._currentAuthor,
        processedIds: [...this._processed]
      });
    }

    /**
     * Run the extraction loop.
     * Resolves when complete, stopped, or error.
     */
    async run() {
      if (this._running) {return;}
      this._running = true;
      this._stopped = false;
      this._paused = false;

      try {
        await this.init();
        await Storage.saveState({ status: 'RUNNING', searchUrl: Helpers.canonicalUrl(global.location?.href || ''), startedAt: new Date().toISOString(), error: '' });

        const scrollLimit = Math.max(1, Math.min(1000, Number(this._settings.scrollLimit) || DEFAULT_SCROLL_LIMIT));
        const scrollDelay = Math.max(500, Math.min(10000, Number(this._settings.scrollDelay) || DEFAULT_SCROLL_DELAY));
        Logger.info(`[ScrollManager] starting: limit=${scrollLimit} delay=${scrollDelay}`);

        this._scrollCount = 0;
        let idleRounds = 0;

        while (!this._stopped && this._scrollCount < scrollLimit) {
          await this._waitIfPaused();
          if (this._stopped) {break;}

          // Process currently visible posts.
          const added = await this._processPosts();
          if (added > 0) {idleRounds = 0;}

          // Scroll down.
          await this._scrollStep();
          await Helpers.sleep(scrollDelay);
          this._scrollCount++;
          Logger.info(`[ScrollManager] scroll ${this._scrollCount}/${scrollLimit}`);

          // Bottom detection.
          if (this._isAtBottom()) {
            // Verification wait: allow lazy-loaded posts to appear.
            const before = PostDetector.discoverPosts().length;
            const appeared = await this._waitForNewPosts(new Set());
            const after = PostDetector.discoverPosts().length;
            if (!appeared && after <= before) {
              if (++idleRounds >= 3) {
                Logger.info('[ScrollManager] reached bottom with no new posts, stopping');
                break;
              }
            } else {
              idleRounds = 0;
            }
          } else {
            idleRounds = 0;
          }

          await this._persistProgress();
        }

        const finalStatus = this._stopped ? 'STOPPED' : 'COMPLETED';
        await Storage.saveState({
          status: finalStatus,
          postsProcessed: this._processed.size,
          completedAt: new Date().toISOString()
        });
        Logger.info(`[ScrollManager] finished (${finalStatus})`);
      } catch (error) {
        Logger.error('[ScrollManager] fatal error:', error?.message || error);
        await Storage.saveState({ status: 'ERROR', error: String(error?.message || error) });
      } finally {
        this._running = false;
      }
    }
  }

  NS.ScrollManager = ScrollManager;
})(globalThis);
