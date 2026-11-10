'use strict';

/**
 * Offscreen document that runs OCR (Tesseract.js) on image URLs
 * and returns extracted text. Used for image-based email extraction.
 * The image data never leaves the browser.
 */
let workerPromise = null;

async function getWorker() {
  if (workerPromise) {return workerPromise;}
  workerPromise = (async () => {
    if (typeof Tesseract === 'undefined') {
      throw new Error('Tesseract.js not loaded');
    }
    const worker = await Tesseract.createWorker('eng');
    return worker;
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

  return true; // async response
});
