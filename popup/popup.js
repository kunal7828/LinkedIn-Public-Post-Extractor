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

  return { scrollLimit, scrollDelay };
}

/** Populate inputs from persisted settings. */
function applySettings(settings) {
  if (!settings) {return;}
  if (settings.scrollLimit) {$('scroll-limit').value = String(settings.scrollLimit);}
  if (settings.scrollDelay) {$('scroll-delay').value = String(settings.scrollDelay);}
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

  // Progress: unique records vs. posts found (or processed vs limit).
  const denominator = Math.max(1, status.postsFound || status.postsProcessed || 1);
  const numerator = Math.min(denominator, status.postsProcessed || 0);
  const pct = Math.round((numerator / denominator) * 100);

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
  renderStatus(response);
  pollStatus();
}

/** Pause / Resume / Stop actions. */
async function handleControl(type) {
  const response = await sendToWorker({ type });
  if (!response.ok) {
    showError(response.error || `Could not ${type.toLowerCase()}.`);
    return;
  }
  renderStatus(response);
  pollStatus();
}

/** Clear stored results and reset state. */
async function handleClear() {
  if (!window.confirm('Clear all extracted results? This cannot be undone.')) {return;}
  const response = await sendToWorker({ type: 'CLEAR_RESULTS' });
  if (!response.ok) {
    showError(response.error || 'Could not clear results.');
    return;
  }
  const next = { ...(await sendToWorker({ type: 'GET_STATUS' })), uniqueRecords: 0, postsFound: 0, postsProcessed: 0, emailsFound: 0, currentAuthor: '' };
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
  }
}

function showError(message) {
  const errorBox = $('error-box');
  errorBox.dataset.kind = 'error';
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function showSuccess(message) {
  const errorBox = $('error-box');
  errorBox.dataset.kind = 'success';
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function init() {
  // Restore saved settings from storage.
  (async () => {
    const settings = await sendToWorker({ type: 'GET_SETTINGS' });
    if (settings.ok && settings.settings) {applySettings(settings.settings);}
  })();

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
