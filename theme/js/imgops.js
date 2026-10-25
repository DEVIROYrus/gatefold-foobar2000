/*
 * Gatefold · imgops.js — image operations shared by the image worker and its
 * main-thread fallback (used only if module workers are unavailable).
 */
/* global OffscreenCanvas, createImageBitmap, FileReaderSync */
function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function sniff(u) {
  if (u[0] === 0xff && u[1] === 0xd8) return 'image/jpeg';
  if (u[0] === 0x89 && u[1] === 0x50) return 'image/png';
  if (u[0] === 0x52 && u[1] === 0x49 && u[8] === 0x57 && u[9] === 0x45) return 'image/webp';
  if (u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) return 'image/gif';
  if (u[0] === 0x42 && u[1] === 0x4d) return 'image/bmp';
  return '';
}
const toB64 = (blob) => (typeof FileReaderSync !== 'undefined'
  ? new FileReaderSync().readAsDataURL(blob).split(',')[1]
  : new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); }));
function stripB64(s) {
  s = String(s || '');
  if (s.startsWith('data:')) s = s.slice(s.indexOf(',') + 1);
  if (s.startsWith('base64:')) s = s.slice(7);
  return s.replace(/\s+/g, '');
}

async function resizeBlob(blob, w, h, { max = 0, quality = 0.92, square = false, bias = 0, type = 'image/jpeg' } = {}) {
  let sx = 0, sy = 0, sw = w, sh = h;
  if (square) { const s = Math.min(w, h); sx = (w - s) / 2; sy = h > w ? (h - s) * bias : 0; sw = sh = s; }
  const k = max ? Math.min(1, max / Math.max(sw, sh)) : 1;
  const ow = Math.max(1, Math.round(sw * k)), oh = Math.max(1, Math.round(sh * k));
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(ow, oh);
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, sx, sy, sw, sh, 0, 0, ow, oh); bmp.close();
  return { blob: await c.convertToBlob({ type, quality }), w: ow, h: oh };
}


/* ---- how much fine detail a picture holds (sharperAt) ----
   A cover served as 1000×1000 or 3000×3000 is sometimes a smaller picture stretched by the server. Its
   size says nothing then; what tells is the detail. Brought down to the size of a smaller copy of the
   same cover, a stretched one comes out softer than that copy, a real one does not. The measure: the
   part of the picture lost when it is halved and enlarged again, relative to its contrast. */
