/**
 * LLPE - JSON Exporter
 * -----------------------------------------------
 * Serializes extraction records to a pretty-printed
 * JSON array. Runs in the service worker.
 *
 * Namespace:
 *   globalThis.LLPE.JsonExporter
 */
(function registerJsonExporter(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});

  /**
   * Normalize records before serializing so legacy data (saved before
   * v3.0.4) always carries the same shape as new records: `isHiring`
   * is re-classified on the fly and `emails` is backfilled from `email`.
   */
  function normalizeRecord(record) {
    const r = record && typeof record === 'object' ? record : {};
    const helpers = NS.Helpers;
    const email = typeof r.email === 'string' && r.email ? r.email : '';
    const emails = Array.isArray(r.emails) && r.emails.length
      ? r.emails
      : (email ? [email] : []);
    return {
      ...r,
      emails,
      isHiring: helpers ? helpers.recordIsHiring(r) : (typeof r.isHiring === 'boolean' ? r.isHiring : false)
    };
  }

  function buildJson(records) {
    return JSON.stringify((records || []).map(normalizeRecord), null, 2);
  }

  function buildJsonFile(records) {
    return buildJson(records);
  }

  NS.JsonExporter = {
    buildJson,
    buildJsonFile,
    normalizeRecord
  };
})(globalThis);
