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
  const OBSERVER_CHECK_THROTTLE_MS = 400;
  const MAX_STALE_RETRIES = 3;

  class ScrollManager {
    constructor() {
      this._running = false;
      this._stopped = false;
      this._paused = false;
      this._resetting = false;
      this._epoch = 0;
      this._pausePromise = null;
      this._pauseResolve = null;
      this._scrollCount = 0;
      this._scrollLimit = 0;
      this._foundMax = 0;
      this._processed = new Set();
      this._retries = new Map();
      this._deduper = null;
      this._settings = { ...Storage.DEFAULT_SETTINGS };
      this._currentAuthor = '';
      this._tabId = null;
    }

    get tabId() { return this._tabId; }

    /** Remember which tab this content script lives in (scan ownership). */
    setTabId(tabId) {
      this._tabId = typeof tabId === 'number' ? tabId : null;
    }

    /** Initialize from stored settings + processed IDs. */
    async init() {
      this._settings = await Storage.getSettings();
      const state = await Storage.getState();
      const processedIds = Array.isArray(state.processedIds) ? state.processedIds : [];
      this._processed = new Set(processedIds);
      // processedIds are the same quick keys used by buildDedupeKey
      // (url:... / id:...), so seed the deduper with them verbatim.
      this._deduper = Deduplicator.create([...processedIds]);
      this._retries = new Map();
      this._foundMax = 0;
    }

    get isRunning() { return this._running; }
    get isPaused() { return this._paused; }

    /**
     * True while this tab still owns the active scan (or when the owner
     * is unknown, which we treat as permissive). Prevents a losing tab
     * from overwriting a scan another tab took over.
     */
    async ownsScan() {
      if (this._tabId === null) {return true;}
      const state = await Storage.getState();
      return state.scanTabId === null || state.scanTabId === this._tabId;
    }

    /** Stop and drop all in-memory progress (used by CLEAR_RESULTS). */
    reset() {
      this.stop();
      this._stopped = true;
      this._resetting = true;
      this._processed.clear();
      this._retries.clear();
      this._deduper = Deduplicator.create([]);
      this._scrollCount = 0;
      this._scrollLimit = 0;
      this._foundMax = 0;
      this._currentAuthor = '';
      Logger.info('[ScrollManager] scan state reset');
    }

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
      let lastCheck = 0;
      const postCount = () => PostDetector.discoverPosts().length;

      return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
          if (settled) {return;}
          settled = true;
          observer.disconnect();
          clearInterval(poll);
          resolve(result);
        };
        const check = () => {
          // Cheap guard: discovery is expensive, never run it on every
          // single mutation LinkedIn makes.
          const now = Date.now();
          if (now - lastCheck < OBSERVER_CHECK_THROTTLE_MS) {return;}
          lastCheck = now;
          if (postCount() > knownKeys.size) {finish(true);}
        };
        const observer = new MutationObserver(check);
        try {
          observer.observe(document.body, { childList: true, subtree: true });
        } catch {
          /* observer unavailable */
        }

        const poll = setInterval(() => {
          if (Date.now() >= deadline) {
            finish(false);
            return;
          }
          check();
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
        if (this._stopped || this._paused || this._resetting) {break;}

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
          const located = PostDetector.findContainerByKey(key);
          if (located && located.isConnected) {
            livePost = located;
            // React may have replaced the container with a collapsed copy;
            // re-expand idempotently so the extracted text is the full text.
            if (livePost !== post) {await PostExpander.expandPost(livePost);}
          } else {
            // The card vanished (virtualized away / re-rendered). Give it a
            // few more rounds instead of silently dropping it forever.
            const attempts = (this._retries.get(quickKey) || 0) + 1;
            this._retries.set(quickKey, attempts);
            if (attempts >= MAX_STALE_RETRIES) {
              Logger.debug(`[ScrollManager] giving up on stale post ${quickKey} after ${attempts} retries`);
              this._processed.add(quickKey);
            } else {
              Logger.debug(`[ScrollManager] post stale, retry ${attempts}/${MAX_STALE_RETRIES}`);
            }
            continue;
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

        // Never persist after a Stop/Clear request slipped in mid-card.
        if (this._stopped || this._resetting) {break;}

        // Deduplicate against in-memory + stored results.
        const isNew = this._deduper.isNewAndAdd(record);

        if (isNew) {
          const { added: stored } = await Storage.appendResult(record);
          if (stored) {
            added++;
            this._processed.add(quickKey);
            this._retries.delete(quickKey);
            this._currentAuthor = record.authorName;
            Logger.info(`[ScrollManager] saved record: ${record.postId} (${record.authorName})`);
          } else {
            // Stored dedupe says duplicate (e.g., reload).
            Logger.debug('[ScrollManager] duplicate skipped (storage)');
            this._processed.add(quickKey);
            this._retries.delete(quickKey);
          }
        } else {
          Logger.debug('[ScrollManager] duplicate skipped (memory)');
          this._processed.add(quickKey);
          this._retries.delete(quickKey);
        }
      }

      await this._persistProgress();
      return added;
    }

    /** Persist counters to storage (incremental, batched flush). */
    async _persistProgress() {
      if (this._resetting) {return false;}
      if (!(await this.ownsScan())) {
        Logger.warn('[ScrollManager] scan owned by another tab, halting');
        this._stopped = true;
        return false;
      }

      const current = PostDetector.discoverPosts().length;
      this._foundMax = Math.max(this._foundMax, current);
      const results = await Storage.getResults();
      await Storage.saveState({
        status: this._paused ? 'PAUSED' : 'RUNNING',
        postsFound: this._foundMax,
        postsProcessed: this._processed.size,
        uniqueRecords: results.length,
        emailsFound: results.filter((r) => r.emails?.length || r.email).length,
        currentAuthor: this._currentAuthor,
        processedIds: [...this._processed],
        scrollCount: this._scrollCount,
        scrollLimit: this._scrollLimit
      });
      // Checkpoint: make sure every stored record is on disk.
      await Storage.flushResults();
      return true;
    }

    /**
     * Run the extraction loop.
     * Resolves when complete, stopped, or error.
     */
    async run() {
      if (this._running) {return;}
      const epoch = ++this._epoch;
      this._running = true;
      this._stopped = false;
      this._paused = false;
      this._resetting = false;

      try {
        await this.init();

        // Single-scan lock: refuse if another live tab owns the scan.
        const incoming = await Storage.getState();
        if (
          incoming.scanTabId !== null &&
          this._tabId !== null &&
          incoming.scanTabId !== this._tabId
        ) {
          throw new Error('Another LinkedIn tab is already scanning. Stop it there first.');
        }

        await Storage.saveState({
          status: 'RUNNING',
          searchUrl: Helpers.canonicalUrl(global.location?.href || ''),
          startedAt: new Date().toISOString(),
          error: '',
          scanTabId: this._tabId,
          scrollCount: 0
        });

        const scrollLimit = Math.max(1, Math.min(1000, Number(this._settings.scrollLimit) || DEFAULT_SCROLL_LIMIT));
        const scrollDelay = Math.max(500, Math.min(10000, Number(this._settings.scrollDelay) || DEFAULT_SCROLL_DELAY));
        this._scrollLimit = scrollLimit;
        Logger.info(`[ScrollManager] starting: limit=${scrollLimit} delay=${scrollDelay}`);

        this._scrollCount = 0;
        let idleRounds = 0;

        while (!this._stopped && !this._resetting && this._scrollCount < scrollLimit) {
          await this._waitIfPaused();
          if (this._stopped || this._resetting) {break;}

          // Process currently visible posts.
          const added = await this._processPosts();
          if (added > 0) {idleRounds = 0;}
          if (this._stopped || this._resetting) {break;}

          // Scroll down.
          await this._scrollStep();
          await Helpers.sleep(scrollDelay);
          this._scrollCount++;
          Logger.info(`[ScrollManager] scroll ${this._scrollCount}/${scrollLimit}`);

          // Bottom detection.
          if (this._isAtBottom()) {
            // Verification wait: allow lazy-loaded posts to appear.
            const beforePosts = PostDetector.discoverPosts();
            const knownKeys = new Set(beforePosts.map((el) => PostDetector.containerKey(el)));
            const appeared = await this._waitForNewPosts(knownKeys);
            const after = PostDetector.discoverPosts().length;
            if (!appeared && after <= beforePosts.length) {
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

          const persisted = await this._persistProgress();
          if (!persisted && !this._stopped) {break;}
        }

        const finalStatus = this._stopped && !this._resetting ? 'STOPPED' : 'COMPLETED';
        await Storage.flushResults();
        if (epoch === this._epoch && !this._resetting && (await this.ownsScan())) {
          await Storage.saveState({
            status: finalStatus,
            postsProcessed: this._processed.size,
            scrollCount: this._scrollCount,
            scrollLimit: this._scrollLimit,
            completedAt: new Date().toISOString(),
            scanTabId: null
          });
        }
        Logger.info(`[ScrollManager] finished (${finalStatus})`);
      } catch (error) {
        Logger.error('[ScrollManager] fatal error:', error?.message || error);
        await Storage.flushResults();
        if (epoch === this._epoch && !this._resetting && (await this.ownsScan())) {
          await Storage.saveState({
            status: 'ERROR',
            error: String(error?.message || error),
            scanTabId: null
          });
        }
      } finally {
        if (epoch === this._epoch) {this._running = false;}
      }
    }
  }

  NS.ScrollManager = ScrollManager;
})(globalThis);
