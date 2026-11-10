# LinkedIn Public Post Extractor 3.0.7

A production-grade Chrome Extension (Manifest V3) that extracts **publicly visible** post data from LinkedIn search-result pages (`https://www.linkedin.com/search/results/content/?keywords=...`).

It does **not** bypass logins, touch private data, call hidden APIs, or perform any LinkedIn actions (likes, comments, messages, connection requests).

> ⚠️ **Terms of Service / personal-data risk** — automated scrolling and bulk collection of public posts (which often contain personal data such as names, headlines and email addresses) may violate LinkedIn's User Agreement and can be restricted by local data-protection law (e.g. GDPR). Use it only on data you are authorized to process, keep volumes low, and review LinkedIn's terms before running scans. You are responsible for how the extracted data is used.

---

## Compliance & Privacy Guardrails

- **Visible data only** — every field is read from the rendered DOM (text, links, aria/`data-*` attributes). Nothing is read from network payloads, GraphQL, or DevTools APIs.
- **No LinkedIn actions** — the extension never posts, comments, likes, follows, or messages anyone. It only scrolls the page (like a human) and clicks **"See more"** to expand truncated post text.
- **No login bypass** — works only on pages you can already see while logged into your own account.
- **Emails only from visible text** — the email extractor scans the rendered post text/author areas. It never queries third-party enrichment services.
- **Respects page behavior** — configurable scroll delay (min 500 ms) and scroll limit (max 1000). No rate-limit or CAPTCHA circumvention.
- **User-controlled** — Start / Pause / Resume / Stop with live counters. Results are stored locally only (`chrome.storage.local`); nothing is uploaded anywhere.

---

## Features

| Area | Detail |
|---|---|
| Search scope | LinkedIn **search-results/content** pages only |
| Record fields | `postId`, `postUrl`, `authorName`, `authorProfileUrl`, `authorHeadline`, `postText`, `email`, `emails[]`, `postedTime`, `searchKeyword`, `sourcePageUrl`, `extractedAt`, `isHiring` |
| Hiring detection | `isHiring` is set at extraction time from post text + author headline; legacy stored records are re-classified automatically at export time (see "Hiring detection" below) |
| Post discovery | Multi-layered DOM strategy (semantic/ARIA/`data-*` selectors → structural fallback), never one fragile generated class |
| Text expansion | `expandPost()` — visibility check, scroll-into-view, safe click on "See more", MutationObserver + polling wait, stale-element re-location, max 2 retries |
| Scroll engine | Controlled async loop with rAF, configurable delay, bottom detection + verification wait, auto-stop when no new posts appear |
| Deduplication | Priority: `postUrl` → `postId` → `hash(authorProfileUrl + normalizedPostText)`; a post can never be exported twice |
| Persistence | Results are stored in **IndexedDB** (append-only, scalable, crash-safe) with cross-context version sync; scanner state/settings stay in `chrome.storage.local`; legacy `chrome.storage.local` results are migrated automatically; interrupted scans auto-resume after a page reload |
| Scan lock | A single scan runs at a time: the owning tab is recorded in `state.scanTabId`, control commands are routed to that tab, and starting elsewhere hands the scan off cleanly |
| Scope | Content scripts are only injected on `https://www.linkedin.com/search/results/*` (declared in the manifest and re-checked at runtime) |
| Exports | CSV (13 exact columns, UTF-8 BOM for Excel), JSON array, printable HTML report |
| Messaging | Popup → Service Worker → Content Script with typed messages and structured `{ ok, ... }` envelopes |
| UX | Status badge, 4 live counters, progress bar, last-author indicator, error box, state-aware buttons |

---

## Install (Developer Mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Open LinkedIn in the same browser profile and log in.
5. Navigate to a search-results page, e.g.:
   `https://www.linkedin.com/search/results/content/?keywords=software%20engineer`
6. Click the extension icon → set scroll limit/delay → **Start**.

> After editing any source file, reload the extension at `chrome://extensions` and reload the LinkedIn tab.

---

## Workflow

1. **Start** — popup sends `START_EXTRACTION` (with `scrollLimit`/`scrollDelay`) to the service worker, which forwards it to the content script. The scan loop begins immediately.
2. **Scan loop** (content script):
   - Discover visible posts → skip already-processed (in-memory `Set` + stored `processedIds`)
   - Scroll post into view → expand "See more" → re-locate stale element → extract full record
   - Dedupe (URL → ID → content hash) → save incrementally to `chrome.storage.local`
   - Scroll down one viewport step → wait configured delay → bottom detection with verification wait → repeat
   - Auto-stops after 3 idle rounds at the bottom, when the scroll limit is reached, or on Stop
