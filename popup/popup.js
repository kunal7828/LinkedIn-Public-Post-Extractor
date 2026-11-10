/**
 * LLPE - Popup Controller
 * -----------------------------------------------
 * Talks to the SERVICE WORKER (not the content script).
 *
 * Message flow:
 *   Popup --> Service Worker --> Content Script
 *
 * The popup polls GET_STATUS every 800 ms while open so
 * live counters, progress, and button states stay in sync
 * even when the service worker routes through storage.
 *
 * Namespace: none (popup page scripts are isolated).
 */

'use strict';

const $ = (id) => document.getElementById(id);

/** Send a message to the service worker and normalize the reply. */
async function sendToWorker(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response || { ok: false, error: 'No response from service worker' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/** Read current settings from the inputs (clamped to valid ranges). */
function readSettings() {
  const limitEl = $('scroll-limit');
  const delayEl = $('scroll-delay');

  const rawLimit = Number(limitEl.value);
  const rawDelay = Number(delayEl.value);

  const scrollLimit = Number.isFinite(rawLimit)
    ? Math.min(1000, Math.max(1, Math.round(rawLimit)))
    : 100;

  const scrollDelay = Number.isFinite(rawDelay)
    ? Math.min(10000, Math.max(500, Math.round(rawDelay)))
    : 2000;

  limitEl.value = String(scrollLimit);
  delayEl.value = String(scrollDelay);

  const ocrEl = $('ocr-images');
  const capEl = $('daily-cap');
  const rawCap = Number(capEl ? capEl.value : 0);
  const dailyCap = Number.isFinite(rawCap) ? Math.min(100, Math.max(0, Math.round(rawCap))) : 0;
  if (capEl) {capEl.value = String(dailyCap);}
  return { scrollLimit, scrollDelay, ocrImages: !!(ocrEl && ocrEl.checked), dailyCap };
}

/** Populate inputs from persisted settings. */
function applySettings(settings) {
  if (!settings) {return;}
  if (settings.scrollLimit) {$('scroll-limit').value = String(settings.scrollLimit);}
  if (settings.scrollDelay) {$('scroll-delay').value = String(settings.scrollDelay);}
  const ocrEl = $('ocr-images');
  if (ocrEl) {ocrEl.checked = !!settings.ocrImages;}
  const capEl = $('daily-cap');
  if (capEl && typeof settings.dailyCap === 'number') {capEl.value = String(settings.dailyCap);}
}

/** Render a status payload into the popup UI. */
function renderStatus(status) {
  if (!status) {return;}

  const badge = $('status-badge');
  badge.dataset.status = status.status || 'IDLE';
  badge.textContent = (status.status || 'IDLE').toLowerCase();

  $('stat-found').textContent = formatNumber(status.postsFound || 0);
  $('stat-processed').textContent = formatNumber(status.postsProcessed || 0);
  $('stat-unique').textContent = formatNumber(status.uniqueRecords || 0);
  $('stat-emails').textContent = formatNumber(status.emailsFound || 0);

  // Progress: scroll steps taken vs configured limit (real scan progress).
  // Falls back to processed/found for older stored states.
  const scrollLimit = Number(status.scrollLimit || 0);
  const scrollCount = Number(status.scrollCount || 0);
  const scanState = status.status || 'IDLE';
  let pct;
  if (scanState === 'COMPLETED') {
    pct = 100;
  } else if (scrollLimit > 0) {
    pct = Math.round((Math.min(scrollCount, scrollLimit) / scrollLimit) * 100);
  } else {
    const denominator = Math.max(1, status.postsFound || status.postsProcessed || 1);
    const numerator = Math.min(denominator, status.postsProcessed || 0);
    pct = Math.round((numerator / denominator) * 100);
  }

  const fill = $('progress-fill');
  fill.style.width = `${pct}%`;

  const label = progressLabel(status.status || 'IDLE', pct);
  $('progress-label').textContent = label;
  $('progress-pct').textContent = `${pct}%`;

  // Last author processed.
  const authorEl = $('last-author');
  const authorName = status.currentAuthor || '';
  if (authorName) {
    authorEl.hidden = false;
    $('last-author-name').textContent = authorName;
  } else {
    authorEl.hidden = true;
  }

  // Error box.
  const errorBox = $('error-box');
  const error = status.error || '';
  if (error) {
    errorBox.textContent = error;
    errorBox.hidden = false;
  } else {
    errorBox.hidden = true;
  }

  updateButtons(status.status || 'IDLE');
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function progressLabel(status, pct) {
  switch (status) {
    case 'RUNNING':
      return 'Extracting…';
    case 'PAUSED':
      return 'Paused';
    case 'STOPPED':
      return 'Stopped by user';
    case 'COMPLETED':
      return 'Extraction complete';
    case 'ERROR':
      return 'Error';
    default:
      return pct > 0 ? 'Ready' : 'Ready';
  }
}

/** Enable/disable controls based on scanner state. */
function updateButtons(status) {
  const running = status === 'RUNNING';
  const paused = status === 'PAUSED';
  const active = running || paused;

  $('btn-start').disabled = active;
  $('btn-pause').disabled = !running;
  $('btn-resume').disabled = !paused;
  $('btn-stop').disabled = !active;

  $('scroll-limit').disabled = active;
  $('scroll-delay').disabled = active;

  $('btn-export-csv').disabled = false;
  $('btn-export-json').disabled = false;
  $('btn-export-html').disabled = false;
}

/** Poll service worker for current status. */
async function pollStatus() {
  const response = await sendToWorker({ type: 'GET_STATUS' });
  if (response.ok || response.status) {
    renderStatus(response);
  }
}

/** Start extraction with current settings. */
async function handleStart() {
  const settings = readSettings();
  const response = await sendToWorker({ type: 'START_EXTRACTION', options: settings });
  if (!response.ok) {
    showError(response.error || 'Could not start extraction.');
    return;
  }
  // Response has no counters - pull a full status instead of rendering it.
  pollStatus();
}

/** Pause / Resume / Stop actions. */
async function handleControl(type) {
  const response = await sendToWorker({ type });
  if (!response.ok) {
    showError(response.error || `Could not ${type.toLowerCase()}.`);
    return;
  }
  pollStatus();
}

/** Clear stored results and reset state. */
async function handleClear() {
  const confirmed = window.confirm(
    'Clear all extracted results and stop any running scan? This cannot be undone.'
  );
  if (!confirmed) {return;}
  const response = await sendToWorker({ type: 'CLEAR_RESULTS' });
  if (!response.ok) {
    showError(response.error || 'Could not clear results.');
    return;
  }
  showSuccess('Results cleared.');
  const next = { ...(await sendToWorker({ type: 'GET_STATUS' })), uniqueRecords: 0, postsFound: 0, postsProcessed: 0, emailsFound: 0, currentAuthor: '', scrollCount: 0, scrollLimit: 0 };
  renderStatus(next);
}

/** Trigger an export through the service worker. */
async function handleExport(type) {
  const hiringOnly = $('export-hiring-only').checked;
  const batchAll = $('export-batch-all').checked;
  const response = await sendToWorker({ type, hiringOnly, batchAll });
  if (!response.ok) {
    showError(response.error || 'Export failed.');
    return;
  }
  if (batchAll && response.files > 0) {
    showSuccess(`Exported ${response.files} file(s) — one per keyword.`);
  } else {
    showSuccess('Export started — check your downloads folder.');
  }
}

/**
 * Transient feedback (export results, validation errors).
 * Kept in its own element so the 800ms status poll cannot wipe it:
 * renderStatus() only ever touches #error-box (stored scan errors).
 */
let noticeTimer = null;
function showNotice(message, kind) {
  const box = $('notice-box');
  box.dataset.kind = kind === 'success' ? 'success' : 'error';
  box.textContent = message;
  box.hidden = false;
  if (noticeTimer) {clearTimeout(noticeTimer);}
  noticeTimer = setTimeout(() => {
    box.hidden = true;
    noticeTimer = null;
  }, kind === 'success' ? 6000 : 12000);
}

function showError(message) {
  showNotice(message, 'error');
}

function showSuccess(message) {
  showNotice(message, 'success');
}

function persistSettings() {
  const settings = readSettings();
  sendToWorker({ type: 'SAVE_SETTINGS', settings });
}

function init() {
  // Version label comes from the manifest so it never drifts.
  try {
    $('app-version').textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    /* manifest unavailable */
  }

  // Restore saved settings from storage.
  (async () => {
    const settings = await sendToWorker({ type: 'GET_SETTINGS' });
    if (settings.ok && settings.settings) {applySettings(settings.settings);}
  })();

  // Keep settings saved when the user edits them (not only on Start).
  $('scroll-limit').addEventListener('change', persistSettings);
  $('scroll-delay').addEventListener('change', persistSettings);
  const ocrEl2 = $('ocr-images');
  if (ocrEl2) {ocrEl2.addEventListener('change', persistSettings);}
  const capEl2 = $('daily-cap');
  if (capEl2) {capEl2.addEventListener('change', persistSettings);}

  // Initial status render, then poll while open.
  pollStatus();
  setInterval(() => {
    pollStatus();
  }, 800);

  $('btn-start').addEventListener('click', handleStart);
  $('btn-pause').addEventListener('click', () => handleControl('PAUSE_EXTRACTION'));
  $('btn-resume').addEventListener('click', () => handleControl('RESUME_EXTRACTION'));
  $('btn-stop').addEventListener('click', () => handleControl('STOP_EXTRACTION'));
  $('btn-clear').addEventListener('click', handleClear);
  $('btn-export-csv').addEventListener('click', () => handleExport('EXPORT_CSV'));
  $('btn-export-json').addEventListener('click', () => handleExport('EXPORT_JSON'));
  $('btn-export-html').addEventListener('click', () => handleExport('EXPORT_HTML'));
}

document.addEventListener('DOMContentLoaded', init);
