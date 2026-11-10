/**
 * LLPE - Email Extractor
 * -----------------------------------------------
 * Extracts ONLY emails that are explicitly visible in
 * the rendered post text.
 *
 * Rules:
 *  - Reasonable email regex, case-insensitive.
 *  - Normalize to lowercase.
 *  - Remove duplicates.
 *  - Exclude obvious false positives.
 *  - Never infer emails from name/company/LinkedIn username.
 *  - Never query external services.
 *
 * Namespace:
 *   globalThis.LLPE.EmailExtractor
 */
(function registerEmailExtractor(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const { Logger } = NS;

  // Matches typical public email addresses.
  // Note: TLD length 2+ covers common cases (com, co.in, io, ...).
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  // TLDs that indicate non-email identifiers (linkedin.com, www, ...).
  // Only remove domains that can never be a real mailbox; legitimate
  // providers (gmail.com etc.) must NOT be filtered out.
  const KNOWN_NON_EMAIL_DOMAINS = [
    'linkedin.com',
    'linkedin.cn',
    'www',
    'wix.com',
    'wordpress.com',
    'blogspot.com',
    'example.com'
  ];

  // Regex fragments used to reject things like "contact@ | john@ linkedin"
  const LOCAL_PART_BLACKLIST = [
    /^(https?|www|ftp|mailto|tel):?/i,
    /[()[\]]/,
    /[{}|\\^`]/,
    /^\.|\.$/,
    /\.{2,}/,
    /^[-_]/,
    /[-_]$/
  ];

  function isValidEmail(email) {
    if (!email || typeof email !== 'string') {return false;}
    const e = email.trim().toLowerCase();
    if (e.length < 6 || e.length > 254) {return false;}

    // Reject if the domain is a known non-email identifier.
    const domain = e.split('@')[1] || '';
    if (KNOWN_NON_EMAIL_DOMAINS.includes(domain.toLowerCase())) {return false;}

    // Reject if local part looks like a URL/token.
    const local = e.split('@')[0] || '';
    if (LOCAL_PART_BLACKLIST.some((re) => re.test(local))) {return false;}

    // Must contain exactly one @, and the domain must have a dot after it.
    if ((e.match(/@/g) || []).length !== 1) {return false;}
    const domainParts = domain.split('.');
    if (domainParts.length < 2 || !domainParts[1]) {return false;}

    return true;
  }

  /**
   * Extract visible emails from text.
   * Returns a de-duplicated, lowercased array.
   */
  function extractEmails(text) {
    if (!text) {return [];}
    const found = text.match(EMAIL_RE) || [];
    const cleaned = found
      .map((e) => e.trim().toLowerCase().replace(/^\.+|\.+$/g, ''))
      .filter(isValidEmail);
    return [...new Set(cleaned)];
  }

  NS.EmailExtractor = {
    extractEmails,
    isValidEmail
  };
})(globalThis);
