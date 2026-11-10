/**
 * LLPE - Post Detector
 * -----------------------------------------------
 * Robust detection of post containers on LinkedIn
 * search-results pages. Uses a layered strategy from
 * selectors.js — never a single fragile generated class.
 *
 * Strategy:
 *   1. Query candidate containers by semantic/aria/data-* selectors.
 *   2. For each candidate, verify it looks like a post
 *      (has an author link, social actions, or a permalink).
 *   3. Structural fallback: if nothing found, walk up from
 *      author profile links / social action controls.
 *   4. Merge results by stable container key, keeping the
 *      innermost/most-specific container for each post.
 *
 * Namespace:
 *   globalThis.LLPE.PostDetector
 */
(function registerPostDetector(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const { Selectors, Helpers, Logger } = NS;

  const PROFILE_RE = /linkedin\.com\/(in|pub|company|school)\//i;
  const EXCLUDE_RE = /\/search\/results\//i;

  /** True if the element (or an ancestor) looks like a LinkedIn post card. */
  function looksLikePost(el) {
    if (!el || !el.isConnected) {return false;}

    // Must contain some visible text (avoid empty shells).
    const text = Helpers.normalizeWhitespace(el.innerText || '');
    if (text.length < 20) {return false;}

    // Author profile link (strongest signal).
    const profile = findProfileLink(el);
    if (profile) {return true;}

    // Post permalink.
    if (findPostLink(el)) {return true;}

    // Social action controls.
    if (el.querySelector(Selectors.SOCIAL_ACTION_SELECTORS.join(','))) {return true;}

    return false;
  }

  /** Find an author profile link inside the element. */
  function findProfileLink(el) {
    const links = el.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (EXCLUDE_RE.test(href)) {continue;}
      if (PROFILE_RE.test(href)) {return a;}
    }
    return null;
  }

  /** Find a post permalink inside the element. */
  function findPostLink(el) {
    const links = el.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (Selectors.POST_HREF_PATTERNS.some((re) => re.test(href))) {return a;}
    }
    return null;
  }

  /**
   * Structural fallback: from a profile link, walk up until we
   * find a container that also holds social action controls.
   */
  function containerFromProfileLink(a) {
    let node = a;
    for (let depth = 0; node && depth < 8; depth++) {
      const parent = node.parentElement;
      if (!parent) {break;}
      const hasSocial = parent.querySelector(Selectors.SOCIAL_ACTION_SELECTORS.join(','));
      const hasTime = parent.querySelector(Selectors.TIME_SELECTORS.join(','));
      if (hasSocial || (hasTime && parent.innerText && parent.innerText.trim().length > 60)) {
        return parent;
      }
      node = parent;
    }
    return null;
  }

  /**
   * Structural fallback: from a social action control, walk up
   * until we find a container with a profile link or permalink.
   */
  function containerFromSocialControl(el) {
    let node = el;
    for (let depth = 0; node && depth < 8; depth++) {
      const parent = node.parentElement;
      if (!parent) {break;}
      if (findProfileLink(parent) || findPostLink(parent)) {return parent;}
      node = parent;
    }
    return null;
  }

  /** Stable key for a container (used to merge duplicates). */
  function containerKey(el) {
    const urn = el.getAttribute && el.getAttribute('data-urn');
    if (urn) {return `urn:${urn}`;}
    const postLink = findPostLink(el);
    if (postLink) {return `post:${Helpers.normalizeUrlForCompare(postLink.href)}`;}
    const profile = findProfileLink(el);
    const text = Helpers.normalizeWhitespace(el.innerText || '').slice(0, 300);
    return `container:${Helpers.normalizeUrlForCompare(profile ? profile.href : '')}|${text}`;
  }

  /**
   * Discover all distinct post containers currently in the DOM.
   * Returns an array of elements (one per post), preferring the
   * innermost container for each detected key.
   */
  function discoverPosts(root = document) {
    const found = [];
    const seen = new Set();

    // Layer 1: candidate selectors.
    for (const selector of Selectors.POST_CONTAINER_SELECTORS) {
      let nodes;
      try {
        nodes = root.querySelectorAll(selector);
      } catch {
        Logger.debug('[PostDetector] invalid selector skipped:', selector);
        continue;
      }
      for (const el of nodes) {
        if (!looksLikePost(el)) {continue;}
        const key = containerKey(el);
        if (!key || seen.has(key)) {continue;}
        seen.add(key);
        found.push(el);
      }
    }

    // Layer 2: structural fallback from profile links not already covered.
    // Runs on purpose even when Layer 1 found posts: cards without a
    // semantic container (article) are only reachable this way.
    const profileLinks = root.querySelectorAll('a[href*="/in/"], a[href*="/pub/"]');
    for (const a of profileLinks) {
      if (a.closest && a.closest('article')) {continue;} // already covered by article layer
      const container = containerFromProfileLink(a);
      if (container && looksLikePost(container)) {
        const key = containerKey(container);
        if (key && !seen.has(key)) {
          seen.add(key);
          found.push(container);
        }
      }
    }

    // Layer 3: structural fallback from social action controls.
    const socialControls = root.querySelectorAll(Selectors.SOCIAL_ACTION_SELECTORS.join(','));
    for (const ctrl of socialControls) {
      if (ctrl.closest && ctrl.closest('article')) {continue;}
      const container = containerFromSocialControl(ctrl);
      if (container && looksLikePost(container)) {
        const key = containerKey(container);
        if (key && !seen.has(key)) {
          seen.add(key);
          found.push(container);
        }
      }
    }

    Logger.debug(`[PostDetector] discovered ${found.length} post containers`);
    return found;
  }

  /** Re-locate a container by its stable key after DOM churn. */
  function findContainerByKey(key, root = document) {
    if (!key) {return null;}
    for (const el of discoverPosts(root)) {
      if (containerKey(el) === key) {return el;}
    }
    return null;
  }

  NS.PostDetector = {
    discoverPosts,
    findContainerByKey,
    containerKey,
    looksLikePost,
    findProfileLink,
    findPostLink
  };
})(globalThis);
