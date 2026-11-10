/**
 * LLPE - Service Worker
 * -----------------------------------------------
 * MV3 service worker. Routes popup commands to the
 * content script, serves status/results from storage,
 * and handles CSV/JSON/HTML exports via chrome.downloads.
 *
 * Message flow:
 *   Popup --> Service Worker --> Content Script
 *   Popup <-- Service Worker <-- Content Script
 *
 * Scan ownership:
 *   START records the target tab in state.scanTabId and hands the scan
 *   over from any previous owner, so PAUSE/RESUME/STOP/CLEAR always go
 *   to the tab that is actually scanning - never to whatever tab happens
 *   to be active when the button is clicked.
 *
 * Namespace:
 *   globalThis.LLPE
 */
importScripts(
  '../utils/logger.js',
  '../utils/helpers.js',
  '../utils/storage.js',
  '../utils/csv-exporter.js',
  '../utils/json-exporter.js',
  '../utils/html-exporter.js'
);

const NS = globalThis.LLPE;
const { Logger, Storage, Helpers, CsvExporter, JsonExporter, HtmlExporter } = NS;

const LINKEDIN_URL_RE = /^https:\/\/(www\.)?linkedin\.com\//i;
const SEARCH_RESULTS_RE = /\/search\/results\//i;

/** Clamp a number into a range with a fallback for non-finite input. */
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) {return fallback;}
  return Math.min(max, Math.max(min, n));
}

function isSearchResultsUrl(url) {
  if (typeof url !== 'string' || !url) {return false;}
  return LINKEDIN_URL_RE.test(url) && SEARCH_RESULTS_RE.test(url);
}

/** Find the active tab that is a LinkedIn search-results page. */
async function findLinkedInTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (tab && typeof tab.id === 'number' && tab.url && isSearchResultsUrl(tab.url)) {
    return tab;
  }
  return null;
}

/**
 * Return the tab only if it still exists, is on LinkedIn and is a
 * search-results page (i.e. it could actually run a scan).
 */
async function getLiveSearchTab(tabId) {
  if (typeof tabId !== 'number') {return null;}
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && isSearchResultsUrl(tab.url) ? tab : null;
  } catch {
    return null; // tab closed
  }
}

/** The tab a control command should be sent to (scan owner first). */
async function resolveControlTab() {
  const state = await Storage.getState();
  const owner = await getLiveSearchTab(state.scanTabId);
  if (owner) {return owner;}
  return findLinkedInTab();
}

/** Content-script files, taken from the manifest so SW and manifest stay in sync. */
const CONTENT_SCRIPT_FILES =
  (chrome.runtime.getManifest().content_scripts || []).reduce(
    (files, entry) => files.concat(entry.js || []),
    []
  );

/**
 * Inject the content script on demand. Needed when the LinkedIn tab was
 * opened BEFORE the extension was installed/reloaded - content scripts
 * only auto-inject at page load, so those tabs never had a listener.
 * Injection stays inside the declared scope (search-results pages).
 */
async function ensureContentScript(tabId) {
  if (typeof chrome.scripting === 'undefined') {return false;}
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && typeof tab.url === 'string' && tab.url && !isSearchResultsUrl(tab.url)) {
      Logger.debug('[ServiceWorker] refusing injection outside search results');
      return false;
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES
    });
    Logger.info('[ServiceWorker] content script injected on demand');
    return true;
  } catch (error) {
    Logger.warn('[ServiceWorker] content script injection failed:', error?.message || error);
    return false;
  }
}

/**
 * Send a message to a tab and resolve with the response.
 *
 * chrome.tabs.sendMessage() does NOT accept a `timeout` option — only
 * frameId/documentId are valid — so passing `{ timeout }` makes Chrome reject
 * the whole call with "Unexpected property: 'timeout'" before it ever reaches
 * the content script. Timeout is implemented manually via Promise.race.
 */
function sendMessageWithTimeout(tabId, message, timeoutMs) {
  const send = chrome.tabs.sendMessage(tabId, message);
  if (!timeoutMs || timeoutMs <= 0) {return send;}
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Content script did not respond within ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  return Promise.race([send, timeout]).finally(() => clearTimeout(timer));
}

/** Send a message to the content script with timeout; auto-inject + retry once. */
async function sendToContentScript(tabId, message, timeoutMs = 8000) {
  if (typeof tabId !== 'number') {throw new Error('No active tab');}
  try {
    return await sendMessageWithTimeout(tabId, message, timeoutMs);
  } catch (error) {
    const reason = String((error && error.message) || error);
    // Only inject when there is genuinely NO content script. Other failures
    // (timeout, closed port) mean a script IS present — never duplicate it,
    // or we would register a second listener and run double scroll loops.
    if (!/Receiving end does not exist/i.test(reason)) {
      throw new Error(`Content script error: ${reason}`);
    }
    if (await ensureContentScript(tabId)) {
      return await sendMessageWithTimeout(tabId, message, timeoutMs);
    }
    throw new Error('Content script unavailable. Reload the LinkedIn page and try again.');
  }
}