3. **Pause / Resume / Stop** — control commands are routed to the content script; state is persisted to storage.
4. **Export** — `EXPORT_CSV` / `EXPORT_JSON` / `EXPORT_HTML` are handled entirely in the service worker from stored results via `chrome.downloads` (no content script needed). A single-file export is **scoped to the current search keyword**; the "All keywords" batch mode exports one file per stored keyword.
5. **Clear** — stops/resets any running scan first, then wipes results and state; counters reset.

### Status machine

```
IDLE ──START──▶ RUNNING ──PAUSE──▶ PAUSED
                  │  ▲               │
                  │  └──RESUME───────┘
                  ├──STOP──▶ STOPPED
                  ├──(limit/bottom)──▶ COMPLETED
                  └──(fatal)──▶ ERROR
```

---

## Architecture

```
linkedin-public-post-extractor/
├── manifest.json                     # MV3 manifest (v3.0.7)
├── background/
│   └── service-worker.js             # Router: popup commands → content script; exports; status from storage
├── content/
│   ├── content-script.js             # Entry point; message handler; tab-id handshake; auto-resume after reload
│   ├── scroll-manager.js             # Async scroll loop, single-scan lock, pause/resume/stop, bottom detection
│   ├── post-detector.js              # Layered post discovery + container-key merging
│   ├── post-expander.js              # expandPost() with MutationObserver wait + retries
│   ├── post-extractor.js             # 13-field record extraction from a post element
│   ├── email-extractor.js            # Visible-text email extraction + validation
│   ├── deduplicator.js               # FNV-1a hash + dedupe keys (URL → ID → content fingerprint)
│   └── selectors.js                  # ALL selector configuration (single source of truth)
├── popup/
│   ├── popup.html                    # UI markup (version read from manifest)
│   ├── popup.css                     # UI styles
│   └── popup.js                      # Popup → Service Worker messaging + 800 ms status polling
├── tests/
│   └── run.js                        # Unit tests for the pure modules (no Chrome APIs needed)
└── utils/
    ├── logger.js                     # Namespaced console logger with DEBUG flag
    ├── helpers.js                    # canonicalUrl, normalization, escaping, hiring detection, etc.
    ├── storage.js                    # chrome.storage.local wrapper + in-memory cache + batched flush
    ├── csv-exporter.js               # CSV with BOM, RFC-4180 escaping, formula-injection guard
    ├── json-exporter.js              # Pretty-printed JSON array (legacy records normalized)
    └── html-exporter.js              # Printable HTML report (XSS-escaped record content)
```

### Code-sharing pattern

All modules attach to a single namespace `globalThis.LLPE` using classic IIFEs (no ES modules). This lets the **same files** run in:

- the **content script** (loaded via the `content_scripts[].js` array in dependency order), and
- the **service worker** (loaded via `importScripts` in `background/service-worker.js`).

No file sets `"type": "module"`; `background/service-worker.js` loads its dependencies with `importScripts`, and the content scripts are loaded in dependency order via `content_scripts[].js`.

### Messaging protocol

| Message (popup → SW → content) | Handled where | Notes |
|---|---|---|
| `CONTENT_HELLO` | service worker | returns `{ ok, tabId }` so the content script learns its own tab id (`sender.tab.id`) for scan ownership |
| `START_EXTRACTION` | content script (via SW) | SW enforces scope + takes the single-scan lock (stopping any previous owner), persists settings, forwards with `tabId` |
| `PAUSE_EXTRACTION` / `RESUME_EXTRACTION` / `STOP_EXTRACTION` | content script (via SW) | routed to the **scan-owner tab** (falling back to the active LinkedIn tab); returns `ok:false` when no scan is active |
| `GET_STATUS` | content script (falls back to storage-only in SW) | returns counters only: `{ ok, status, postsFound, postsProcessed, uniqueRecords, emailsFound, currentAuthor, error, scrollCount, scrollLimit }` — never `results` |
| `GET_RESULTS` | service worker (storage only) | full records array |
| `GET_SETTINGS` / `SAVE_SETTINGS` | service worker (storage only) | restores/persists scroll limit/delay in the popup |
| `CLEAR_RESULTS` | content script + service worker | SW first tells the owner tab to stop/reset, then wipes results + state |
| `EXPORT_CSV` / `EXPORT_JSON` / `EXPORT_HTML` | service worker (storage + downloads) | works even without a LinkedIn tab; single exports are keyword-scoped, `batchAll` exports one file per keyword |

