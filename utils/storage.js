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
 * Namespace:
 *   globalThis.LLPE.Storage
 */
(function registerStorage(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});

  const RESULTS_KEY = 'llpe_results_v30';
  const STATE_KEY = 'llpe_state_v30';
  const SETTINGS_KEY = 'llpe_settings_v30';

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
    processedIds: []
  };

  function hasChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  async function getResults() {
    if (!hasChromeStorage()) {return [];}
    const data = await chrome.storage.local.get({ [RESULTS_KEY]: [] });
    return Array.isArray(data[RESULTS_KEY]) ? data[RESULTS_KEY] : [];
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
    const { Deduplicator } = NS;
    const dedupeKey = Deduplicator ? Deduplicator.buildDedupeKey(record) : null;
    const duplicate = dedupeKey
      ? results.some((r) => Deduplicator.buildDedupeKey(r) === dedupeKey)
      : results.some((r) => r.postId === record.postId);
    if (duplicate) {return { added: false, results };}
    results.push(record);
    await chrome.storage.local.set({ [RESULTS_KEY]: results });
    return { added: true, results };
  }

  async function clearAll() {
    if (!hasChromeStorage()) {return;}
    await chrome.storage.local.remove([RESULTS_KEY, STATE_KEY]);
  }

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
    clearAll
  };
})(globalThis);
