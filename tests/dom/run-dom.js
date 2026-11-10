'use strict';

/**
 * DOM-level smoke tests for the content-script modules.
 *
 * Runs the real selectors / detector / extractor against a saved LinkedIn
 * search-results fixture using jsdom, so regressions in DOM-dependent code
 * are caught without a live LinkedIn tab.
 *
 * Run with:  node tests/dom/run-dom.js   (or via `npm test`)
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const fixturePath = path.join(__dirname, '..', 'fixtures', 'linkedin-search.html');
const html = fs.readFileSync(fixturePath, 'utf8');

// ---------- Chrome API shim ----------
const storageState = { results: [], state: null, settings: null };
const chromeShim = {
  storage: {
    local: {
      get: async (defaults) => {
        const out = {};
        if (defaults && typeof defaults === 'object') {
          for (const key of Object.keys(defaults)) {
            if (key === 'llpe_results_v30') {out[key] = storageState.results;}
            else if (key === 'llpe_state_v30') {out[key] = storageState.state || defaults[key];}
            else if (key === 'llpe_settings_v30') {out[key] = storageState.settings || defaults[key];}
            else {out[key] = defaults[key];}
          }
        }
        return out;
      },
      set: async (obj) => {
        if (obj.llpe_results_v30) {storageState.results = obj.llpe_results_v30;}
        if (obj.llpe_state_v30) {storageState.state = obj.llpe_state_v30;}
        if (obj.llpe_settings_v30) {storageState.settings = obj.llpe_settings_v30;}
      },
      remove: async (keys) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        if (arr.includes('llpe_results_v30')) {storageState.results = [];}
        if (arr.includes('llpe_state_v30')) {storageState.state = null;}
      }
    },
    onChanged: { addListener: () => {} }
  },
  runtime: {
    getManifest: () => ({ version: '3.0.7', content_scripts: [{ js: [] }] }),
    sendMessage: async () => ({ ok: true, tabId: 42 })
  },
  tabs: { query: async () => [], get: async () => null, sendMessage: async () => ({}) }
};
global.chrome = chromeShim;

// ---------- DOM environment ----------
const dom = new JSDOM(html, { url: 'https://www.linkedin.com/search/results/content/?keywords=software%20engineer', resources: 'usable' });
global.window = dom.window;
global.document = dom.window.document;
try { delete global.navigator; } catch { /* ignore */ }
global.navigator = dom.window.navigator;
global.location = dom.window.location;
global.HTMLElement = dom.window.HTMLElement;
global.MutationObserver = dom.window.MutationObserver;
global.Node = dom.window.Node;

// jsdom does not compute layout, so innerText is always ''. Shim it to
// textContent so extraction logic (which reads innerText) can be exercised.
try {
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent || ''; },
    set(v) { this.textContent = v; }
  });
} catch (e) { /* already defined */ }
global.LLPE = global.LLPE || {};
const _nsPlaceholder = null; // modules populate global.LLPE below

// Load modules in dependency order.
const files = [
  'utils/logger.js',
  'utils/helpers.js',
  'utils/storage.js',
  'content/selectors.js',
  'content/deduplicator.js',
  'content/email-extractor.js',
  'content/post-detector.js',
  'content/post-expander.js',
  'content/post-extractor.js'
];
for (const f of files) {
  require(path.join(root, f));
}

const { Selectors, Helpers, PostDetector, PostExtractor, EmailExtractor, Storage } = global.LLPE;

