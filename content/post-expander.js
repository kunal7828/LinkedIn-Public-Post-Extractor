/**
 * LLPE - Post Expander
 * -----------------------------------------------
 * Expands truncated post text by clicking the visible
 * "More" / "...more" / "See more" button INSIDE the post.
 *
 * Requirements:
 *  - Check visibility
 *  - Check whether already expanded (button state, NOT container tail)
 *  - Scroll element into view if necessary
 *  - Click safely (no unrelated page-level buttons)
 *  - Wait using MutationObserver + polling
 *  - Catch StaleElementReference-like DOM replacement
 *  - Retry maximum 2 times, never infinite retry
 *  - Idempotent: re-expanding an expanded post is a no-op
 *
 * Namespace:
 *   globalThis.LLPE.PostExpander
 */
(function registerPostExpander(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const { Selectors, Helpers, Logger } = NS;

  const MAX_RETRIES = 2;
  const TEXT_CHANGE_WAIT_MS = 2500;
  const POLL_INTERVAL_MS = 120;

  function isCollapsed(text) {
    return /(?:\.\.\.|…)\s*(?:more)?\s*$/i.test(Helpers.normalizeWhitespace(text));
  }

  /**
   * Score a candidate "more" button. Higher = more likely the real
   * in-post expand toggle. Cheap, deterministic, DOM-only.
   *
   * NOTE: The post container also holds the social action bar
   * ("…Comment · Share"), so its innerText NEVER ends with the text
   * ellipsis. That is why expansion state is decided from the button
   * (text/aria/aria-expanded), never from the container text tail.
   */
  function scoreButton(el) {
    if (!el || !el.isConnected) {return -1;}

    // Never click a link that navigates: the expand toggle is a button,
    // and clicking a permalink anchor would abort the whole scan.
    if (el.tagName === 'A') {
      const href = (el.getAttribute('href') || '').trim();
      if (href && !href.startsWith('#')) {return -1;}
    }

    const text = Helpers.normalizeWhitespace(el.innerText || '');
    const aria = Helpers.normalizeWhitespace(el.getAttribute('aria-label') || '');
    const expanded = el.getAttribute('aria-expanded');

    // Collapse controls are never expand buttons.
    if (Selectors.COLLAPSE_BUTTON_TEXT_PATTERNS.some((re) => re.test(text))) {return -1;}
    if (/see less|show less|view less|less/i.test(aria)) {return -1;}
    // Never expand comments/reaction menus instead of the post body.
    if (/(?:more|load)\s+comments?|show\s+all|open\s+.*menu|control\s+menu/i.test(text + ' ' + aria)) {return -1;}

    let score = 0;
    if (Selectors.MORE_BUTTON_TEXT_PATTERNS.some((re) => re.test(text))) {score += 3;}
    if (Selectors.MORE_BUTTON_ARIA_PATTERNS.some((re) => re.test(aria))) {score += 2;}
    if (expanded === 'true' || expanded === 'false') {score += 3;}
    if (isCollapsed(text)) {score += 1;}
    // Short label (e.g. "…more") = in-post text toggle, not a page-level control.
    if (text.length > 0 && text.length <= 24) {score += 1;}

    return score;
  }

  /** Find the best "more" style button inside the post, excluding page-level controls. */
  function findMoreButton(post) {
    if (!post || !post.isConnected) {return null;}

    const candidates = post.querySelectorAll(Selectors.MORE_BUTTON_SELECTORS.join(','));
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const score = scoreButton(el);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * True if the post has no expandable "more" button left, or the
   * button reports aria-expanded="true". Container-tail ellipsis is
   * intentionally NOT used as evidence (the action bar masks it).
   */
  function isAlreadyExpanded(post) {
    const btn = findMoreButton(post);
    if (!btn) {return true;}
    return btn.getAttribute('aria-expanded') === 'true';
  }

  function isButtonVisible(btn) {
    if (!btn || !btn.isConnected) {return false;}
    const rect = btn.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {return false;}
    const style = global.getComputedStyle ? global.getComputedStyle(btn) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) {return false;}
    return true;
  }

  /** Scroll the element into view, waiting for layout to settle. */
  async function scrollIntoView(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } catch {
      // Some old engines throw on options; fall back to plain scrollIntoView.
      try {
        el.scrollIntoView(true);
      } catch {
        /* ignore */
      }
    }
    await Helpers.sleep(120);
  }

  /**
   * Wait for expansion to take effect. Any of these signals means done:
   *  - the clicked button was removed from the DOM (React replaced it)
   *  - the button now reports aria-expanded="true"
   *  - post text grew by a meaningful amount
   */
  async function waitForTextChange(post, beforeLength, buttonRef) {
    const deadline = Date.now() + TEXT_CHANGE_WAIT_MS;
    let lastLength = beforeLength;

    const observer = new MutationObserver(() => {
      if (post.isConnected) {
        lastLength = Helpers.normalizeWhitespace(post.innerText || '').length;
      }
    });
    try {
      observer.observe(post, { childList: true, subtree: true, characterData: true });
    } catch {
      /* observer not supported */
    }

    while (Date.now() < deadline) {
      await Helpers.sleep(POLL_INTERVAL_MS);
      if (!post.isConnected) {
        // DOM replaced the whole post; treat as "content may have changed".
        observer.disconnect();
        return true;
      }
      if (buttonRef && !buttonRef.isConnected) {
        // React removed the toggle after expanding.
        observer.disconnect();
        return true;
      }
      if (buttonRef && buttonRef.getAttribute('aria-expanded') === 'true') {
        observer.disconnect();
        return true;
      }
      const current = Helpers.normalizeWhitespace(post.innerText || '').length;
      if (current > lastLength + 8 || current > beforeLength + 8) {
        observer.disconnect();
        return true;
      }
    }
    observer.disconnect();
    return false;
  }

  /**
   * Expand a single post element. Idempotent: if the post is already
   * expanded (aria-expanded="true") it returns true without clicking.
   * @returns {Promise<boolean>} true if expanded (or already expanded).
   */
  async function expandPost(postElement) {
    if (!postElement || !postElement.isConnected) {return false;}

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Re-find each attempt: React may have replaced the previous button.
      const moreBtn = findMoreButton(postElement);
      if (!moreBtn) {
        Logger.debug('[PostExpander] no more button found in post');
        return false;
      }

      if (moreBtn.getAttribute('aria-expanded') === 'true') {
        Logger.debug('[PostExpander] already expanded');
        return true;
      }

      if (!isButtonVisible(moreBtn)) {
        Logger.debug('[PostExpander] more button not visible, skipping');
        return false;
      }

      const beforeLength = Helpers.normalizeWhitespace(postElement.innerText || '').length;

      try {
        await scrollIntoView(moreBtn);
        moreBtn.click();
        const changed = await waitForTextChange(postElement, beforeLength, moreBtn);
        if (changed) {
          Logger.debug('[PostExpander] expanded successfully');
          return true;
        }
        Logger.debug(`[PostExpander] text did not change after click (attempt ${attempt + 1})`);
      } catch (error) {
        Logger.warn('[PostExpander] click failed, retrying:', error?.message || error);
      }

      // Small backoff before next attempt (covers stale elements / re-renders).
      await Helpers.sleep(200 * (attempt + 1));
    }

    Logger.debug('[PostExpander] expansion failed after max retries');
    return false;
  }

  NS.PostExpander = {
    expandPost,
    findMoreButton,
    isAlreadyExpanded,
    isCollapsed
  };
})(globalThis);
