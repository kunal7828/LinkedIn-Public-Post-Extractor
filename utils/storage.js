/**
 * LLPE - Storage
 * -----------------------------------------------
 * Results are stored in IndexedDB (object store `results`) for
 * scalable, append-only persistence. Scanner state and settings
 * remain in chrome.storage.local (small, frequently patched).
 *
 * Cross-context consistency:
 *   Each context keeps an in-memory cache. A version counter in
 *   chrome.storage.local (`llpe_results_version_v30`) is bumped on
 *   every append/clear so other contexts (service worker, other tabs)
 *   re-read from IndexedDB instead of serving stale data.
 *
 * One-time migration:
 *   Records previously saved to chrome.storage.local
 *   (`llpe_results_v30`) are imported into IndexedDB on first load.
 *
 * Namespace:
 *   globalThis.LLPE.Storage
 */
(function registerStorage(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});

  const DB_NAME = 'llpe';
  const DB_VERSION = 1;
  const STORE = 'results';
  const RESULTS_KEY_LEGACY = 'llpe_results_v30';
  const STATE_KEY = 'llpe_state_v30';
  const SETTINGS_KEY = 'llpe_settings_v30';
  const VERSION_KEY = 'llpe_results_version_v30';

  const DEFAULT_SETTINGS = {
    scrollLimit: 100,
    scrollDelay: 2000,
    ocrImages: false,
    dailyCap: 0
  };

  const DEFAULT_STATE = {
    status: 'IDLE',
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
    scanTabId: null,
    scrollCount: 0,
    scrollLimit: 0,
    inFlightRecord: null,
    dailyScanDate: '',
    dailyScanCount: 0
  };

  function hasChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function hasIndexedDB() {
    return typeof indexedDB !== 'undefined';
  }

  function logError(...args) {
    if (NS.Logger) {NS.Logger.error(...args);} else {console.error(...args);}
  }

  /* ------------------------------------------------------------------ */
  /* IndexedDB helpers                                                   */
  /* ------------------------------------------------------------------ */
  function openDB() {
    return new Promise((resolve, reject) => {
      if (!hasIndexedDB()) {reject(new Error('IndexedDB unavailable')); return;}
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('postId', 'postId', { unique: false });
          store.createIndex('postUrl', 'postUrl', { unique: false });
          store.createIndex('searchKeyword', 'searchKeyword', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGetAll() {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbAdd(record) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbClear() {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Results cache + version sync                                        */
  /* ------------------------------------------------------------------ */
  const cache = { loaded: false, records: [], version: 0 };

  async function getStoredVersion() {
    if (!hasChromeStorage()) {return cache.version;}
    const data = await chrome.storage.local.get({ [VERSION_KEY]: 0 });
    return Number(data[VERSION_KEY]) || 0;
  }

  async function bumpVersion() {
    const next = (await getStoredVersion()) + 1;
    cache.version = next;
    if (hasChromeStorage()) {
      await chrome.storage.local.set({ [VERSION_KEY]: next });
    }
  }

  async function migrateLegacy() {
    if (!hasChromeStorage()) {return;}
    const data = await chrome.storage.local.get({ [RESULTS_KEY_LEGACY]: [] });
    const legacy = Array.isArray(data[RESULTS_KEY_LEGACY]) ? data[RESULTS_KEY_LEGACY] : [];
    if (legacy.length === 0) {return;}
    const existing = await idbGetAll();
    if (existing.length > 0) {return;} // already migrated
    for (const record of legacy) {
      try {await idbAdd(record);} catch (error) {logError('[Storage] migration add failed:', error?.message || error);}
    }
    // drop legacy key after successful migration
    try {await chrome.storage.local.remove(RESULTS_KEY_LEGACY);} catch { /* ignore */ }
  }

  async function getResults() {
    const storedVer = await getStoredVersion();
    if (cache.loaded && cache.version === storedVer) {
      return cache.records;
    }
    // migrate legacy data on first read
    try {
      const existing = await idbGetAll();
      if (existing.length === 0) {await migrateLegacy();}
    } catch (error) {
      logError('[Storage] idb read/migrate failed:', error?.message || error);
    }
    const records = await idbGetAll().catch(() => []);
    cache.records = Array.isArray(records) ? records : [];
    cache.loaded = true;
    cache.version = storedVer;
    return cache.records;
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

  async function appendResult(record) {
    const results = await getResults();
    const deduper = NS.Deduplicator;
    const dedupeKey = deduper ? deduper.buildDedupeKey(record) : null;
    const duplicate = dedupeKey
      ? results.some((r) => deduper.buildDedupeKey(r) === dedupeKey)
      : results.some((r) => r.postId === record.postId);
    if (duplicate) {return { added: false, results };}

    try {
      await idbAdd(record);
    } catch (error) {
      logError('[Storage] idb add failed:', error?.message || error);
      return { added: false, results };
    }
    results.push(record);
    cache.records = results;
    await bumpVersion();
    return { added: true, results };
  }

  async function flushResults() {
    // IndexedDB writes are durable on append; nothing to flush.
    // Kept for API compatibility with content script / service worker.
    return true;
  }

  function scheduleFlush() {
    // no-op: appends are durable
  }

  async function clearAll() {
    try {await idbClear();} catch (error) {logError('[Storage] idb clear failed:', error?.message || error);}
    cache.records = [];
    cache.loaded = true;
    cache.version = 0;
    if (hasChromeStorage()) {
      await chrome.storage.local.set({ [VERSION_KEY]: 0 });
      await chrome.storage.local.remove([STATE_KEY, RESULTS_KEY_LEGACY]);
    }
  }

  function watchExternalChanges() {
    if (!hasChromeStorage() || global.__llpeStorageWatched) {return;}
    global.__llpeStorageWatched = true;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[VERSION_KEY]) {return;}
      // invalidate cache so next getResults re-reads from IndexedDB
      cache.loaded = false;
    });
  }

  watchExternalChanges();

  NS.Storage = {
    RESULTS_KEY: RESULTS_KEY_LEGACY,
    STATE_KEY,
    SETTINGS_KEY,
    VERSION_KEY,
    DEFAULT_SETTINGS,
    DEFAULT_STATE,
    getResults,
    getState,
    getSettings,
    saveState,
    saveSettings,
    appendResult,
    flushResults,
    scheduleFlush,
    clearAll
  };
})(globalThis);
