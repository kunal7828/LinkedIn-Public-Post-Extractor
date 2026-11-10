/**
 * LLPE - CSV Exporter
 * -----------------------------------------------
 * Builds a UTF-8 CSV with BOM (Excel-compatible) from
 * extraction records. Runs in the service worker.
 *
 * Namespace:
 *   globalThis.LLPE.CsvExporter
 */
(function registerCsvExporter(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const { Helpers } = NS;

  const CSV_COLUMNS = [
    'Post ID',
    'Post URL',
    'Author Name',
    'Author Profile URL',
    'Author Headline',
    'Hiring Post',
    'Post Text',
    'Email',
    'All Emails',
    'Posted Time',
    'Search Keyword',
    'Source Page URL',
    'Extracted At'
  ];

  /** Map a record to the CSV column order. */
  function toRow(record) {
    return [
      record.postId || '',
      record.postUrl || '',
      record.authorName || '',
      record.authorProfileUrl || '',
      record.authorHeadline || '',
      Helpers.recordIsHiring(record) ? 'Yes' : 'No',
      record.postText || '',
      record.email || '',
      Array.isArray(record.emails) ? [...new Set(record.emails.map((e) => String(e).trim()))].join('; ') : '',
      record.postedTime || '',
      record.searchKeyword || '',
      record.sourcePageUrl || '',
      record.extractedAt || ''
    ];
  }

  /** Build the full CSV string (header + rows), no BOM here. */
  function buildCsv(records) {
    const header = CSV_COLUMNS.map((c) => Helpers.csvEscape(c)).join(',');
    const rows = (records || []).map((r) => toRow(r).map((v) => Helpers.csvEscape(v)).join(','));
    return [header, ...rows].join('\r\n');
  }

  /** Full file content including UTF-8 BOM for Excel. */
  function buildCsvFile(records) {
    return '\uFEFF' + buildCsv(records);
  }

  NS.CsvExporter = {
    CSV_COLUMNS,
    toRow,
    buildCsv,
    buildCsvFile
  };
})(globalThis);