const lumOf = (x, c) => { const d = x.getImageData(0, 0, c, c).data; const o = new Float32Array(c * c); for (let i = 0, j = 0; j < o.length; i += 4, j++) o[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; return o; };
function fineDetail(cv, c) {
  const L = lumOf(cv.getContext('2d', { willReadFrequently: true }), c);
  const h = Math.round(c / 2), s = new OffscreenCanvas(h, h), sx = s.getContext('2d'); sx.imageSmoothingQuality = 'high'; sx.drawImage(cv, 0, 0, h, h);
  const b = new OffscreenCanvas(c, c), bx = b.getContext('2d', { willReadFrequently: true }); bx.imageSmoothingQuality = 'high'; bx.drawImage(s, 0, 0, c, c);
  const Y = lumOf(bx, c);
  const m = Math.round(c * 0.03); let e = 0, n = 0, s1 = 0, s2 = 0;
  for (let y = m; y < c - m; y++) for (let x = m; x < c - m; x++) { const k = y * c + x; e += Math.abs(L[k] - Y[k]); s1 += L[k]; s2 += L[k] * L[k]; n++; }
  const sd = Math.sqrt(Math.max(0, s2 / n - (s1 / n) ** 2));
  return { abs: e / n, rel: e / n / (sd + 4) };
}

export const ops = {
  /** network download (base64) → validated image facts */
  async decode({ b64, blob }) {
    let bytes;
    if (b64 != null) { const s = stripB64(b64); if (s.length < 2000) throw new Error('empty image'); bytes = b64ToBytes(s); }
    else bytes = new Uint8Array(await blob.arrayBuffer());
    const mime = sniff(bytes);
    if (!mime) throw new Error('not an image');
    const out = new Blob([bytes], { type: mime });
    const bmp = await createImageBitmap(out);
    const w = bmp.width, h = bmp.height;
    const c = new OffscreenCanvas(16, 16); const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0, 16, 16); bmp.close();
    const d = x.getImageData(0, 0, 16, 16).data;
    let s = 0, s2 = 0; for (let i = 0; i < d.length; i += 4) { const l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; s += l; s2 += l * l; }
    const std = Math.sqrt(Math.max(0, s2 / 256 - (s / 256) ** 2));
    return { blob: out, mime, w, h, std, size: bytes.length, b64: b64 != null ? stripB64(b64) : '' };
  },
  /** resize (+ optional square crop) → JPEG, optionally with its base64 */
  async resize({ blob, w, h, max, quality, square, bias, wantB64, type }) {
    if (!w || !h) { const b = await createImageBitmap(blob); w = b.width; h = b.height; b.close(); }
    const r = await resizeBlob(blob, w, h, { max, quality, square, bias, type });
    return { ...r, mime: r.blob.type, b64: wantB64 ? await toB64(r.blob) : '' };
  },
  async b64({ blob }) { return toB64(blob); },
  async fromDataUrl({ dataUrl, mime }) {
    const s = stripB64(dataUrl);
    const head = String(dataUrl).slice(0, 40).match(/^data:([^;,]+)/);
    const bytes = b64ToBytes(s);
    return new Blob([bytes], { type: (head && head[1]) || mime || sniff(bytes) || 'image/jpeg' });
  },
  /** the bigger picture brought down to the smaller one's size: its fine detail relative to the smaller
      one's (≈1 or more: as sharp; clearly below 1: a stretched copy of something smaller). null: no detail to judge by */
  async sharperAt({ big, small, crop = 800 }) {
    const A = await createImageBitmap(big), B = await createImageBitmap(small);
    try {
      const bw = B.width, bh = B.height, c = Math.min(bw, bh, crop);
      const ox = (bw - c) / 2, oy = (bh - c) / 2;
      const cb = new OffscreenCanvas(c, c); cb.getContext('2d').drawImage(B, ox, oy, c, c, 0, 0, c, c);
      const full = new OffscreenCanvas(bw, bh), fx = full.getContext('2d'); fx.imageSmoothingQuality = 'high'; fx.drawImage(A, 0, 0, bw, bh);
      const ca = new OffscreenCanvas(c, c); ca.getContext('2d').drawImage(full, ox, oy, c, c, 0, 0, c, c);
      const da = fineDetail(ca, c), db = fineDetail(cb, c);
      if (db.abs < 0.6 || db.rel < 0.004) return null;          // a flat picture: nothing to compare
      return +(da.rel / db.rel).toFixed(3);
    } finally { A.close(); B.close(); }
  },
  /** perceptual signature: 8×8 difference hash + 4×4 colour grid of the central 92 % */
  async signature({ blob }) {
    const bmp = await createImageBitmap(blob, { resizeWidth: 64, resizeHeight: 64, resizeQuality: 'high' });
    const c = new OffscreenCanvas(64, 64); const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0); bmp.close();
    const s = new OffscreenCanvas(9, 8); const sx = s.getContext('2d', { willReadFrequently: true }); sx.imageSmoothingQuality = 'high';
    sx.drawImage(c, 2.5, 2.5, 59, 59, 0, 0, 9, 8);
    const d = sx.getImageData(0, 0, 9, 8).data;
    const g = []; for (let i = 0; i < d.length; i += 4) g.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    const bits = []; for (let y = 0; y < 8; y++) for (let xx = 0; xx < 8; xx++) bits.push(g[y * 9 + xx] < g[y * 9 + xx + 1] ? 1 : 0);
    const k = new OffscreenCanvas(4, 4); const kx = k.getContext('2d', { willReadFrequently: true }); kx.imageSmoothingQuality = 'high';
    kx.drawImage(c, 2.5, 2.5, 59, 59, 0, 0, 4, 4);
    const cd = kx.getImageData(0, 0, 4, 4).data;
    const grid = []; for (let i = 0; i < cd.length; i += 4) grid.push([cd[i], cd[i + 1], cd[i + 2]]);
    return { bits, grid };
  },
};

