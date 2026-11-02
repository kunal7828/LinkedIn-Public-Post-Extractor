/**
 * LLPE - Deduplicator
 * -----------------------------------------------
 * Stable deduplication for extracted posts.
 *
 * Priority for the dedupe key:
 *   1. postUrl
 *   2. postId
 *   3. normalized (authorProfileUrl + postText) hash
 *
 * Never uses array index as an ID. The same post must
 * never appear twice in export.
 *
 * Namespace:
 *   globalThis.LLPE.Deduplicator
 */
(function registerDeduplicator(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const { Helpers, Logger } = NS;

  /**
   * Deterministic 32-bit FNV-1a hash -> hex string.
   * Used instead of crypto.subtle because it is sync,
   * deterministic and works in every content script.
   */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /**
   * Build the canonical dedupe key for a record.
   * Priority: postUrl > postId > content fingerprint.
   */
  function buildDedupeKey(record) {
    const url = Helpers.normalizeUrlForCompare(record.postUrl);
    if (url) {return `url:${url}`;}

    const id = String(record.postId || '').trim();
    if (id && !/^fallback:/i.test(id)) {return `id:${id.toLowerCase()}`;}

    const profile = Helpers.normalizeUrlForCompare(record.authorProfileUrl) || '';
    const text = Helpers.normalizeWhitespace(record.postText).slice(0, 500);
    const contentKey = Helpers.stableKey([profile, text]);
    return `content:${contentKey}:${fnv1a(contentKey)}`;
  }

  /** Create a Deduplicator instance backed by an in-memory Set. */
  function create(initialKeys) {
    const seen = new Set(Array.isArray(initialKeys) ? initialKeys : []);

    return {
      has(record) {
        const key = buildDedupeKey(record);
        if (!key) {return false;}
        return seen.has(key);
      },
      add(record) {
        const key = buildDedupeKey(record);
        if (!key) {return false;}
        seen.add(key);
        return true;
      },
      /**
       * Returns true if the record is NEW (not seen).
       * Adds it to the set if new.
       */
      isNewAndAdd(record) {
        if (this.has(record)) {return false;}
        this.add(record);
        return true;
      },
      get size() {
        return seen.size;
      },
      keys() {
        return [...seen];
      }
    };
  }

  NS.Deduplicator = {
    buildDedupeKey,
    create
  };
})(globalThis);
