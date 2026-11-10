/**
 * LLPE - Unit tests (pure modules only, no Chrome APIs needed).
 *
 * Run with:  npm test   (or: node tests/run.js)
 *
 * Covers the shared helpers, dedupe keys, email extraction and the
 * three exporters - i.e. every module that can run outside Chrome.
 */
'use strict';

const path = require('path');

const root = path.join(__dirname, '..');
for (const file of [
  'utils/logger.js',
  'utils/helpers.js',
  'content/deduplicator.js',
  'content/email-extractor.js',
  'utils/csv-exporter.js',
  'utils/json-exporter.js',
  'utils/html-exporter.js',
  'utils/storage.js'
]) {
  require(path.join(root, file));
}

const { Helpers, Deduplicator, EmailExtractor, CsvExporter, JsonExporter, HtmlExporter, Storage } = globalThis.LLPE;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {throw new Error(message || 'assertion failed');}
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {throw new Error(`${message || 'not equal'}\n  expected: ${e}\n  actual:   ${a}`);}
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

test('csvEscape neutralizes spreadsheet formulas', () => {
  const row = CsvExporter.buildCsv([{ postId: '=1+1', postText: '+SUM(A1)' }]).split('\r\n')[1];
  assert(row.startsWith('"\'=1+1"'), `leading = must be escaped, got: ${row.split(',').pop()}`);
  assert(row.includes(`"'${'+SUM(A1)'}"`), 'leading + must be escaped');
  const plain = CsvExporter.buildCsv([{ postId: 'urn:li:activity:1', postText: 'plain text' }]).split('\r\n')[1];
  assert(plain.includes('"plain text"'), 'plain text untouched');
});

test('csvEscape keeps RFC-4180 quoting', () => {
  assertEqual(Helpers.csvEscape('say "hi"'), '"say ""hi"""', 'quotes doubled');
  assertEqual(Helpers.csvEscape('a,b'), '"a,b"', 'commas quoted');
});

test('safeFilename falls back to a usable name (no double suffix)', () => {
  // Export calls must pass their own fallback, otherwise an empty keyword
  // produced filenames like "linkedin-public-posts-public-posts.csv".
  assertEqual(Helpers.safeFilename('', 'linkedin'), 'linkedin', 'caller fallback wins');
  assertEqual(Helpers.safeFilename('software engineer'), 'software_engineer', 'spaces cleaned');
  assertEqual(`${Helpers.safeFilename('', 'linkedin')}-public-posts.csv`, 'linkedin-public-posts.csv', 'no double suffix');
});

test('detectHiring accepts real hiring posts', () => {
  assert(Helpers.detectHiring("We're hiring a backend engineer"), 'plain hiring');
  assert(Helpers.detectHiring('Join our team! Apply now'), 'apply now');
  assert(Helpers.detectHiring('Send your resume to careers@example.com'), 'resume');
});

test('detectHiring rejects negated hiring phrases', () => {
  assert(!Helpers.detectHiring('We are not hiring at this time'), 'not hiring');
  assert(!Helpers.detectHiring("We aren't currently hiring anyone"), "aren't hiring");
  assert(!Helpers.detectHiring('Hiring freeze announced'), 'hiring freeze');
  assert(!Helpers.detectHiring('No open positions at the moment'), 'no open positions');
  assert(!Helpers.detectHiring('We stopped hiring last month'), 'stopped hiring');
});

test('detectHiring still finds hiring inside longer sentences', () => {
  assert(Helpers.detectHiring('Great news — the team is hiring again!'), 'hiring after dash');
  assert(Helpers.detectHiring('We are actively hiring engineers across Europe'), 'actively hiring');
});

test('recordIsHiring uses stored flag and re-classifies legacy records', () => {
  assert(Helpers.recordIsHiring({ isHiring: true, postText: 'irrelevant' }), 'stored true wins');
  assert(!Helpers.recordIsHiring({ isHiring: false, postText: 'we are hiring' }), 'stored false wins');
  assert(Helpers.recordIsHiring({ postText: 'we are hiring designers' }), 'legacy re-classified true');
  assert(!Helpers.recordIsHiring({ postText: 'we are not hiring' }), 'legacy re-classified false');
});

test('normalizeUrlForCompare strips query, hash and trailing slash', () => {
  assertEqual(
    Helpers.normalizeUrlForCompare('https://www.linkedin.com/feed/update/urn:li:activity:1/?trk=abc#x'),
    'https://www.linkedin.com/feed/update/urn:li:activity:1',
    'comparable form'
  );
});

/* ------------------------------------------------------------------ */
/* email extractor                                                     */
/* ------------------------------------------------------------------ */

test('email extractor keeps common providers', () => {
  assertEqual(
    EmailExtractor.extractEmails('Reach me at jane.doe@gmail.com'),
    ['jane.doe@gmail.com'],
    'gmail must not be filtered out'
  );
});

test('email extractor drops non-email identifiers', () => {
  assertEqual(EmailExtractor.extractEmails('see https://www.linkedin.com/in/x'), [], 'urls');
  assertEqual(EmailExtractor.extractEmails('team@linkedin.com'), [], 'linkedin domain');
  assertEqual(EmailExtractor.extractEmails('you@example.com'), [], 'example.com placeholder');
});

test('email extractor lowercases and deduplicates', () => {
  assertEqual(
    EmailExtractor.extractEmails('A@B.co and a@b.co and a@b.co'),
    ['a@b.co'],
    'lowercase + unique'
  );
});

