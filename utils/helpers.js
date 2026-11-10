/**
 * LLPE - Helpers
 * -----------------------------------------------
 * Shared, environment-safe utilities (DOM, strings,
 * URLs, CSV escaping). Consumed by content script and
 * service worker.
 *
 * Namespace:
 *   globalThis.LLPE.Helpers
 */
(function registerHelpers(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});

  /** Resolve a possibly-relative URL against the current page or a base. */
  function canonicalUrl(value, base) {
    if (!value) {return '';}
    try {
      const resolved = new URL(String(value), base || global.location?.href || undefined);
      resolved.hash = '';
      return resolved.toString();
    } catch {
      return '';
    }
  }

  /** Deterministic string key (used as stable dedupe fallback). */
  function stableKey(parts) {
    return parts
      .map((p) => String(p ?? '').trim().toLowerCase())
      .join('|');
  }

  /** Collapse all whitespace (incl. Unicode + NBSP) to single spaces. */
  function normalizeWhitespace(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u2000-\u200b\u202f\u205f\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Preserve meaningful line breaks but collapse runs of blank lines. */
  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u2000-\u200b\u202f\u205f\u3000]/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  /** Truncate long strings for safety while keeping usable data. */
  function truncate(value, max = 10000) {
    const s = String(value ?? '');
    return s.length > max ? s.slice(0, max) : s;
  }

  /**
   * RFC-4180-ish CSV escaping (doubles quotes, wraps in quotes).
   * Cells that a spreadsheet could evaluate as a formula are prefixed
   * with an apostrophe first (CSV formula-injection guard), because
   * quoting alone does not stop Excel/Sheets from running them.
   */
  function csvEscape(value) {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) {s = "'" + s;}
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /**
   * HTML escape for report generation.
   * NOTE: every constant must be an *entity*, not the raw character -
   * substituting '<' for '<' is a no-op and would allow record content
   * to inject markup into the exported report.
   */
  function escapeHtml(value) {
    const AMP = '&amp;';
    const LT = '&lt;';
    const GT = '&gt;';
    const QUOT = '&quot;';
    const APOS = '&#39;';
    return String(value ?? '').replace(/[&<>"']/g, (c) => {
      if (c === '&') {return AMP;}
      if (c === '<') {return LT;}
      if (c === '>') {return GT;}
      if (c === '"') {return QUOT;}
      return APOS;
    });
  }

  /** Extract the `keywords` query param from a LinkedIn search URL. */
  function searchKeywordFromUrl(url) {
    try {
      const parsed = new URL(url || '');
      return parsed.searchParams.get('keywords') || '';
    } catch {
      return '';
    }
  }

  /** Sanitize a filename (strip path separators + control chars). */
  function safeFilename(name, fallback) {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
    return cleaned || fallback || 'linkedin-public-posts';
  }

  /** Basic visibility check (works in content scripts). */
  function isElementVisible(el) {
    if (!el || !el.isConnected) {return false;}
    const style = global.getComputedStyle ? global.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {return false;}
    return true;
  }

  /** Explicit async delay. Never use blocking sleep loops. */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  /** Normalize URL for comparison (strip hash, query, trailing slash). */
  function normalizeUrlForCompare(value) {
    try {
      const u = new URL(String(value));
      u.hash = '';
      u.search = '';
      const path = u.pathname.replace(/\/+$/, '');
      return (u.origin + path).toLowerCase();
    } catch {
      return String(value ?? '').toLowerCase();
    }
  }

  /** Keyword patterns that signal a recruiting / job-posting post. */
  const HIRING_PATTERNS = [
    /\bhiring\b/i,
    /\bwe'?re\s+looking\s+for\b/i,
    /\bwe\s+are\s+looking\s+for\b/i,
    /\bjoin\s+(?:our\s+)?team\b/i,
    /\bapply\s+(?:now|here|today)\b/i,
    /\bpositions?\s+(?:are\s+)?(?:available|open)\b/i,
    /\bjobs?\s+(?:are\s+)?(?:available|open)\b/i,
    /\bopen\s+(?:job\s+)?(?:positions?|roles?)\b/i,
    /\bwe'?re\s+recruiting\b/i,
    /\bwe\s+are\s+recruiting\b/i,
    /\bvacanc\w+\b/i,
    /\bcareer\s+opportunit\w+\b/i,
    /\b(?:send|share)\s+(?:us\s+)?your\s+resume\b/i,
    /\bhiring\s+managers?\b/i
  ];

  /**
   * Phrases that cancel a hiring signal. They are stripped BEFORE the
   * pattern test so sentences like "We are not hiring" or a
   * "hiring freeze" are not misclassified as hiring posts.
   */
  const HIRING_NEGATIONS = [
    // "not hiring", "we aren't currently hiring", "not currently hiring"
    /\b(?:not|never|isn'?t|aren'?t|wasn'?t|weren'?t|won'?t|no\s+longer|stopped|ceased|halted|paused|suspended|without)\s+(?:currently\s+|actively\s+)?hiring\b/gi,
    // "hiring freeze", "hiring frozen", "hiring paused", "hiring on hold"
    /\bhiring\s+(?:freeze(?:s|d)?|frozen|paused?|is\s+(?:on\s+(?:hold|ice)|paused|frozen))/gi,
    // "no open positions", "without available roles"
    /\b(?:no|without|zero)\s+(?:open|current|available|active|new)?\s*(?:positions?|roles?|jobs?|vacanc\w+)\b/gi
  ];

  /** Heuristic: does the text look like a hiring / job-posting post? */
  function detectHiring(text) {
    let haystack = normalizeWhitespace(text);
    if (!haystack) {return false;}
    for (const negation of HIRING_NEGATIONS) {
      negation.lastIndex = 0;
      haystack = haystack.replace(negation, ' ');
    }
    return HIRING_PATTERNS.some((re) => re.test(haystack));
  }

  /** Hiring flag for a record; falls back to content detection for legacy records. */
  function recordIsHiring(record) {
    if (typeof record?.isHiring === 'boolean') {return record.isHiring;}
    return detectHiring(`${record?.postText || ''} ${record?.authorHeadline || ''}`);
  }

  /** Group records by their stored search keyword (empty -> 'unknown'). */
  function groupRecordsByKeyword(records) {
    const groups = new Map();
    (records || []).forEach((record) => {
      const keyword = String(record?.searchKeyword || '').trim() || 'unknown';
      if (!groups.has(keyword)) {groups.set(keyword, []);}
      groups.get(keyword).push(record);
    });
    return groups;
  }

  NS.Helpers = {
    canonicalUrl,
    stableKey,
    normalizeWhitespace,
    normalizeText,
    truncate,
    csvEscape,
    escapeHtml,
    searchKeywordFromUrl,
    safeFilename,
    isElementVisible,
    sleep,
    normalizeUrlForCompare,
    HIRING_PATTERNS,
    HIRING_NEGATIONS,
    detectHiring,
    recordIsHiring,
    groupRecordsByKeyword
  };
})(globalThis);