The popup polls `GET_STATUS` every 800 ms while open, so counters and button states stay live.

---

## Selector Strategy (configurable in `content/selectors.js`)

LinkedIn renames generated CSS classes frequently, so the extractor **never depends on a single class**. Each concern uses layered candidates in priority order:

| Concern | Strategy |
|---|---|
| Post containers | Semantic elements (`article`, `[role="article"]`), `data-urn*="ugcPost|activity"`, `data-activity-urn`, `data-post-urn`, then structural fallback classes (`.feed-shared-update-v2`, `.occludable-update`, `.search-content__result-card`) |
| Author profile | Anchor `href` patterns `/in/`, `/pub/`, `/company/`, `/school/` with a scoring preference for `/in/`; search/feed/jobs links excluded. The link is taken from the **actor header** first so mentions/comments never win |
| Post body | Commentary containers (`[data-testid*="commentary"]`, `[class*="update-components-text"]`, …) preferred over the whole card; author header, reaction counts and action chrome are stripped out |
| Post URL | `href` patterns for `/feed/update/urn:li:activity:`, `/posts/...-activity-`, `/pulse/`, `/activity-` matched **in priority order** (not by DOM order) |
| "See more" | Multiple button selectors **and** text patterns (`/see more|show more|view more/`), aria labels, and a **never-collapse** guard on "See less"; navigation anchors and comment/menu buttons are never clicked |
| Posted time | `time[datetime]`, `span[aria-label*="ago"]`, `span[data-testid*="time"]`, relative-time text |
| Social controls | `button[aria-label*="like"]`, `[aria-label*="comment"]`, `[aria-label*="repost"]` (used only as structural anchors to locate post cards) |
| Email extraction | Rendered visible text only; regex + validation that rejects known non-email domains (e.g. `linkedin.com`, `example.com`) and malformed addresses. Legitimate providers such as `gmail.com` are **kept** |

### When LinkedIn changes its markup

1. Open the LinkedIn page → right-click a post → **Inspect**.
2. Identify the container that wraps one full post (text + author + actions).
3. Open `content/selectors.js` and add a robust candidate to the matching array (prefer `data-*`/aria/semantic selectors; add structural classes only as fallback).
4. Reload the extension and the page, then re-run.

> Because the strategy is layered, a single class rename degrades gracefully to the next candidate instead of breaking extraction.

---

## Export Formats

Single-file exports contain only the records of the **current search keyword** (the keyword also names the file), so multi-keyword runs never mix. Check **"All keywords (one file each)"** to export every stored keyword as its own file instead. Records with no keyword (legacy data) are always included, since they cannot be attributed elsewhere.

### CSV (`<keyword>-public-posts.csv`)

UTF-8 with BOM, `\r\n` line endings, RFC-4180 escaping. Exact columns:

```
Post ID, Post URL, Author Name, Author Profile URL, Author Headline, Hiring Post, Post Text,
Email, All Emails, Posted Time, Search Keyword, Source Page URL, Extracted At
```

> **Formula-injection guard:** cells beginning with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` before quoting, so text copied out of a post cannot execute as a spreadsheet formula when the CSV is opened in Excel/Google Sheets.

### JSON (`<keyword>-public-posts.json`)

Pretty-printed array of record objects:

```json
[
  {
    "postId": "urn:li:activity:7123456789012345678",
    "postUrl": "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/",
    "authorName": "Jane Doe",
    "authorProfileUrl": "https://www.linkedin.com/in/jane-doe/",
    "authorHeadline": "Staff Engineer at Example Corp",
    "postText": "Excited to share that we shipped the new platform...",
    "email": "jane.doe@example.com",
    "emails": ["jane.doe@example.com"],
    "postedTime": "2 days ago",
    "searchKeyword": "software engineer",
    "sourcePageUrl": "https://www.linkedin.com/search/results/content/?keywords=software%20engineer",
    "extractedAt": "2026-09-08T17:00:00.000Z",
    "isHiring": false
  }
]
```

### HTML report (`<keyword>-public-posts-report.html`)

Print-friendly page with a summary header (Total Posts, Unique Posts, Emails Found, Hiring Posts), extraction metadata, and one card per post (author, headline, posted time, post text, public email, profile/post links). Hiring posts show a blue **HIRING** badge and the page has **All / Hiring / Non-Hiring** filter buttons with live counts. Empty-state message when there are no results.

### Hiring detection

Each post is classified as **hiring** or **non-hiring** by `Helpers.detectHiring()` — a keyword-pattern heuristic run over the expanded post text plus the author's headline (`hiring`, `we're looking for`, `join our team`, `apply now`, `positions open`, `vacancy`, `career opportunity`, etc.; the full pattern list lives in `HIRING_PATTERNS` in `utils/helpers.js`). Negated phrases (`HIRING_NEGATIONS` in the same file) are stripped first, so "We are **not hiring**" or a "**hiring freeze**" is not misclassified.

