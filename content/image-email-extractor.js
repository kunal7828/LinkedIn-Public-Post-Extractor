/**
 * LLPE - Image Email Extractor (optional, opt-in)
 * -----------------------------------------------
 * Best-effort extraction of emails that appear inside images
 * (posters, screenshots, scanned cards) using client-side OCR
 * (Tesseract.js) running in an offscreen document. Image data
 * never leaves the browser.
 *
 * Gated by the `ocrImages` setting (default OFF) because OCR is
 * slow and heavy. Degrades gracefully when the library or the
 * offscreen document is unavailable.
 *
 * Namespace:
 *   globalThis.LLPE.ImageEmailExtractor
 */
(function registerImageEmailExtractor(global) {
  'use strict';

  const NS = (global.LLPE = global.LLPE || {});
  const { Logger, EmailExtractor, Helpers } = NS;

  const MAX_IMAGES_PER_POST = 4;

  function collectImageUrls(post) {
    const urls = [];
    const seen = new Set();
    for (const img of post.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src') || '';
      if (!src || seen.has(src)) {continue;}
      // Skip tiny icons / avatars / emoji.
      const w = Number(img.getAttribute('width') || img.naturalWidth || 0);
      const h = Number(img.getAttribute('height') || img.naturalHeight || 0);
      if (w > 0 && h > 0 && (w < 48 || h < 48)) {continue;}
      seen.add(src);
      urls.push(src);
      if (urls.length >= MAX_IMAGES_PER_POST) {break;}
    }
    return urls;
  }

  async function extractEmailsFromImages(postElement) {
    if (!postElement || !global.chrome || !chrome.runtime) {return [];}
    const urls = collectImageUrls(postElement);
    if (urls.length === 0) {return [];}

    let settings = {};
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      settings = (res && res.settings) || {};
    } catch {
      settings = {};
    }
    if (!settings.ocrImages) {return [];} // opt-in only

    const emails = [];
    try {
      const response = await chrome.runtime.sendMessage({ type: 'OCR_IMAGES', urls });
      if (response && response.ok && Array.isArray(response.texts)) {
        for (const text of response.texts) {
          emails.push(...EmailExtractor.extractEmails(String(text || '')));
        }
      }
    } catch (error) {
      Logger.debug('[ImageEmailExtractor] OCR unavailable:', error?.message || error);
    }
    return [...new Set(emails)];
  }

  NS.ImageEmailExtractor = {
    collectImageUrls,
    extractEmailsFromImages
  };
})(globalThis);
