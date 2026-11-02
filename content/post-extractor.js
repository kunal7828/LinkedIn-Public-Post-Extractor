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
 * Namespace:
 *   globalThis.LLPE.PostExtractor
 */
(function registerPostExtractor(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const { Selectors, Helpers, EmailExtractor, Logger } = NS;

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

  /** Find the author profile URL (prefer /in/ or /pub/). */
  function findAuthorProfileUrl(post) {
    const links = post.querySelectorAll('a[href]');
    let best = '';
    let bestScore = 0;
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (Selectors.PROFILE_EXCLUDE_PATTERNS.some((re) => re.test(href))) {continue;}
      if (!Selectors.PROFILE_HREF_PATTERNS.some((re) => re.test(href))) {continue;}
      const score = /\/in\//i.test(href) ? 3 : /\/pub\//i.test(href) ? 2 : 1;
      if (score > bestScore) {
        best = href;
        bestScore = score;
      }
    }
    return Helpers.canonicalUrl(best);
  }

  /** Find the post permalink URL. */
  function findPostUrl(post) {
    const links = post.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (Selectors.POST_HREF_PATTERNS.some((re) => re.test(href))) {
        return Helpers.canonicalUrl(href);
      }
    }
    return '';
  }

  /** Author display name (from profile link text or first heading). */
  function findAuthorName(post) {
    const profileLink = [...post.querySelectorAll('a[href]')].find((a) => {
      const href = a.getAttribute('href') || '';
      return /linkedin\.com\/(in|pub)\//i.test(href);
    });
    if (profileLink) {
      const name = Helpers.normalizeWhitespace(profileLink.innerText || '');
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

  /** Author headline: text near the profile link, minus the name. */
  function findAuthorHeadline(post) {
    const profileLink = [...post.querySelectorAll('a[href]')].find((a) => {
      const href = a.getAttribute('href') || '';
      return /linkedin\.com\/(in|pub)\//i.test(href);
    });
    if (!profileLink) {return '';}

    // Walk up to the profile header block (usually 2-3 levels above the link).
    let block = profileLink;
    for (let i = 0; i < 3 && block.parentElement; i++) {block = block.parentElement;}
    const text = Helpers.normalizeWhitespace(block.innerText || '');
    const name = findAuthorName(post);
    const headline = text.replace(name, '').replace(/\s+/g, ' ').trim();
    // Trim leading punctuation left over after removing the name.
    return headline.replace(/^[·|•,\-–—:\s]+/, '').slice(0, 300);
  }

  /** Posted time: prefer <time datetime>, else aria-label / text. */
  function findPostedTime(post) {
    for (const selector of Selectors.TIME_SELECTORS) {
      const el = post.querySelector(selector);
      if (!el) {continue;}
      const datetime = el.getAttribute('datetime');
      if (datetime) {return datetime;}
      const label = Helpers.normalizeWhitespace(el.getAttribute('aria-label') || '');
      if (label && /ago|posted/i.test(label)) {return label;}
      const text = Helpers.normalizeWhitespace(el.innerText || '');
      if (text) {return text;}
    }
    return '';
  }

  /** Post text: clone, strip controls, normalize preserving line breaks. */
  function findPostText(post) {
    const clone = post.cloneNode(true);
    const excludes = Selectors.TEXT_EXCLUDE_SELECTORS.join(',');
    clone.querySelectorAll(excludes).forEach((el) => el.remove());
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

      const emails = EmailExtractor.extractEmails(postText);
      const sourcePageUrl = Helpers.canonicalUrl(global.location?.href || '');
      const authorHeadline = findAuthorHeadline(postElement);

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
    findAuthorProfileUrl,
    findPostUrl,
    findAuthorName,
    findAuthorHeadline,
    findPostText,
    findPostedTime
  };
})(globalThis);