- The result is stored on each record as `isHiring` (true/false) at extraction time.
- Records saved by older versions have no `isHiring` field; exporters re-classify them on the fly with the same heuristic, so the filter works on already-stored data too.
- CSV: each row has a `Hiring Post` column (`Yes`/`No`). HTML report: hiring posts get a blue **HIRING** badge, a **Hiring Posts** counter in the summary header, and All / Hiring / Non-Hiring filter buttons with live counts.
- **Export filter (v3.0.5+):** the popup's Export card has a **"Hiring posts only"** checkbox. When checked, CSV / JSON / HTML export includes **only** hiring posts (each record re-classified through the same heuristic, so it also covers legacy data). If no hiring posts exist, the export is cancelled with a "No hiring posts found to export" error in the popup.
- **Batch export (v3.0.6+):** the popup's Export card has an **"All keywords (one file each)"** checkbox. When checked, CSV / JSON / HTML export produces **one file per stored search keyword** — every saved result set is exported in a single click. Records are grouped by their `searchKeyword` field (records without a keyword go to an `unknown` group). Batch downloads skip the Save-As dialog and save directly to your Downloads folder (filename conflicts are auto-uniquified), so multiple files download silently. The popup confirms with "Exported N file(s) — one per keyword." Works together with the "Hiring posts only" filter.

---

## Debugging

- **Logger** — `utils/logger.js` exposes `globalThis.LLPE.Logger` with a `DEBUG` flag. Open the page's DevTools console (right-click → Inspect) to see content-script logs; the service worker logs appear in `chrome://extensions` → **service worker** (Inspect views).
- **"Content script unavailable"** — the LinkedIn tab was opened before the extension loaded, or needs a reload. Reload the LinkedIn tab.
- **"Open a LinkedIn search-results page first"** — the active tab is not a `linkedin.com` page, or the active tab changed while the popup was open.
- **Nothing extracted** — check the console for `[PostDetector]`/`[PostExtractor]` debug lines; likely a selector needs updating in `content/selectors.js` (see guide above).
- **Status shows `ERROR`** — read the error text in the popup error box and the service-worker console.
- **After code edits** — always reload the extension (`chrome://extensions` → reload) **and** the LinkedIn tab.

---

## Automated tests

The pure modules and the DOM-dependent extraction logic are both covered:

```bash
npm test          # runs both suites
npm run test:unit # pure modules only (no Chrome APIs / no DOM)
npm run test:dom  # jsdom smoke tests against tests/fixtures/linkedin-search.html
```

`tests/run.js` covers CSV formula-escaping and column layout, `detectHiring` including negations, `gmail.com` retention in the email extractor, dedupe-key seeding after a reload, JSON/HTML legacy normalization, HTML escaping (XSS), and the storage state defaults for the tab lock and progress counters.

`tests/dom/run-dom.js` loads the real selectors / detector / extractor into a jsdom page built from a saved LinkedIn search-results fixture and checks discovery counts, author profile URLs (incl. `/company/`), full 13-ish field extraction, hiring classification, negation, permalink priority, and chrome-stripping from post text. Add new fixtures under `tests/fixtures/` to cover additional LinkedIn layouts.

---

## Test Cases

