/**
 * LLPE - Storage
 * -----------------------------------------------
 * Thin wrapper around chrome.storage.local with
 * incremental persistence for extraction results and
 * scanner state. Shared by content script and service
 * worker (importScripts-friendly, no ES modules).
 *
 * Keys:
 *   llpe_results_v30  -> array of extracted post records
 *   llpe_state_v30    -> scanner status object
 *   llpe_settings_v30 -> user settings (scroll limit/delay)
 *
 * Performance:
 *   Results are cached in memory and flushed with debounced
 *   batched writes (max ~1s stale) instead of re-reading and
 *   re-writing the whole array for every single record.
 *   Callers also flush explicitly at checkpoints (end of every
 *   scroll round, stop/pause/complete/error), so at most one
 *   round of records can be lost if the tab dies mid-write.
 *
 * Cross-context consistency:
 *   chrome.storage.onChanged invalidates this cache when another
 *   context (service worker / another tab) writes or clears the
 *   results, except while we hold unsaved records of our own.
 *
 * Namespace:
 *   globalThis.LLPE.Storage
 */
(function registerStorage(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});

  const RESULTS_KEY = 'llpe_results_v30';
  const STATE_KEY = 'llpe_state_v30';
  const SETTINGS_KEY = 'llpe_settings_v30';
  const FLUSH_DELAY_MS = 1000;

  const DEFAULT_SETTINGS = {
    scrollLimit: 100,
    scrollDelay: 2000
  };

  const DEFAULT_STATE = {
    status: 'IDLE', // IDLE|RUNNING|PAUSED|STOPPED|COMPLETED|ERROR
    postsFound: 0,
    postsProcessed: 0,
    uniqueRecords: 0,
    emailsFound: 0,
    currentAuthor: '',
    searchUrl: '',
    startedAt: '',
    completedAt: '',
    error: '',
    processedIds: [],
    scanTabId: null,   // tab id that owns the active scan (single-scan lock)
    scrollCount: 0,    // scroll steps taken in the current scan
    scrollLimit: 0     // configured max scroll steps for the current scan
  };

  function hasChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function logError(...args) {
    if (NS.Logger) {NS.Logger.error(...args);} else {console.error(...args);}
  }

  /* ------------------------------------------------------------------
   * Results cache (single source of truth once loaded)
   * ------------------------------------------------------------------ */
  const cache = { loaded: false, records: [], dirty: false };
  let flushTimer = null;

  async function loadResultsFromDisk() {
    const data = await chrome.storage.local.get({ [RESULTS_KEY]: [] });
    cache.records = Array.isArray(data[RESULTS_KEY]) ? data[RESULTS_KEY] : [];
    cache.loaded = true;
    cache.dirty = false;
    return cache.records;
  }

  /** Debounced write of pending records. */
  function scheduleFlush(delay = FLUSH_DELAY_MS) {
    if (!hasChromeStorage()) {return;}
    if (flushTimer) {clearTimeout(flushTimer);}
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushResults().catch((error) => logError('[Storage] flush failed:', error?.message || error));
    }, Math.max(0, Number(delay) || 0));
  }

  /** Force-write pending records now. Safe to call at any checkpoint. */
  async function flushResults() {
    if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
    if (!hasChromeStorage() || !cache.loaded || !cache.dirty) {return false;}
    // Clear first so a storage change event from our own write is
    // not mistaken for "another context wrote this".
    cache.dirty = false;
    try {
      await chrome.storage.local.set({ [RESULTS_KEY]: cache.records });
      return true;
    } catch (error) {
      cache.dirty = true; // retry on the next flush
      logError('[Storage] results write failed:', error?.message || error);
      return false;
    }
  }

  /** Adopt results written/cleared by another context. */
  function watchExternalChanges() {
    if (!hasChromeStorage() || !chrome.storage.onChanged || global.__llpeStorageWatched) {return;}
    global.__llpeStorageWatched = true;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[RESULTS_KEY]) {return;}
      if (cache.dirty) {return;} // our unsaved records win; next flush overwrites
      const next = changes[RESULTS_KEY].newValue;
      cache.records = Array.isArray(next) ? next : [];
      cache.loaded = true;
    });
  }

  async function getResults() {
    if (!hasChromeStorage()) {return [];}
    if (cache.loaded) {return cache.records;}
    return loadResultsFromDisk();
  }

  async function getState() {
    if (!hasChromeStorage()) {return { ...DEFAULT_STATE };}
    const data = await chrome.storage.local.get({ [STATE_KEY]: DEFAULT_STATE });
    return { ...DEFAULT_STATE, ...(data[STATE_KEY] || {}) };
  }

  async function getSettings() {
    if (!hasChromeStorage()) {return { ...DEFAULT_SETTINGS };}
    const data = await chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
  }

  async function saveState(patch) {
    if (!hasChromeStorage()) {return;}
    const current = await getState();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ [STATE_KEY]: next });
    return next;
  }

  async function saveSettings(patch) {
    if (!hasChromeStorage()) {return;}
    const current = await getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  /** Append a record if it passes dedupe; returns { added, results } */
  async function appendResult(record) {
    if (!hasChromeStorage()) {return { added: false, results: [] };}
    const results = await getResults();
    const deduper = NS.Deduplicator;
    const dedupeKey = deduper ? deduper.buildDedupeKey(record) : null;
    const duplicate = dedupeKey
      ? results.some((r) => deduper.buildDedupeKey(r) === dedupeKey)
      : results.some((r) => r.postId === record.postId);
    if (duplicate) {return { added: false, results };}
    results.push(record); // mutates the cached array
    cache.dirty = true;
    scheduleFlush();
    return { added: true, results };
  }

  async function clearAll() {
    if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
    cache.records = [];
    cache.loaded = true;
    cache.dirty = false;
    if (!hasChromeStorage()) {return;}
    await chrome.storage.local.remove([RESULTS_KEY, STATE_KEY]);
  }

  watchExternalChanges();

  NS.Storage = {
    RESULTS_KEY,
    STATE_KEY,
    SETTINGS_KEY,
    DEFAULT_SETTINGS,
    DEFAULT_STATE,
    getResults,
    getState,
    getSettings,
    saveState,
    saveSettings,
    appendResult,
    flushResults,
    clearAll
  };
})(globalThis);
