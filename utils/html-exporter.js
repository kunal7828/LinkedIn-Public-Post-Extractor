/**
 * LLPE - HTML Exporter
 * -----------------------------------------------
 * Generates a clean, printable, professional HTML
 * report from extraction records. Runs in the service
 * worker (no DOM APIs used).
 *
 * Namespace:
 *   globalThis.LLPE.HtmlExporter
 */
(function registerHtmlExporter(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const { Helpers } = NS;

  const REPORT_CSS = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
           color: #1f2937; background: #f3f4f6; margin: 0; padding: 24px; line-height: 1.5; }
    .container { max-width: 960px; margin: 0 auto; }
    header { background: #0a66c2; color: #fff; border-radius: 12px; padding: 22px 26px; margin-bottom: 22px; }
    header h1 { margin: 0 0 10px; font-size: 22px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 16px; }
    .summary .item { background: rgba(255,255,255,.14); border-radius: 8px; padding: 10px 12px; }
    .summary .item b { display: block; font-size: 20px; }
    .summary .item span { font-size: 11px; opacity: .9; text-transform: uppercase; letter-spacing: .4px; }
    .meta { font-size: 12px; opacity: .92; margin-top: 12px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px;
            break-inside: avoid; page-break-inside: avoid; }
    .card h2 { margin: 0 0 4px; font-size: 17px; color: #111827; }
    .card .sub { color: #6b7280; font-size: 12px; margin-bottom: 10px; }
    .card .label { font-weight: 600; color: #374151; font-size: 12px; text-transform: uppercase;
                   letter-spacing: .4px; margin: 12px 0 3px; }
    .card .text { white-space: pre-wrap; word-break: break-word; background: #f9fafb; border-radius: 6px;
                  padding: 10px 12px; font-size: 14px; }
    .card a { color: #0a66c2; word-break: break-all; }
    .email { color: #047857; font-weight: 600; }
    .badge { display: inline-block; vertical-align: middle; margin-left: 8px; background: #e0f2fe; color: #075985;
             border: 1px solid #7dd3fc; border-radius: 999px; font-size: 11px; font-weight: 700;
             text-transform: uppercase; letter-spacing: .4px; padding: 2px 10px; }
    .filters { display: flex; gap: 8px; flex-wrap: wrap; margin: -6px 0 18px; }
    .filter-btn { border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 999px;
                  padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .filter-btn.active { background: #0a66c2; border-color: #0a66c2; color: #fff; }
    .filter-btn:focus-visible { outline: 2px solid #0a66c2; outline-offset: 2px; }
    .empty { text-align: center; color: #6b7280; padding: 60px 0; }
    footer { text-align: center; color: #9ca3af; font-size: 12px; margin-top: 24px; }
    @media print {
      body { background: #fff; padding: 0; }
      header { border-radius: 0; }
      .card { border-color: #ccc; break-inside: avoid; }
    }
  `;

  function buildSummary(records, context) {
    const emails = new Set();
    (records || []).forEach((r) => {
      (Array.isArray(r.emails) ? r.emails : []).forEach((e) => emails.add(e));
      // Legacy records only have the singular `email` field.
      if (!r.emails && r.email) {emails.add(r.email);}
    });
    const keyword = context.searchKeyword || (records[0] && records[0].searchKeyword) || '—';
    const source = context.sourcePageUrl || (records[0] && records[0].sourcePageUrl) || '—';
    // `postsFound` is a DOM snapshot and can be lower than the number of
    // records we actually hold - never show fewer totals than we print.
    const unique = (records || []).length;
    return {
      totalFound: Math.max(context.postsFound || 0, unique),
      unique,
      emailsFound: emails.size,
      hiringCount: (records || []).filter((r) => Helpers.recordIsHiring(r)).length,
      keyword,
      source,
      date: new Date().toLocaleString()
    };
  }

  function buildCard(record) {
    const emails = [...new Set((Array.isArray(record.emails) ? record.emails : []).map((e) => String(e).trim().toLowerCase()))].filter(Boolean);
    const emailBlock = emails.length
      ? `<div class="label">Public Email</div><div class="email">${emails.map((e) => Helpers.escapeHtml(e)).join(', ')}</div>`
      : '';
    const profileBlock = record.authorProfileUrl
      ? `<div class="label">Profile</div><div><a href="${Helpers.escapeHtml(record.authorProfileUrl)}" target="_blank" rel="noopener noreferrer">${Helpers.escapeHtml(record.authorProfileUrl)}</a></div>`
      : '';
    const postBlock = record.postUrl
      ? `<div class="label">Post URL</div><div><a href="${Helpers.escapeHtml(record.postUrl)}" target="_blank" rel="noopener noreferrer">${Helpers.escapeHtml(record.postUrl)}</a></div>`
      : '';

    const hiring = Helpers.recordIsHiring(record);
    const hiringBadge = hiring ? ' <span class="badge">Hiring</span>' : '';

    return `
    <article class="card" data-hiring="${hiring ? 'true' : 'false'}">
      <h2>${Helpers.escapeHtml(record.authorName || 'Unknown author')}${hiringBadge}</h2>
      <div class="sub">
        ${record.authorHeadline ? Helpers.escapeHtml(record.authorHeadline) : ''}
        ${record.postedTime ? ' &middot; ' + Helpers.escapeHtml(record.postedTime) : ''}
      </div>
      <div class="label">Post</div>
      <div class="text">${Helpers.escapeHtml(record.postText || '')}</div>
      ${emailBlock}
      ${profileBlock}
      ${postBlock}
    </article>`;
  }

  /** Build the complete standalone HTML document. */
  function buildHtmlReport(records, context = {}) {
    const summary = buildSummary(records, context);
    const hasRecords = (records || []).length > 0;
    const cards = hasRecords
      ? (records || []).map(buildCard).join('\n')
      : `<div class="empty">No extraction records yet. Run an extraction first.</div>`;
    const filters = hasRecords
      ? `
  <div class="filters" id="reportFilters" aria-label="Filter posts">
    <button type="button" class="filter-btn active" data-filter="all">All (<span data-count="all">${summary.unique}</span>)</button>
    <button type="button" class="filter-btn" data-filter="hiring">Hiring (<span data-count="hiring">${summary.hiringCount}</span>)</button>
    <button type="button" class="filter-btn" data-filter="other">Non-Hiring (<span data-count="other">${summary.unique - summary.hiringCount}</span>)</button>
  </div>`
      : '';
    const filterScript = hasRecords
      ? `
<script>
(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.filter-btn'));
  function apply(filter) {
    cards.forEach(function (card) {
      var hiring = card.getAttribute('data-hiring') === 'true';
      var show = filter === 'all' || (filter === 'hiring' && hiring) || (filter === 'other' && !hiring);
      card.style.display = show ? '' : 'none';
    });
  }
  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      buttons.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      apply(btn.getAttribute('data-filter'));
    });
  });
})();
</script>`
      : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LinkedIn Public Post Extraction Report</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="container">
  <header>
    <h1>LinkedIn Public Post Extraction Report</h1>
    <div class="summary">
      <div class="item"><b>${summary.totalFound}</b><span>Total Posts</span></div>
      <div class="item"><b>${summary.unique}</b><span>Unique Posts</span></div>
      <div class="item"><b>${summary.emailsFound}</b><span>Emails Found</span></div>
      <div class="item"><b>${summary.hiringCount}</b><span>Hiring Posts</span></div>
    </div>
    <div class="meta">
      <b>Search keyword:</b> ${Helpers.escapeHtml(summary.keyword)}<br>
      <b>Source URL:</b> ${Helpers.escapeHtml(summary.source)}<br>
      <b>Extraction Date:</b> ${Helpers.escapeHtml(summary.date)}
    </div>
  </header>
  ${filters}
  ${cards}
  <footer>Generated by LinkedIn Public Post Extractor &middot; Data extracted from publicly visible page content only.</footer>
</div>
${filterScript}
</body>
</html>`;
  }

  NS.HtmlExporter = {
    buildSummary,
    buildCard,
    buildHtmlReport
  };
})(globalThis);
