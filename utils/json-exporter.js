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

  function buildJson(records) {
    return JSON.stringify(records || [], null, 2);
  }

  function buildJsonFile(records) {
    return buildJson(records);
  }

  NS.JsonExporter = {
    buildJson,
    buildJsonFile
  };
})(globalThis);