/* ------------------------------------------------------------------ */
/* deduplicator                                                        */
/* ------------------------------------------------------------------ */

const ACTIVITY_URL = 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/';

test('dedupe key prefers postUrl, then postId, then content', () => {
  const byUrl = Deduplicator.buildDedupeKey({ postUrl: ACTIVITY_URL, postId: 'urn:li:activity:1' });
  assertEqual(byUrl, `url:${ACTIVITY_URL.replace(/\/$/, '')}`, 'url key');
  const byId = Deduplicator.buildDedupeKey({ postId: 'urn:li:activity:7123456789012345678' });
  assertEqual(byId, 'id:urn:li:activity:7123456789012345678', 'id key');
  const byContent = Deduplicator.buildDedupeKey({ authorProfileUrl: 'https://www.linkedin.com/in/jane/', postText: 'Hi' });
  assert(byContent.startsWith('content:'), 'content key');
});

test('deduper can be seeded with persisted quick keys', () => {
  // The scroll manager persists keys like `url:...` / `id:urn:...` and must
  // recognise those same records again after a reload.
  const quickKeys = [`url:${ACTIVITY_URL.replace(/\/$/, '')}`, 'id:urn:li:activity:5'];
  const deduper = Deduplicator.create([...quickKeys]);
  assert(
    deduper.has({ postUrl: ACTIVITY_URL, postId: 'x' }),
    'seeded url key must match a record with that postUrl'
  );
  assert(deduper.has({ postId: 'urn:li:activity:5' }), 'seeded id key must match that postId');
  assert(!deduper.has({ postId: 'urn:li:activity:6' }), 'unknown postId still counts as new');
});

test('deduper isNewAndAdd marks duplicates', () => {
  const deduper = Deduplicator.create([]);
  assert(deduper.isNewAndAdd({ postUrl: ACTIVITY_URL }), 'first insert is new');
  assert(!deduper.isNewAndAdd({ postUrl: ACTIVITY_URL }), 'second insert is a duplicate');
});

/* ------------------------------------------------------------------ */
/* exporters                                                           */
/* ------------------------------------------------------------------ */

const CSV_COLUMNS = 13;

test('CSV has BOM, CRLF rows and the documented column count', () => {
  const csv = CsvExporter.buildCsvFile([
    { postId: 'urn:li:activity:1', postText: 'line1\nline2', emails: ['a@b.com'] }
  ]);
  assert(csv.charCodeAt(0) === 0xfeff, 'BOM present');
  assert(csv.includes('\r\n'), 'CRLF line endings');
  assertEqual(CsvExporter.CSV_COLUMNS.length, CSV_COLUMNS, '13 columns');
  const rows = csv.replace(/^\uFEFF/, '').split('\r\n');
  assertEqual(rows.length, 2, 'header + one row (embedded newline stays quoted)');
  assert(rows[1].includes('"line1\nline2"'), 'embedded newline quoted');
});

test('CSV re-classifies legacy hiring records into the Hiring Post column', () => {
  const csv = CsvExporter.buildCsv([{ postId: 'x', postText: 'we are hiring designers' }]);
  const row = CsvExporter.toRow({ postId: 'x', postText: 'we are hiring designers' });
  assertEqual(row[5], 'Yes', 'Hiring Post column is Yes');
  assert(!csv.includes('"No","we are hiring'), 'must not be reported as No');
});

test('JSON export normalizes legacy records', () => {
  const parsed = JSON.parse(JsonExporter.buildJsonFile([
    { postId: 'x', postText: 'we are hiring', email: 'a@b.com' }
  ]));
  assertEqual(parsed[0].isHiring, true, 'isHiring backfilled');
  assertEqual(parsed[0].emails, ['a@b.com'], 'emails backfilled from email');
  assertEqual(parsed[0].email, 'a@b.com', 'email preserved');
});

test('JSON export escapes nothing it should not (raw array)', () => {
  const parsed = JSON.parse(JsonExporter.buildJson([{ postText: 'He said "hi", ok?' }]));
  assertEqual(parsed[0].postText, 'He said "hi", ok?', 'text intact');
});

test('HTML summary counts legacy singular email and never totals below unique', () => {
  const summary = HtmlExporter.buildSummary([{ email: 'legacy@x.com' }], { postsFound: 0 });
  assertEqual(summary.emailsFound, 1, 'legacy email counted');
  assertEqual(summary.unique, 1, 'unique');
  assertEqual(summary.totalFound, 1, 'total >= unique when postsFound is stale');
});

test('HTML report escapes record content', () => {
  const html = HtmlExporter.buildHtmlReport([
    { postText: '<script>alert(1)</script>', authorName: '<b>x</b>', emails: ['a@b.com'] }
  ], {});
  assert(!html.includes('<script>alert(1)</script>'), 'post text escaped');
  assert(html.includes('&lt;script&gt;'), 'escaped form present');
});

/* ------------------------------------------------------------------ */
/* storage (state defaults only - no chrome.storage in Node)           */
/* ------------------------------------------------------------------ */

test('storage exposes scanner state defaults for tab lock and progress', () => {
  assert('scanTabId' in Storage.DEFAULT_STATE, 'scanTabId default');
  assert('scrollCount' in Storage.DEFAULT_STATE, 'scrollCount default');
  assert('scrollLimit' in Storage.DEFAULT_STATE, 'scrollLimit default');
  assert(typeof Storage.flushResults === 'function', 'flushResults exported');
});

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

if (failures.length) {
  console.error(`\n${failures.length} test(s) FAILED:\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`\n✓ ${passed} tests passed`);