| # | Scenario | Expected result |
|---|---|---|
| 1 | Fresh LinkedIn search page, default settings | Scan starts; status becomes `RUNNING`; counters update live |
| 2 | Pause mid-scan | Status `PAUSED`; buttons switch (Start/Pause disabled, Resume/Stop enabled); no posts processed while paused |
| 3 | Resume after pause | Loop continues from the same scroll position; `RUNNING`; processed posts are not re-processed |
| 4 | Stop mid-scan | Status `STOPPED`; loop exits promptly; partial results remain in storage |
| 5 | Scroll limit reached (e.g., 2) | Loop stops after 2 scroll steps; status `COMPLETED` |
| 6 | Bottom of results with no new posts | Verification wait runs; after 3 idle rounds status `COMPLETED` |
| 7 | Duplicate posts across scrolls | Each post exported exactly once (dedupe by URL → ID → content hash) |
| 8 | Post with "See more" | Text expands before extraction; no infinite loop (max 2 retries); collapse buttons never clicked |
| 9 | Post with email in visible text | Email extracted, lowercased, de-duplicated into `email` + `emails[]` |
| 10 | Post without email | `email`/`emails[]` empty; record still exported with other fields |
| 11 | Export CSV / JSON / HTML after scan | Files download with correct names, BOM (CSV), 13 columns, valid JSON, printable HTML |
| 12 | Clear results (idle or mid-scan) | Storage wiped; popup counters and progress reset; a running scan is stopped first and does not re-append |
| 13 | Reload LinkedIn tab during `RUNNING` scan | Content script auto-resumes the scan on the same URL; previously processed posts are not re-added |
| 14 | Start a scan in a second LinkedIn tab while one is running | The first scan is stopped and handed off; only one scan runs at a time; Pause/Stop always reach the owning tab |
| 15 | Export CSV with text starting with `=` / `+` / `@` | Cell is prefixed with `'` so spreadsheets do not evaluate it as a formula |
| 16 | Export after running several keywords | Single file contains only the current keyword's records; batch mode produces one file per keyword |

### Manual verification notes

- Verify with the **same URL** after reload (auto-resume checks `state.searchUrl` against the current canonical URL).
- Verify CSV in Excel: non-ASCII characters and commas/quotes render correctly (BOM + RFC-4180 escaping).
- Verify dedupe by re-running a scan on the same page: counters for "Unique Records" must not double.
- Verify privacy: open DevTools → Network while scanning; no requests are made by the extension itself (only the page's normal lazy-loading).

---

## Sample extracted record

```json
{
  "postId": "urn:li:activity:7123456789012345678",
  "postUrl": "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/",
  "authorName": "Jane Doe",
  "authorProfileUrl": "https://www.linkedin.com/in/jane-doe/",
  "authorHeadline": "Staff Engineer at Example Corp",
  "postText": "Excited to share that we shipped the new platform...",
  "email": "jane.doe@example.com",
  "emails": ["jane.doe@example.com"],
  "postedTime": "2 days ago",
  "searchKeyword": "software engineer",
  "sourcePageUrl": "https://www.linkedin.com/search/results/content/?keywords=software%20engineer",
  "extractedAt": "2026-09-08T17:00:00.000Z",
  "isHiring": false
}
```

> `postId` is derived from the activity URN / URL (`urn:li:activity:...`) — never from the DOM index. If no URN exists, a stable content hash is used instead.

---

## Roadmap

Planned / candidate improvements, in rough priority order:

| Status | Item | Notes |
|---|---|---|
| ✅ v3.0.7 | Reliability & safety hardening | Single-scan tab lock + owner routing, batched storage flush + `unlimitedStorage`, keyword-scoped exports, hiring negations, CSV formula guard, XSS fix in HTML report, manifest scope limited to `/search/results/*`, unit test suite |
| ✅ v3.0.6 | Batch export (all stored keywords) | One file per stored search keyword in a single export; silent downloads to the default folder |
| ✅ v3.0.5 | Export filter: "Hiring posts only" | Popup checkbox; CSV / JSON / HTML export only hiring posts (legacy records re-classified on the fly) |
| ✅ v3.0.4 | Hiring post detection | `isHiring` field, CSV `Hiring Post` column, HTML report badge + All/Hiring/Non-Hiring filter |
| ✅ v3.0.3 | "See more" expansion | Click each post's "more" link, extract fully expanded text |
| ✅ v3.0.2 | Reliable export after Stop | Export no longer silently fails after a stopped scan |
| ✅ v3.0.1 | "Content script unavailable" fix | Script-injection reliability on LinkedIn pages |
| ⏳ | Date-range filter at export time | Filter exported posts by `postedTime` / `extractedAt` window |
| ⏳ | Deduplicated cross-keyword export | Merge results across keywords, keep first occurrence |
| ⏳ | Summary stats in popup for hiring posts | Hiring count alongside the existing live counters |
| ⏳ | Local CSV backup / restore | Manual snapshot + restore of `chrome.storage.local` data |
| ⏳ | Options page | Migrate settings from popup to a full options page |

---

## Privacy statement

This extension stores everything **locally** in `chrome.storage.local`. It never transmits extracted data, never logs credentials, and never interacts with LinkedIn beyond scrolling and expanding public post text. Use it only on pages you are authorized to view.