/**
 * Download a text file via chrome.downloads.
 * Uses a self-contained data: URL instead of a blob: URL. Blob URLs created by
 * an MV3 service worker are tied to the worker lifetime and can fail with
 * "Failed - Network error" if the worker terminates or the blob is revoked
 * (e.g., while the Save As dialog is still open) before the downloader fetches
 * the URL. Data URLs have no lifetime dependency, so downloads always succeed.
 */
function toBase64DataUrl(content, mimeType) {
  const bytes = new TextEncoder().encode(content);
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

async function downloadFile(content, filename, mimeType, options = {}) {
  if (typeof chrome.downloads === 'undefined') {
    throw new Error('Downloads API unavailable');
  }
  const url = toBase64DataUrl(content, mimeType);
  try {
    const id = await chrome.downloads.download({
      url,
      filename,
      saveAs: options.saveAs !== false,
      conflictAction: options.conflictAction || 'uniquify'
    });
    Logger.info(`[ServiceWorker] download started id=${id}`);
    return { ok: true, downloadId: id };
  } catch (error) {
    Logger.error('[ServiceWorker] download failed:', error?.message || error);
    throw new Error(`Download failed: ${error?.message || error}`);
  }
}

/** Build a status payload from storage (works without content script). */
async function buildStatusPayload() {
  const state = await Storage.getState();
  const results = await Storage.getResults();
  return {
    ok: true,
    status: state.status || 'IDLE',
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

/** Build the export payload (content + filename + mime type) for one result set. */
function buildExportPayload(results, type, state, keyword, contextOverrides = {}) {
  switch (type) {
    case 'EXPORT_CSV':
      return {
        content: CsvExporter.buildCsvFile(results),
        filename: `${keyword || 'linkedin'}-public-posts.csv`,
        mimeType: 'text/csv;charset=utf-8'
      };
    case 'EXPORT_JSON':
      return {
        content: JsonExporter.buildJsonFile(results),
        filename: `${keyword || 'linkedin'}-public-posts.json`,
        mimeType: 'application/json;charset=utf-8'
      };
    case 'EXPORT_HTML':
      return {
        content: HtmlExporter.buildHtmlReport(results, {
          searchKeyword: state.searchKeyword || '',
          sourcePageUrl: state.searchUrl || '',
          postsFound: state.postsFound || 0,
          ...contextOverrides
        }),
        filename: `${keyword || 'linkedin'}-public-posts-report.html`,
        mimeType: 'text/html;charset=utf-8'
      };
    default:
      return null;
  }
}

async function handleExport(message) {
  let results = await Storage.getResults();
  const state = await Storage.getState();
  const rawKeyword = Helpers.searchKeywordFromUrl(state.searchUrl || '');
  const keyword = Helpers.safeFilename(rawKeyword, 'linkedin');

  // Single-file exports are scoped to the keyword named in the filename so
  // multi-keyword runs never silently mix. Records without any keyword
  // (legacy data) stay included - they cannot be attributed elsewhere.
  if (!message.batchAll && rawKeyword) {
    results = results.filter((record) => {
      const recordKeyword = String(record?.searchKeyword || '').trim();
      return !recordKeyword || recordKeyword === rawKeyword;
    });
  }

  if (message.hiringOnly) {
    results = results.filter((record) => Helpers.recordIsHiring(record));
    if (results.length === 0) {
      return { ok: false, error: 'No hiring posts found to export.' };
    }
  }

  // Batch mode: one file per stored search keyword (silent downloads, no Save As dialog).
  if (message.batchAll) {
    const groups = Helpers.groupRecordsByKeyword(results);
    if (groups.size === 0) {
      return { ok: false, error: 'No stored results found to export.' };
    }
    let downloaded = 0;
    const errors = [];
    for (const [groupKeyword, groupRecords] of groups) {
      const groupName = Helpers.safeFilename(groupKeyword, 'unknown');
      const first = groupRecords[0] || {};
      const payload = buildExportPayload(groupRecords, message.type, state, groupName, {
        searchKeyword: first.searchKeyword || groupName,
        sourcePageUrl: first.sourcePageUrl || '',
        postsFound: groupRecords.length
      });
      if (!payload) {
        return { ok: false, error: `Unknown export type: ${message.type}` };
      }
      try {
        await downloadFile(payload.content, payload.filename, payload.mimeType, {
          saveAs: false,
          conflictAction: 'uniquify'
        });
        downloaded += 1;
      } catch (error) {
        errors.push(`${groupName}: ${error?.message || error}`);
      }
    }
    if (downloaded === 0) {
      return { ok: false, error: `Batch export failed: ${errors.join('; ')}` };
    }
    return {
      ok: true,
      files: downloaded,
      total: groups.size,
      ...(errors.length ? { errors } : {})
    };
  }

  if (!results.length) {
    return { ok: false, error: 'No results to export yet. Run an extraction first.' };
  }

  const payload = buildExportPayload(results, message.type, state, keyword);
  if (!payload) {
    return { ok: false, error: `Unknown export type: ${message.type}` };
  }
  return downloadFile(payload.content, payload.filename, payload.mimeType, { saveAs: true });
}

/** Hand CLEAR over to the scanning tab (so it stops first), then wipe storage. */
async function handleClear() {
  const state = await Storage.getState();
  const owner = await getLiveSearchTab(state.scanTabId);
  if (owner) {
    try {
      await sendToContentScript(owner.id, { type: 'CLEAR_RESULTS' });
    } catch (error) {
      Logger.warn('[ServiceWorker] clear handoff failed:', error?.message || error);
    }
  }
  await Storage.clearAll();
}

/**
 * START: enforce scope, take the single-scan lock from any previous owner,
 * register this tab as owner, then forward the command.
 */
async function handleStart(message) {
  const tab = await findLinkedInTab();
  if (!tab) {
    throw new Error('Open a LinkedIn search-results page first.');
  }

  const state = await Storage.getState();
  const ownerTabId = state.scanTabId;
  if (typeof ownerTabId === 'number' && ownerTabId !== tab.id) {
    const previous = await getLiveSearchTab(ownerTabId);
    if (previous) {
      Logger.info(`[ServiceWorker] handing scan off from tab ${ownerTabId} to tab ${tab.id}`);
      try {
        await sendToContentScript(ownerTabId, { type: 'STOP_EXTRACTION' });
      } catch (error) {
        Logger.warn('[ServiceWorker] previous scan stop failed:', error?.message || error);
      }
    }
  }

  await Storage.saveState({ scanTabId: tab.id });

  const options = {
    scrollLimit: clampInt(message.options?.scrollLimit, 1, 1000, Storage.DEFAULT_SETTINGS.scrollLimit),
    scrollDelay: clampInt(message.options?.scrollDelay, 500, 10000, Storage.DEFAULT_SETTINGS.scrollDelay)
  };
  await Storage.saveSettings(options);

  const response = await sendToContentScript(tab.id, {
    type: 'START_EXTRACTION',
    options,
    tabId: tab.id
  });
  return { ok: true, ...(response || {}) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== 'string') {
      sendResponse({ ok: false, error: 'Malformed message' });
      return;
    }

    Logger.debug('[ServiceWorker] message:', message.type);

    try {
      switch (message.type) {
        case 'CONTENT_HELLO':
          sendResponse({
            ok: true,
            tabId: sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null
          });
          break;

        case 'START_EXTRACTION':
          sendResponse(await handleStart(message));
          break;

        case 'PAUSE_EXTRACTION':
        case 'RESUME_EXTRACTION':
        case 'STOP_EXTRACTION': {
          const tab = await resolveControlTab();
          if (tab) {
            const response = await sendToContentScript(tab.id, { type: message.type });
            sendResponse({ ok: true, ...(response || {}) });
            break;
          }
          if (message.type === 'STOP_EXTRACTION') {
            // No live scan tab - clear a stale RUNNING state instead of
            // leaving the popup stuck on a scan that cannot be stopped.
            await Storage.saveState({ status: 'STOPPED', scanTabId: null });
            sendResponse({ ok: true, status: 'STOPPED' });
            break;
          }
          throw new Error('Open a LinkedIn search-results page first.');
        }

        case 'CLEAR_RESULTS':
          await handleClear();
          sendResponse({ ok: true });
          break;

        case 'GET_STATUS': {
          const state = await Storage.getState();
          const candidates = [await getLiveSearchTab(state.scanTabId), await findLinkedInTab()];
          for (const tab of candidates) {
            if (!tab) {continue;}
            try {
              const response = await sendToContentScript(tab.id, { type: 'GET_STATUS' });
              if (response && response.ok) {sendResponse(response); return;}
            } catch (error) {
              Logger.debug('[ServiceWorker] status probe failed:', error?.message || error);
            }
          }
          sendResponse(await buildStatusPayload());
          break;
        }

        case 'GET_RESULTS': {
          const results = await Storage.getResults();
          sendResponse({ ok: true, results });
          break;
        }

        case 'GET_SETTINGS': {
          const settings = await Storage.getSettings();
          sendResponse({ ok: true, settings });
          break;
        }

        case 'SAVE_SETTINGS': {
          const settings = await Storage.saveSettings({
            scrollLimit: clampInt(message.settings?.scrollLimit, 1, 1000, Storage.DEFAULT_SETTINGS.scrollLimit),
            scrollDelay: clampInt(message.settings?.scrollDelay, 500, 10000, Storage.DEFAULT_SETTINGS.scrollDelay)
          });
          sendResponse({ ok: true, settings });
          break;
        }

        case 'EXPORT_CSV':
        case 'EXPORT_JSON':
        case 'EXPORT_HTML': {
          sendResponse(await handleExport(message));
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (error) {
      Logger.error('[ServiceWorker] handler error:', error?.message || error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
  // Keep the async response channel open.
  return true;
});

Logger.info('[ServiceWorker] initialized');
