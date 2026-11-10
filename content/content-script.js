/**
 * LLPE - Content Script Entry Point
 * -----------------------------------------------
 * Wires the scanner modules to the page and handles
 * messages routed from the service worker.
 *
 * The service worker forwards commands (START, PAUSE, ...)
 * to this script via chrome.tabs.sendMessage; this script
 * replies with the requested data. Storage is the source
 * of truth so the popup can poll independently.
 *
 * Tab ownership:
 *   The SW learns this tab's id from `sender.tab.id` (CONTENT_HELLO)
 *   and stores it as `state.scanTabId`, so Pause/Resume/Stop/Clear are
 *   always routed to the tab that is actually scanning, and a tab that
 *   lost ownership never overwrites state.
 *
 * Namespace:
 *   globalThis.LLPE
 */
(function registerContentScript(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const { Logger, Storage, Helpers, ScrollManager } = NS;

  const manager = new ScrollManager();
  let initialized = false;
  let tabIdPromise = null;

  /** Reply helper with structured message envelope. */
  function reply(sendResponse, payload) {
    try {
      sendResponse(payload);
    } catch {
      /* popup closed / channel gone */
    }
  }

  /** Resolve our own tab id once (service worker answers from sender.tab.id). */
  function ensureTabId() {
    if (!tabIdPromise) {
      tabIdPromise = chrome.runtime
        .sendMessage({ type: 'CONTENT_HELLO' })
        .then((res) => (res && typeof res.tabId === 'number' ? res.tabId : null))
        .catch((error) => {
          Logger.debug('[ContentScript] tab id handshake failed:', error?.message || error);
          return null;
        });
    }
    return tabIdPromise;
  }

  /** Make sure the manager knows which tab it lives in. */
  async function ensureManagerTab() {
    if (manager.tabId === null) {manager.setTabId(await ensureTabId());}
  }

  /** Scan scope is enforced at runtime as well as in the manifest. */
  function isSearchResultsPage(url) {
    try {
      const parsed = new URL(url || global.location?.href || '');
      return /\/search\/results\//i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  /** Build the current STATUS payload (counters only - never the records). */
  async function buildStatus() {
    const state = await Storage.getState();
    const results = await Storage.getResults();
    return {
      ok: true,
      status: state.status,
      postsFound: state.postsFound || 0,
      postsProcessed: state.postsProcessed || 0,
      uniqueRecords: results.length,
      emailsFound: state.emailsFound || 0,
      currentAuthor: state.currentAuthor || '',
      error: state.error || '',
      scrollCount: state.scrollCount || 0,
      scrollLimit: state.scrollLimit || 0
    };
  }

  /** Handle a structured message from the service worker. */
  async function handleMessage(message) {
    if (!message || typeof message.type !== 'string') {
      return { ok: false, error: 'Malformed message' };
    }

    switch (message.type) {
      case 'START_EXTRACTION': {
        if (!isSearchResultsPage(global.location?.href || '')) {
          return {
            ok: false,
            error: 'Open a LinkedIn search-results page first (the URL must contain /search/results/).'
          };
        }
        const options = message.options || {};
        if (options.scrollLimit) {await Storage.saveSettings({ scrollLimit: Number(options.scrollLimit) });}
        if (options.scrollDelay) {await Storage.saveSettings({ scrollDelay: Number(options.scrollDelay) });}
        await ensureManagerTab();
        if (typeof message.tabId === 'number') {manager.setTabId(message.tabId);}
        if (manager.tabId !== null) {await Storage.saveState({ scanTabId: manager.tabId });}
        // Start without awaiting so the sender gets an immediate ack.
        manager.run().catch((err) => Logger.error('[ContentScript] run failed:', err));
        return { ok: true, status: 'RUNNING' };
      }

      case 'PAUSE_EXTRACTION':
        await ensureManagerTab();
        if (!manager.isRunning && !manager.isPaused) {
          return { ok: false, error: 'No scan is running in this tab.' };
        }
        manager.pause();
        if (await manager.ownsScan()) {await Storage.saveState({ status: 'PAUSED' });}
        return { ok: true, status: 'PAUSED' };

      case 'RESUME_EXTRACTION':
        await ensureManagerTab();
        if (!manager.isPaused) {
          return { ok: false, error: 'The scan is not paused.' };
        }
        manager.resume();
        if (await manager.ownsScan()) {await Storage.saveState({ status: 'RUNNING' });}
        return { ok: true, status: 'RUNNING' };

      case 'STOP_EXTRACTION':
        await ensureManagerTab();
        manager.stop();
        if (await manager.ownsScan()) {
          await Storage.flushResults();
          await Storage.saveState({ status: 'STOPPED', scanTabId: null });
        }
        return { ok: true, status: 'STOPPED' };

      case 'GET_STATUS':
        return await buildStatus();

      case 'GET_RESULTS': {
        const results = await Storage.getResults();
        return { ok: true, results };
      }

      case 'CLEAR_RESULTS': {
        // Stop and forget the running scan first, otherwise it keeps
        // appending into (and re-persisting) storage we just wiped.
        manager.reset();
        await Storage.clearAll();
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown message type: ${message.type}` };
    }
  }

  /** Listen for service-worker messages. */
  function init() {
    if (initialized) {return;}
    initialized = true;

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      // OCR messages are handled by the offscreen document, not here.
      if (message && typeof message.type === 'string' && message.type.startsWith('OCR_')) {return false;}
      handleMessage(message)
        .then((payload) => reply(sendResponse, payload))
        .catch((error) => {
          Logger.error('[ContentScript] message handler error:', error?.message || error);
          reply(sendResponse, { ok: false, error: String(error?.message || error) });
        });
      // Keep the message channel open for the async reply.
      return true;
    });

    // Discover our tab id early so scan ownership is correct on Start.
    ensureTabId();

    // Auto-resume if the page reloaded while a scan was RUNNING.
    (async () => {
      const state = await Storage.getState();
      if (state.status !== 'RUNNING' || !state.searchUrl) {return;}
      const currentUrl = Helpers.canonicalUrl(global.location?.href || '');
      if (state.searchUrl !== currentUrl) {return;}
      if (!isSearchResultsPage(currentUrl)) {return;}

      const tabId = await ensureTabId();
      if (state.scanTabId !== null && tabId !== null && state.scanTabId !== tabId) {
        Logger.info('[ContentScript] scan owned by another tab, not resuming');
        return;
      }
      manager.setTabId(tabId);
      Logger.info('[ContentScript] resuming interrupted scan after reload');
      manager.run().catch((err) => Logger.error('[ContentScript] auto-resume failed:', err));
    })();

    // Make sure batched records reach disk before the page goes away.
    const flush = () => {Storage.flushResults().catch(() => {});};
    global.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {flush();}
    });

    Logger.info('[ContentScript] initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(globalThis);