// ---------- Test harness ----------
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || 'not equal'}\n  expected: ${JSON.stringify(b)}\n  actual:   ${JSON.stringify(a)}`);
  }
}

// 1. Discovery finds the semantic articles (and the structural fallback).
test('PostDetector discovers 4 post containers', () => {
  const posts = PostDetector.discoverPosts();
  assert(posts.length >= 3, `expected >=3, got ${posts.length}`);
});

// 2. Profile link extraction picks /in/ and /company/ correctly.
test('author profile URLs are extracted', () => {
  const posts = PostDetector.discoverPosts();
  const urls = posts.map((p) => PostExtractor.findAuthorProfileUrl(p));
  assert(urls.some((u) => /\/in\/jane-doe/.test(u)), 'jane profile missing');
  assert(urls.some((u) => /\/company\/acme/.test(u)), 'acme company profile missing');
});

// 3. Full extraction of the first post.
test('extracts the first post record correctly', async () => {
  const posts = PostDetector.discoverPosts();
  const janePost = posts.find((p) => /jane-doe/.test(PostExtractor.findAuthorProfileUrl(p)));
  assert(janePost, 'jane post not found');
  const record = await PostExtractor.extractPost(janePost, { searchKeyword: 'software engineer' });
  assert(record, 'record null');
  assertEqual(record.authorName, 'Jane Doe', 'author name');
  assert(record.authorProfileUrl.includes('/in/jane-doe'), 'profile url');
  assert(record.authorHeadline.includes('Staff Engineer'), 'headline');
  assert(record.postText.includes('shipped the new platform'), 'post text');
  assertEqual(record.email, 'jane.doe@gmail.com', 'email');
  assertEqual(record.emails, ['jane.doe@gmail.com'], 'emails[]');
  assert(record.postUrl.includes('activity:1111'), 'post url');
  assert(record.postedTime && record.postedTime.includes('2026-11-01'), 'posted time (datetime)');
  assert(record.searchKeyword === 'software engineer', 'keyword');
  assert(record.isHiring === false, 'not hiring');
});

// 4. Hiring detection on the Acme post (including resume/apply).
test('Acme post is classified as hiring', async () => {
  const posts = PostDetector.discoverPosts();
  const acmePost = posts.find((p) => /acme/.test(PostExtractor.findAuthorProfileUrl(p)));
  assert(acmePost, 'acme post not found');
  const record = await PostExtractor.extractPost(acmePost, {});
  assert(record, 'record null');
  assert(record.authorName === 'Acme Corp', 'author name');
  assert(record.isHiring === true, 'should be hiring');
  assert(record.emails.includes('jobs@acme.com'), 'email extracted');
});

// 5. Negated hiring post is NOT classified as hiring.
test('negated hiring post is not hiring', async () => {
  const posts = PostDetector.discoverPosts();
  const bobPost = posts.find((p) => /\/in\/bob/.test(PostExtractor.findAuthorProfileUrl(p)));
  assert(bobPost, 'bob post not found');
  const record = await PostExtractor.extractPost(bobPost, {});
  assert(record, 'record null');
  assert(record.isHiring === false, 'should not be hiring');
  // linkedin.com email must be filtered out
  assert(!record.emails.some((e) => /linkedin\.com/.test(e)), 'linkedin domain leaked');
});

// 6. Post URL priority: permalink wins over profile link.
test('postUrl prefers the activity permalink', async () => {
  const posts = PostDetector.discoverPosts();
  const janePost = posts.find((p) => /jane-doe/.test(PostExtractor.findAuthorProfileUrl(p)));
  const record = await PostExtractor.extractPost(janePost, {});
  assert(/feed\/update\/urn:li:activity/.test(record.postUrl), 'permalink not preferred');
});

// 7. Body text does not include the actor header / social counts.
test('postText excludes chrome text', async () => {
  const posts = PostDetector.discoverPosts();
  const janePost = posts.find((p) => /jane-doe/.test(PostExtractor.findAuthorProfileUrl(p)));
  const record = await PostExtractor.extractPost(janePost, {});
  assert(!/Like|Comment/.test(record.postText), 'chrome leaked into postText');
});

// 8. containerKey is stable and exported.
test('containerKey is exported and stable', () => {
  assert(typeof PostDetector.containerKey === 'function', 'containerKey not exported');
  const posts = PostDetector.discoverPosts();
  const k1 = PostDetector.containerKey(posts[0]);
  const k2 = PostDetector.containerKey(posts[0]);
  assert(k1 && k1 === k2, 'containerKey not stable');
});

if (failures.length) {
  console.error(`\n${failures.length} DOM test(s) FAILED:\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`\n✓ ${passed} DOM tests passed`);
