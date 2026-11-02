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

/** Find the active tab that is a LinkedIn page. */
async function findLinkedInTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (tab && tab.id && tab.url && LINKEDIN_URL_RE.test(tab.url)) {
    return tab;
  }
  return null;
}

/** Content-script files, taken from the manifest so SW and manifest stay in sync. */
const CONTENT_SCRIPT_FILES =
  (chrome.runtime.getManifest().content_scripts || []).reduce(
    (files, entry) => files.concat(entry.js || []),
    []
  );

/**
 * Inject the content script on demand. Needed when the LinkedIn tab was
 * opened BEFORE the extension was installed/reloaded — content scripts
 * only auto-inject at page load, so those tabs never had a listener.
 */
async function ensureContentScript(tabId) {
  if (typeof chrome.scripting === 'undefined') {return false;}
  try {
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
    results
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
  const keyword = Helpers.safeFilename(Helpers.searchKeywordFromUrl(state.searchUrl || ''));

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
      const groupName = Helpers.safeFilename(groupKeyword) || 'unknown';
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

  const payload = buildExportPayload(results, message.type, state, keyword);
  if (!payload) {
    return { ok: false, error: `Unknown export type: ${message.type}` };
  }
  return downloadFile(payload.content, payload.filename, payload.mimeType, { saveAs: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== 'string') {
      sendResponse({ ok: false, error: 'Malformed message' });
      return;
    }

    Logger.debug('[ServiceWorker] message:', message.type);

    try {
      switch (message.type) {
        case 'START_EXTRACTION': {
          const tab = await findLinkedInTab();
          if (!tab) {throw new Error('Open a LinkedIn search-results page first.');}
          const options = {
            scrollLimit: Number(message.options?.scrollLimit) || Storage.DEFAULT_SETTINGS.scrollLimit,
            scrollDelay: Number(message.options?.scrollDelay) || Storage.DEFAULT_SETTINGS.scrollDelay
          };
          const response = await sendToContentScript(tab.id, { type: 'START_EXTRACTION', options });
          sendResponse({ ok: true, ...(response || {}) });
          break;
        }

        case 'PAUSE_EXTRACTION':
        case 'RESUME_EXTRACTION':
        case 'STOP_EXTRACTION':
        case 'CLEAR_RESULTS': {
          const tab = await findLinkedInTab();
          if (!tab) {throw new Error('Open a LinkedIn search-results page first.');}
          const response = await sendToContentScript(tab.id, { type: message.type });
          sendResponse({ ok: true, ...(response || {}) });
          break;
        }

        case 'GET_STATUS': {
          const tab = await findLinkedInTab();
          if (tab) {
            try {
              const response = await sendToContentScript(tab.id, { type: 'GET_STATUS' });
              sendResponse(response || (await buildStatusPayload()));
            } catch {
              // Content script unavailable — fall back to storage-only status.
              sendResponse(await buildStatusPayload());
            }
          } else {
            sendResponse(await buildStatusPayload());
          }
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
