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
 * Namespace:
 *   globalThis.LLPE
 */
(function registerContentScript(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const { Logger, Storage, Helpers, ScrollManager } = NS;

  const manager = new ScrollManager();
  let initialized = false;

  /** Reply helper with structured message envelope. */
  function reply(sendResponse, payload) {
    try {
      sendResponse(payload);
    } catch {
      /* popup closed / channel gone */
    }
  }

  /** Build the current STATUS payload. */
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
      results
    };
  }

  /** Handle a structured message from the service worker. */
  async function handleMessage(message) {
    if (!message || typeof message.type !== 'string') {
      return { ok: false, error: 'Malformed message' };
    }

    switch (message.type) {
      case 'START_EXTRACTION': {
        const options = message.options || {};
        if (options.scrollLimit) {await Storage.saveSettings({ scrollLimit: Number(options.scrollLimit) });}
        if (options.scrollDelay) {await Storage.saveSettings({ scrollDelay: Number(options.scrollDelay) });}
        // Start without awaiting so the sender gets an immediate ack.
        manager.run().catch((err) => Logger.error('[ContentScript] run failed:', err));
        return { ok: true, status: 'RUNNING' };
      }

      case 'PAUSE_EXTRACTION':
        manager.pause();
        await Storage.saveState({ status: 'PAUSED' });
        return { ok: true, status: 'PAUSED' };

      case 'RESUME_EXTRACTION':
        manager.resume();
        await Storage.saveState({ status: 'RUNNING' });
        return { ok: true, status: 'RUNNING' };

      case 'STOP_EXTRACTION':
        manager.stop();
        await Storage.saveState({ status: 'STOPPED' });
        return { ok: true, status: 'STOPPED' };

      case 'GET_STATUS':
        return await buildStatus();

      case 'GET_RESULTS': {
        const results = await Storage.getResults();
        return { ok: true, results };
      }

      case 'CLEAR_RESULTS': {
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
      handleMessage(message)
        .then((payload) => reply(sendResponse, payload))
        .catch((error) => {
          Logger.error('[ContentScript] message handler error:', error?.message || error);
          reply(sendResponse, { ok: false, error: String(error?.message || error) });
        });
      // Keep the message channel open for the async reply.
      return true;
    });

    // Auto-resume if the page reloaded while a scan was RUNNING.
    (async () => {
      const state = await Storage.getState();
      const currentUrl = Helpers.canonicalUrl(global.location?.href || '');
      if (state.status === 'RUNNING' && state.searchUrl && state.searchUrl === currentUrl) {
        Logger.info('[ContentScript] resuming interrupted scan after reload');
        manager.run().catch((err) => Logger.error('[ContentScript] auto-resume failed:', err));
      }
    })();

    Logger.info('[ContentScript] initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(globalThis);
