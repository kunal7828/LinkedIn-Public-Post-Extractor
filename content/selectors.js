/**
 * LLPE - Selectors
 * -----------------------------------------------
 * SINGLE SOURCE OF TRUTH for all LinkedIn DOM selectors.
 *
 * LinkedIn frequently changes generated CSS class names.
 * This module deliberately avoids depending on one fragile
 * generated class. Instead it uses a layered strategy:
 *
 *   1. Semantic elements          -> article, time
 *   2. ARIA roles/attributes      -> [role="article"], aria-label, aria-describedby
 *   3. data-* attributes          -> [data-urn], [data-activity-urn], [data-id]
 *   4. Stable href patterns       -> /in/, /feed/update/urn:li:activity:*
 *   5. Structural relationships   -> walking up from author profile links / social controls
 *   6. Fallback selectors         -> previously seen stable containers (kept as last resort)
 *
 * If LinkedIn changes the DOM, update THIS FILE ONLY —
 * the rest of the extension keeps working.
 *
 * Namespace:
 *   globalThis.LLPE.Selectors
 */
(function registerSelectors(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});

  /** Post container candidate selectors (priority order matters). */
  const POST_CONTAINER_SELECTORS = [
    // Semantic: an <article> inside the search-results feed is the strongest signal.
    'article',

    // data-* attributes LinkedIn exposes on update wrappers.
    '[data-urn*="ugcPost"]',
    '[data-urn*="activity"]',
    '[data-activity-urn]',
    '[data-post-urn]',

    // ARIA: role="article" is a stable accessibility contract.
    '[role="article"]',

    // Previously observed stable containers (fallback layer only).
    '.feed-shared-update-v2',
    '.occludable-update',
    '.search-content__result-card'
  ];

  /** Author profile link href patterns (stable LinkedIn routes). */
  const PROFILE_HREF_PATTERNS = [
    /linkedin\.com\/in\//i,
    /linkedin\.com\/pub\//i,   // public profile pages
    /linkedin\.com\/company\//i, // company pages also carry public names
    /linkedin\.com\/school\//i
  ];

  /** Post permalink href patterns (stable LinkedIn routes, priority order). */
  const POST_HREF_PATTERNS = [
    /linkedin\.com\/feed\/update\/urn:li:activity:\d+/i,
    /linkedin\.com\/posts\/[\w-]+-activity-\d+/i,
    /linkedin\.com\/pulse\//i,
    /activity-\d+/i
  ];

  /**
   * Patterns that must NOT be treated as an author profile.
   * NOTE: company/school/pub routes are intentionally NOT excluded here —
   * they are valid author links (see PROFILE_HREF_PATTERNS above).
   */
  const PROFILE_EXCLUDE_PATTERNS = [
    /\/search\/results\//i,
    /\/feed\//i,
    /\/jobs\//i,
    /\/in\/feed\//i
  ];

  /**
   * The actor header block (author name + headline + time), in priority
   * order. Used to scope name/headline/time extraction, to prefer the
   * actor's own profile link, and to strip chrome from fallback text.
   */
  const POST_HEADER_SELECTORS = [
    '[class*="update-components-actor"]',
    '[class*="feed-shared-actor"]',
    '[data-testid*="actor"]',
    '[class*="search-result-actor"]',
    'header'
  ];

  /**
   * The actual post body / commentary, in priority order. Preferred over
   * taking text from the whole card so author header, reaction counts and
   * action chrome never end up in `postText`.
   */
  const BODY_TEXT_SELECTORS = [
    '[data-testid="main-feed-activity-card__commentary"]',
    '[data-testid*="commentary"]',
    '[class*="update-components-text"]',
    '[class*="feed-shared-update-v2__commentary"]',
    '.feed-shared-text'
  ];

  /** Buttons that expand a truncated post (visible "see more"). */
  const MORE_BUTTON_SELECTORS = [
    'button',
    '[role="button"]',
    'a[role="button"]',
    'button[aria-expanded]',
    'span[aria-hidden="true"]'
  ];

  /** Exact/loose text + aria-label matches for "see more" style controls. */
  const MORE_BUTTON_TEXT_PATTERNS = [
    /^(see more|show more|view more|more)$/i,
    /^(see more|show more|view more|more)\.{3}$/i,
    /\.{3}\s*(see more|show more|view more|more)$/i,
    /^(see more|show more|view more|more)…$/i,
    /…\s*(see more|show more|view more|more)$/i,
    /^…\s*more$/i,
    /^\u2026\s*more$/i,
    /^\s*\.\.\.\s*more\s*$/i
  ];

  /** aria-label variations on the more button. */
  const MORE_BUTTON_ARIA_PATTERNS = [
    /see more/i,
    /show more/i,
    /view more/i,
    /expand/i,
    /more/i
  ];

  /** Buttons that COLLAPSE text (must be treated as already expanded). */
  const COLLAPSE_BUTTON_TEXT_PATTERNS = [
    /see less/i,
    /show less/i,
    /view less/i,
    /less\.{3}$/i,
    /less…$/i
  ];

  /** Time-related elements for "posted X ago". */
  const TIME_SELECTORS = [
    'time',
    '[datetime]',
    'span[aria-label*="ago"]',
    'span[aria-label*="posted"]'
  ];

  /** Social action controls used to structurally identify a post container. */
  const SOCIAL_ACTION_SELECTORS = [
    '[data-control-name="comment"]',
    '[data-control-name="share"]',
    '[data-control-name="react"]',
    'button[aria-label*="react"]',
    'button[aria-label*="comment"]',
    'button[aria-label*="share"]'
  ];

  /** Regex to pull a stable activity id out of post URLs/URNs. */
  const ACTIVITY_ID_PATTERN = /urn:li:activity:(\d+)/i;
  const DATA_URN_ACTIVITY_PATTERN = /activity:(\d+)/i;
  const POST_URL_ACTIVITY_PATTERN = /activity-(\d+)/i;

  /** Elements whose text should be excluded from post text (chrome/controls). */
  const TEXT_EXCLUDE_SELECTORS = [
    'button',
    '[role="button"]',
    'input',
    'textarea',
    'select',
    'svg',
    'time',
    '[datetime]',
    'footer',
    '[data-control-name="social-actions"]',
    '.feed-shared-social-action-bar',
    '[data-test-id="social-actions"]',
    // actor header (name, headline, degree, time) + social counters
    '[class*="update-components-actor"]',
    '[class*="feed-shared-actor"]',
    '[class*="update-components-meta"]',
    '[class*="social-counts"]',
    '[data-testid*="reactions"]'
  ];

  NS.Selectors = {
    POST_CONTAINER_SELECTORS,
    PROFILE_HREF_PATTERNS,
    POST_HREF_PATTERNS,
    PROFILE_EXCLUDE_PATTERNS,
    POST_HEADER_SELECTORS,
    BODY_TEXT_SELECTORS,
    MORE_BUTTON_SELECTORS,
    MORE_BUTTON_TEXT_PATTERNS,
    MORE_BUTTON_ARIA_PATTERNS,
    COLLAPSE_BUTTON_TEXT_PATTERNS,
    TIME_SELECTORS,
    SOCIAL_ACTION_SELECTORS,
    ACTIVITY_ID_PATTERN,
    DATA_URN_ACTIVITY_PATTERN,
    POST_URL_ACTIVITY_PATTERN,
    TEXT_EXCLUDE_SELECTORS
  };
})(globalThis);
