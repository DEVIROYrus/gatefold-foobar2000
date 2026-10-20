/*
 * Gatefold · colors.js — the colour of every cover, for Library → «By cover colour».
 *
 * Each album gets one colour, the one a person would name when looking at the cover: pixels are
 * grouped by hue in OKLab, weighted by how vivid they are, and the strongest hue wins; a cover
 * that is mostly grey, black or white is «neutral» and keeps only its lightness. Covers are read
 * as tiny 20 px thumbnails in the background, a few per frame, and the result is kept on disk
 * (IndexedDB), so the wall is instant the next time and only new albums are looked at.
 */
import { call, ok, artUrl, albumKeyOf, log } from './bridge.js';
import { slot, spent } from './sched.js';
import * as IDB from './idb.js';

const STORE = 'colorwall.v1';
const map = new Map();                 // album key → [L, C, h]  (C = 0: neutral)
let loaded = null, running = null;
export const events = new EventTarget();
export const state = { done: 0, total: 0, running: false };

const keyOf = (a) => albumKeyOf(a.albumArtist || a.artist || '', a.name);
export const colorOf = (a) => {
  let c = map.get(keyOf(a));
  if (!c && a.parts) for (const p of a.parts) { c = map.get(albumKeyOf(p.albumArtist, p.name)); if (c) break; }
  return c || null;
};
export const NEUTRAL_C = 0.035;
export const isNeutral = (c) => !c || c[1] < NEUTRAL_C;

async function load() {
  if (!loaded) loaded = IDB.kvGet(STORE, null).then((o) => { if (o) for (const [k, v] of Object.entries(o)) map.set(k, v); });
  return loaded;
}
let saveT = 0;
function save() { clearTimeout(saveT); saveT = setTimeout(() => IDB.kvSet(STORE, Object.fromEntries(map)), 1500); }

/* ---------------------------------------------------------------- colour science (OKLab) */
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
function oklab(r, g, b) {
  r = lin(r); g = lin(g); b = lin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const BINS = 24;
/** RGBA pixels → [L, C, h] (C 0 when the cover is essentially without colour) */
export function dominant(data) {
  const w = new Float64Array(BINS), sL = new Float64Array(BINS), sa = new Float64Array(BINS), sb = new Float64Array(BINS);
  let nL = 0, n = 0, chromaPx = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const [L, a, b] = oklab(data[i], data[i + 1], data[i + 2]);
    const C = Math.hypot(a, b);
    n++; nL += L;
    if (C < NEUTRAL_C || L < 0.12) continue;
    chromaPx++;
    const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    const k = Math.floor(h / (360 / BINS)) % BINS;
    const wt = C * (0.6 + 0.4 * Math.min(1, L / 0.5));   // vivid and not murky counts most
    w[k] += wt; sL[k] += L * wt; sa[k] += a * wt; sb[k] += b * wt;
  }
  if (!n) return [0.5, 0, 0];
  if (chromaPx / n < 0.12) return [nL / n, 0, 0];
  let best = 0, bestW = -1;
  for (let k = 0; k < BINS; k++) { const ww = w[(k + BINS - 1) % BINS] * 0.5 + w[k] + w[(k + 1) % BINS] * 0.5; if (ww > bestW) { bestW = ww; best = k; } }
  let W = 0, L = 0, A = 0, B = 0;
  for (const k of [(best + BINS - 1) % BINS, best, (best + 1) % BINS]) { W += w[k]; L += sL[k]; A += sa[k]; B += sb[k]; }
  const a = A / W, b = B / W;
  return [L / W, Math.hypot(a, b), (Math.atan2(b, a) * 180 / Math.PI + 360) % 360];
}
/** a CSS colour for an index entry */
export const css = (c) => (c ? `oklch(${(c[0] * 100).toFixed(1)}% ${Math.min(0.25, c[1]).toFixed(3)} ${c[2].toFixed(0)})` : 'transparent');

async function pixels(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const bmp = await createImageBitmap(await resp.blob(), { resizeWidth: 20, resizeHeight: 20, resizeQuality: 'medium' });
    const c = new OffscreenCanvas(20, 20); const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0); bmp.close && bmp.close();
    return x.getImageData(0, 0, 20, 20).data;
  } catch { return null; }
}

/** colours for every album that has none yet; resolves when done (or superseded) */
export async function ensure(albums) {
  await load();
  const todo = albums.filter((a) => a.firstTrackAbsolutePath && !colorOf(a));
  state.total = albums.length; state.done = albums.length - todo.length;
  if (!todo.length) { events.dispatchEvent(new Event('progress')); return; }
  if (running) return running;
  state.running = true;
  running = (async () => {
    for (let i = 0; i < todo.length; i += 24) {
      const chunk = todo.slice(i, i + 24);
      const r = await call('artwork.getFb2kUrlByPathBatch', { paths: chunk.map((a) => a.firstTrackAbsolutePath), maxSize: 48 });
      const arr = (ok(r) && (r.artworks || r.items || r.results)) || [];
      for (let k = 0; k < chunk.length; k++) {
        await slot('low');
        const t0 = performance.now();
        const it = arr[k];
        const url = it && it.available !== false ? artUrl(it.dataUrl || it.url || '') : '';
        const px = url ? await pixels(url) : null;
        map.set(keyOf(chunk[k]), px ? dominant(px).map((v) => Math.round(v * 1000) / 1000) : [0.5, 0, 0]);
        state.done++;
        spent(performance.now() - t0);
      }
      save();
      events.dispatchEvent(new Event('progress'));
    }
  })().catch((e) => log('colors', e)).finally(() => { running = null; state.running = false; events.dispatchEvent(new Event('progress')); });
  return running;
}

/* order: a rainbow starting at red, each hue light to dark; neutral covers after it, white to black */
const START = 15;
export function compare(a, b) {
  const ca = colorOf(a), cb = colorOf(b);
  if (!ca || !cb) return (ca ? 0 : 1) - (cb ? 0 : 1);
  const na = isNeutral(ca), nb = isNeutral(cb);
  if (na !== nb) return na ? 1 : -1;
  if (na) return cb[0] - ca[0];
  const ha = (ca[2] - START + 360) % 360, hb = (cb[2] - START + 360) % 360;
  const ba = Math.floor(ha / 10), bb = Math.floor(hb / 10);
  return ba - bb || cb[0] - ca[0] || ha - hb;
}
/** does the album belong to the swatch (a hue, or 'neutral') */
export function matches(a, sw) {
  const c = colorOf(a);
  if (!c) return false;
  if (sw === 'neutral') return isNeutral(c);
  if (isNeutral(c)) return false;
  const d = Math.abs(((c[2] - sw + 540) % 360) - 180);
  return d <= 18;
}
