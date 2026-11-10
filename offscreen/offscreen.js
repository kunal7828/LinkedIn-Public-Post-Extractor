'use strict';

/**
 * Offscreen document that runs OCR (Tesseract.js) on image URLs.
 *
 * NOTE: Full OCR requires the Tesseract worker bundle, WASM core and
 * language data to be present locally (see offscreen/README or project
 * docs). Only the Tesseract.js wrapper is bundled here; the worker/core/
 * language assets are NOT bundled to keep the extension small. When those
 * assets are absent, OCR degrades gracefully and reports "unavailable"
 * instead of breaking the extension or violating CSP.
 */
let workerPromise = null;
let unavailableReason = null;

async function getWorker() {
  if (unavailableReason) {throw new Error(unavailableReason);}
  if (workerPromise) {return workerPromise;}
  workerPromise = (async () => {
    if (typeof Tesseract === 'undefined' || typeof Tesseract.createWorker !== 'function') {
      unavailableReason = 'Tesseract.js wrapper not loaded';
      throw new Error(unavailableReason);
    }
    try {
      // createWorker will attempt to fetch the worker/core/language assets.
      // If they are not bundled locally this will fail; we catch and mark
      // OCR as unavailable rather than crashing the offscreen document.
      const worker = await Tesseract.createWorker('eng');
      return worker;
    } catch (error) {
      unavailableReason = 'OCR assets not available locally: ' + String((error && error.message) || error);
      workerPromise = null;
      throw new Error(unavailableReason);
    }
  })();
  return workerPromise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'OCR_IMAGE') {return false;}

  (async () => {
    try {
      const worker = await getWorker();
      const { data } = await worker.recognize(message.url);
      sendResponse({ ok: true, text: (data && data.text) || '' });
    } catch (error) {
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    }
  })();

  return true;
});
