/*
 * Gatefold · imgworker.js — image work off the UI thread.
 * base64 ⇄ bytes, decoding multi-megapixel downloads, validation statistics,
 * resizing and JPEG encoding all ran on the page's main thread before; with a
 * 3000×3000 download that is tens of milliseconds of frozen animation per cover.
 */
import { ops } from './imgops.js';

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try { self.postMessage({ id, ok: true, res: await ops[op](args || {}) }); }
  catch (err) { self.postMessage({ id, ok: false, err: String((err && err.message) || err) }); }
};
