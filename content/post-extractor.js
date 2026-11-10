/**
 * LLPE - Post Extractor
 * -----------------------------------------------
 * Extracts publicly visible data from a single post
 * container and builds the normalized record object.
 *
 * Record shape:
 * {
 *   postId, postUrl, authorName, authorProfileUrl,
 *   authorHeadline, postText, email, emails,
 *   postedTime, searchKeyword, sourcePageUrl, extractedAt,
 *   isHiring
 * }
 *
 * Strategy:
 *  - The actor header block is found first and used to scope
 *    name / headline / time extraction so post chrome never
 *    leaks into those fields.
 *  - `postText` prefers the commentary/body container and only
 *    falls back to the whole card (minus chrome) when no body
 *    container is found.
 *  - `postUrl` matches href patterns in priority order instead
 *    of whichever link happens to appear first in the DOM.
 *
 * Namespace:
 *   globalThis.LLPE.PostExtractor
 */
(function registerPostExtractor(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const { Selectors, Helpers, EmailExtractor, Logger } = NS;

  /** Find the actor header block (name/headline/time) if present. */
  function findPostHeader(post) {
    for (const selector of Selectors.POST_HEADER_SELECTORS) {
      try {
        const el = post.querySelector(selector);
        if (el) {return el;}
      } catch {
        /* invalid selector - skip */
      }
    }
    return null;
  }

  /** True if the href is an author-profile route (not excluded). */
  function isProfileHref(href) {
    if (!href) {return false;}
    if (Selectors.PROFILE_EXCLUDE_PATTERNS.some((re) => re.test(href))) {return false;}
    return Selectors.PROFILE_HREF_PATTERNS.some((re) => re.test(href));
  }

  /** Preference score for author link types (only used within one pool). */
  function profileScore(href) {
    if (/\/in\//i.test(href)) {return 3;}
    if (/\/pub\//i.test(href)) {return 2;}
    return 1; // company / school
  }

  /** Derive a stable post ID (never array index). */
  function derivePostId(post, postUrl) {
    if (postUrl) {
      const m = postUrl.match(Selectors.ACTIVITY_ID_PATTERN) ||
                postUrl.match(Selectors.POST_URL_ACTIVITY_PATTERN);
      if (m && m[1]) {return `urn:li:activity:${m[1]}`;}
      return `url:${Helpers.normalizeUrlForCompare(postUrl)}`;
    }

    // data-urn attribute fallback.
    const urn = post.getAttribute('data-urn') || post.getAttribute('data-activity-urn') || '';
    const urnMatch = String(urn).match(Selectors.DATA_URN_ACTIVITY_PATTERN);
    if (urnMatch && urnMatch[1]) {return `urn:li:activity:${urnMatch[1]}`;}

    // Stable fallback from profile + text fingerprint.
    const profile = findAuthorProfileUrl(post);
    const text = Helpers.normalizeWhitespace(post.innerText || '').slice(0, 200);
    return `fallback:${Helpers.stableKey([profile, text])}`;
  }

  /** Find the author profile URL. Prefers the link inside the actor header. */
  function findAuthorProfileUrl(post) {
    const links = [...post.querySelectorAll('a[href]')].filter((a) =>
      isProfileHref(a.getAttribute('href') || '')
    );
    if (links.length === 0) {return '';}

    // Inside the actor header there is normally exactly one profile link
    // (the post's own author), which is far more reliable than any link
    // anywhere in the card (mentions, comments, shared content).
    const header = findPostHeader(post);
    const inHeader = header ? links.filter((a) => header.contains(a)) : [];
    const pool = inHeader.length ? inHeader : links;

    let best = pool[0];
    let bestScore = profileScore(best.getAttribute('href') || '');
    for (const a of pool) {
      const score = profileScore(a.getAttribute('href') || '');
      if (score > bestScore) {best = a; bestScore = score;}
    }
    return Helpers.canonicalUrl(best.getAttribute('href'));
  }

  /** Find the post permalink URL (patterns in priority order). */
  function findPostUrl(post) {
    const hrefs = [...post.querySelectorAll('a[href]')].map(
      (a) => a.getAttribute('href') || ''
    );
    for (const pattern of Selectors.POST_HREF_PATTERNS) {
      const hit = hrefs.find((href) => pattern.test(href));
      if (hit) {return Helpers.canonicalUrl(hit);}
    }
    return '';
  }

  /** First profile link inside the actor header, else anywhere, else a heading. */
  function findAuthorName(post) {
    const isProfileAnchor = (a) => isProfileHref(a.getAttribute('href') || '');

    const header = findPostHeader(post);
    const headerLink = header ? [...header.querySelectorAll('a[href]')].find(isProfileAnchor) : null;
    if (headerLink) {
      const name = Helpers.normalizeWhitespace(headerLink.innerText || '');
      if (name) {return name.slice(0, 200);}
    }

    const anyLink = [...post.querySelectorAll('a[href]')].find(isProfileAnchor);
    if (anyLink) {
      const name = Helpers.normalizeWhitespace(anyLink.innerText || '');
      if (name) {return name.slice(0, 200);}
    }

    // Fallback: first heading.
    const heading = post.querySelector('h1, h2, h3, h4, [role="heading"]');
    if (heading) {
      const name = Helpers.normalizeWhitespace(heading.innerText || '').split('\n')[0];
      if (name) {return name.slice(0, 200);}
    }
    return '';
  }

  /** True for lines that are timestamp chrome, not headline text. */
  function isTimeLikeLine(line) {
    return /^(?:\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago|\d{1,2}:\d{2}(?:\s*[ap]m)?|\d{1,2}\s*[ap]m)$/i.test(line);
  }

  /** True for control/summary text that must never become a headline. */
  function isChromeLine(line) {
    return /^(?:follow|see\s+more|show\s+more|view\s+more|more|comment|share|like|repost|\.{3}|…|\||•|-|–|—)$/i.test(line);
  }

  /** Remove connection-degree markers ("• 2nd", trailing "#3") from a headline. */
  function cleanHeadlineLine(line) {
    return line
      .replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ')
      .replace(/[·|•]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Author headline: the first non-name, non-time line of the actor header. */
  function findAuthorHeadline(post) {
    const header = findPostHeader(post);
    const name = findAuthorName(post);

    if (header && header.innerText) {
      const lines = String(header.innerText)
        .split('\n')
        .map((l) => Helpers.normalizeWhitespace(l))
        .filter(Boolean);
      for (const line of lines) {
        if (line === name) {continue;}
        if (isTimeLikeLine(line) || isChromeLine(line)) {continue;}
        const cleaned = cleanHeadlineLine(line);
        if (!cleaned || cleaned === name) {continue;}
        return cleaned.slice(0, 300);
      }
    }

    // Fallback: text near the profile link, minus the name.
    const targetHref = findAuthorProfileUrl(post);
    const profileLink = targetHref
      ? [...post.querySelectorAll('a[href]')].find(
        (a) => Helpers.canonicalUrl(a.getAttribute('href') || '') === targetHref
      )
      : null;
    if (!profileLink) {return '';}

    let block = profileLink;
    for (let i = 0; i < 3 && block.parentElement; i++) {block = block.parentElement;}
    const text = Helpers.normalizeWhitespace(block.innerText || '');
    const headline = text.replace(name, '').replace(/\s+/g, ' ').trim();
    return cleanHeadlineLine(headline).replace(/^[·|•,\-–—:\s]+/, '').slice(0, 300);
  }

  /** Posted time: header first, then the whole card. Prefer <time datetime>. */
  function findPostedTime(post) {
    const header = findPostHeader(post);
    const roots = header ? [header, post] : [post];
    for (const root of roots) {
      for (const selector of Selectors.TIME_SELECTORS) {
        const el = root.querySelector(selector);
        if (!el) {continue;}
        const datetime = el.getAttribute('datetime');
        if (datetime) {return datetime;}
        const label = Helpers.normalizeWhitespace(el.getAttribute('aria-label') || '');
        if (label && /ago|posted/i.test(label)) {return label;}
        const text = Helpers.normalizeWhitespace(el.innerText || '');
        if (text) {return text;}
      }
    }
    return '';
  }

  /** Body container for the post text, or null when none is recognised. */
  function findBodyContainer(post) {
    for (const selector of Selectors.BODY_TEXT_SELECTORS) {
      let nodes;
      try {
        nodes = post.querySelectorAll(selector);
      } catch {
        Logger.debug('[PostExtractor] invalid selector skipped:', selector);
        continue;
      }
      for (const el of nodes) {
        const text = Helpers.normalizeText(el.innerText || '');
        if (text.trim().length >= 8) {return el;}
      }
    }
    return null;
  }

  /**
   * Post text: prefer the commentary container; otherwise clone the card
   * and strip controls/chrome, normalizing while preserving line breaks.
   */
  function findPostText(post) {
    const body = findBodyContainer(post);
    const source = body || post;
    const clone = source.cloneNode(true);
    const excludes = Selectors.TEXT_EXCLUDE_SELECTORS.join(',');
    try {
      clone.querySelectorAll(excludes).forEach((el) => el.remove());
    } catch {
      /* invalid selector - keep the text as-is */
    }
    return Helpers.truncate(Helpers.normalizeText(clone.innerText || ''), 10000);
  }

  /**
   * Extract full record from a post container.
   * @returns {Promise<object|null>} null if nothing usable.
   */
  async function extractPost(postElement, context = {}) {
    try {
      if (!postElement || !postElement.isConnected) {return null;}

      const postUrl = findPostUrl(postElement);
      const postId = derivePostId(postElement, postUrl);
      const postText = findPostText(postElement);
      if (!postText && !postUrl) {
        Logger.debug('[PostExtractor] no usable content, skipping');
        return null;
      }

      const authorHeadline = findAuthorHeadline(postElement);
      // Emails can appear in the author headline / about line as well as
      // the post body, so scan both (visible text only).
      const emails = EmailExtractor.extractEmails(`${postText}\n${authorHeadline}`);
      const sourcePageUrl = Helpers.canonicalUrl(global.location?.href || '');

      return {
        postId,
        postUrl,
        authorName: findAuthorName(postElement),
        authorProfileUrl: findAuthorProfileUrl(postElement),
        authorHeadline,
        postText,
        email: emails[0] || '',
        emails,
        postedTime: findPostedTime(postElement),
        searchKeyword: Helpers.searchKeywordFromUrl(sourcePageUrl) || context.searchKeyword || '',
        sourcePageUrl,
        extractedAt: new Date().toISOString(),
        isHiring: Helpers.recordIsHiring({ postText, authorHeadline })
      };
    } catch (error) {
      Logger.error('[PostExtractor] post extraction failed:', error?.message || error);
      return null;
    }
  }

  NS.PostExtractor = {
    extractPost,
    derivePostId,
    findPostHeader,
    findAuthorProfileUrl,
    findPostUrl,
    findAuthorName,
    findAuthorHeadline,
    findPostText,
    findPostedTime
  };
})(globalThis);
