/**
 * LLPE - Logger
 * -----------------------------------------------
 * Lightweight, namespaced logger used across content
 * script and service worker.
 *
 * Namespace:
 *   globalThis.LLPE.Logger
 *
 * All modules register into globalThis.LLPE so that:
 *   - content scripts (classic scripts, isolated world) share it
 *   - the service worker can importScripts() the same files
 * No ES module syntax is used here on purpose so both
 * environments can consume the exact same file.
 */
(function registerLogger(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});

  const DEBUG = false; // flip to true (or set LLPE_DEBUG=true) for verbose logs

  const LEVELS = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40
  };

  function shouldLog(level) {
    return DEBUG || (typeof global.LLPE_DEBUG !== 'undefined' && global.LLPE_DEBUG);
  }

  function format(args) {
    return args.map((a) => {
      if (a instanceof Error) {return `${a.name}: ${a.message}`;}
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    });
  }

  const Logger = {
    debug: (...args) => {
      if (shouldLog(LEVELS.DEBUG)) {console.debug('[LLPE]', ...format(args));}
    },
    info: (...args) => {
      if (shouldLog(LEVELS.INFO)) {console.info('[LLPE]', ...format(args));}
    },
    warn: (...args) => {
      if (shouldLog(LEVELS.WARN)) {console.warn('[LLPE]', ...format(args));}
    },
    error: (...args) => {
      if (shouldLog(LEVELS.ERROR)) {console.error('[LLPE]', ...format(args));}
    }
  };

  NS.Logger = Logger;
})(globalThis);
