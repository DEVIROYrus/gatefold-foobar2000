/*
 * Gatefold · colors.js — the colour of every cover, for Library → «By cover colour».
 *
 * Each album gets the colour a person would name when looking at the cover — one of twelve:
 * red, orange, yellow, green, teal, blue, purple, pink, brown, white, grey, black. Every pixel of
 * a small thumbnail is named in OKLCH (perceptual lightness, chroma, hue — the hue borders sit where
 * the colour names change, not at equal steps), and the name with the most «visual weight» wins:
 * vivid pixels weigh more than dull ones, the centre more than a frame. Light, low-chroma warm
 * tones — skin, cream paper, beige — count as white, so a white cover with two faces on it is not
 * «orange». A strong second colour (≥ 20 % of the cover) is kept too: the cover also shows up there,
 * after the covers of which it is the main colour. Covers are read in the background a few per
 * frame and the result is kept on disk (IndexedDB), so only new albums are looked at.
 */
import { call, ok, artUrl, albumKeyOf, log } from './bridge.js';
import { slot, spent } from './sched.js';
import * as IDB from './idb.js';

const STORE = 'colorwall.v2';
const map = new Map();                 // album key → [cat, second (-1), L, C, h]
let loaded = null, running = null;
export const events = new EventTarget();
export const state = { done: 0, total: 0, running: false };

/* the twelve names, in wall order, with the swatch drawn for each */
export const CATS = [
  { id: 'red', sw: 'oklch(58% 0.21 28)' }, { id: 'orange', sw: 'oklch(72% 0.17 55)' }, { id: 'yellow', sw: 'oklch(88% 0.17 100)' },
  { id: 'green', sw: 'oklch(64% 0.16 145)' }, { id: 'teal', sw: 'oklch(68% 0.11 200)' }, { id: 'blue', sw: 'oklch(55% 0.17 260)' },
  { id: 'purple', sw: 'oklch(52% 0.18 305)' }, { id: 'pink', sw: 'oklch(74% 0.16 350)' }, { id: 'brown', sw: 'oklch(45% 0.08 55)' },
  { id: 'white', sw: 'oklch(96% 0.005 90)' }, { id: 'grey', sw: 'oklch(62% 0 0)' }, { id: 'black', sw: 'oklch(18% 0 0)' },
];
const IDX = Object.fromEntries(CATS.map((c, i) => [c.id, i]));
const N = CATS.length, NEUTRAL = new Set([IDX.white, IDX.grey, IDX.black]);

const keyOf = (a) => albumKeyOf(a.albumArtist || a.artist || '', a.name);
export const colorOf = (a) => {
  let c = map.get(keyOf(a));
  if (!c && a.parts) for (const p of a.parts) { c = map.get(albumKeyOf(p.albumArtist, p.name)); if (c) break; }
  return c || null;
};

async function load() {
  if (!loaded) loaded = IDB.kvGet(STORE, null).then((o) => { if (o) for (const [k, v] of Object.entries(o)) map.set(k, v); IDB.kvDel('colorwall.v1'); });
  return loaded;
}
let saveT = 0;
function save() { clearTimeout(saveT); saveT = setTimeout(() => IDB.kvSet(STORE, Object.fromEntries(map)), 1500); }

/* ---------------------------------------------------------------- colour science (OKLab / OKLCH) */
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const v = i / 255; LIN[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
function oklab(r, g, b) {
  r = LIN[r]; g = LIN[g]; b = LIN[b];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
/** the name of one colour (OKLCH: L 0…1, C, h in degrees) */
export function nameOf(L, C, h) {
  // a light colour needs more chroma before it reads as a colour; warm light low-chroma = skin, cream, beige
  const cMin = 0.04 + 0.035 * Math.max(0, L - 0.6) / 0.4;
  const neutral = L < 0.17 || C < cMin || (L > 0.72 && C < 0.095 && h > 25 && h < 105) || (L < 0.26 && C < 0.07);
  if (neutral) return L < 0.3 ? IDX.black : L > 0.84 || (L > 0.72 && C >= cMin) ? IDX.white : IDX.grey;
  if ((h >= 40 && h < 100 && L < 0.58 && C < 0.17) || (h >= 20 && h < 40 && L < 0.5 && C < 0.1)) return IDX.brown;
  if (h >= 330 || h < 10) return IDX.pink;
  if (h < 44) return L > 0.78 && C < 0.14 ? IDX.pink : IDX.red;      // light red reads as pink (salmon, rose)
  if (h < 78) return IDX.orange;
  if (h < 118) return L < 0.6 ? IDX.brown : IDX.yellow;            // dark yellow is olive / brown
  if (h < 170) return IDX.green;
  if (h < 230) return IDX.teal;
  if (h < 285) return IDX.blue;
  return IDX.purple;
}
/** RGBA pixels of a square thumbnail → [cat, second, L, C, h] */
export function classify(data, side) {
  const w = new Float64Array(N), raw = new Float64Array(N), sL = new Float64Array(N), sa = new Float64Array(N), sb = new Float64Array(N);
  let total = 0, n = 0;
  side = side || Math.round(Math.sqrt(data.length / 4));
  const half = (side - 1) / 2 || 1;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < 128) continue;
    const [L, a, b] = oklab(data[i], data[i + 1], data[i + 2]);
    const C = Math.hypot(a, b), h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    const k = nameOf(L, C, h);
    const x = (p % side) / half - 1, y = Math.floor(p / side) / half - 1;
    const centre = 1.25 - 0.35 * Math.min(1, Math.hypot(x, y) / 1.2);       // a frame counts less than the picture
    const vivid = NEUTRAL.has(k) ? 0.62 : Math.min(1.4, 0.55 + 3 * C);       // vivid colour catches the eye
    const wt = centre * vivid;
    w[k] += wt; raw[k] += 1; total += wt; n++;
    sL[k] += L; sa[k] += a; sb[k] += b;
  }
  if (!n) return [IDX.grey, -1, 0.5, 0, 0];
  let best = 0, second = -1;
  for (let k = 1; k < N; k++) if (w[k] > w[best]) best = k;
  for (let k = 0; k < N; k++) if (k !== best && (second < 0 || w[k] > w[second])) second = k;
  if (second >= 0 && !(w[second] >= 0.6 * w[best] && raw[second] / n >= 0.2)) second = -1;
  const c = raw[best] || 1, A = sa[best] / c, B = sb[best] / c;
  return [best, second, sL[best] / c, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
}
/** a CSS colour for an index entry */
export const css = (c) => (c ? `oklch(${(c[2] * 100).toFixed(1)}% ${Math.min(0.25, c[3]).toFixed(3)} ${c[4].toFixed(0)})` : 'transparent');

const SIDE = 32;
async function pixels(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const bmp = await createImageBitmap(await resp.blob(), { resizeWidth: SIDE, resizeHeight: SIDE, resizeQuality: 'medium' });
    const c = new OffscreenCanvas(SIDE, SIDE); const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0); bmp.close && bmp.close();
    return x.getImageData(0, 0, SIDE, SIDE).data;
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
      await slot('low');
      const t0 = performance.now();
      const r = await call('artwork.getFb2kUrlByPathBatch', { paths: chunk.map((a) => a.firstTrackAbsolutePath), maxSize: 64 });
      spent(performance.now() - t0);
      const arr = (ok(r) && (r.artworks || r.items || r.results)) || [];
      // decoding the thumbnails happens off the bridge: several at once, then a short breather
      await Promise.all(chunk.map(async (a, k) => {
        const it = arr[k];
        const url = it && it.available !== false ? artUrl(it.dataUrl || it.url || '') : '';
        const px = url ? await pixels(url) : null;
        map.set(keyOf(a), px ? classify(px, SIDE).map((v, j) => (j < 2 ? v : Math.round(v * 1000) / 1000)) : [IDX.grey, -1, 0.5, 0, 0]);
        state.done++;
      }));
      save();
      events.dispatchEvent(new Event('progress'));
    }
  })().catch((e) => log('colors', e)).finally(() => { running = null; state.running = false; events.dispatchEvent(new Event('progress')); });
  return running;
}

/* order: the twelve names in wall order; inside a name light to dark, then by hue */
export function compare(a, b) {
  const ca = colorOf(a), cb = colorOf(b);
  if (!ca || !cb) return (ca ? 0 : 1) - (cb ? 0 : 1);
  return ca[0] - cb[0] || cb[2] - ca[2] || ca[4] - cb[4];
}
/** does the album belong to colour `id` — as its main colour (2) or a strong second one (1); 0 otherwise */
export function matches(a, id) {
  const c = colorOf(a), k = IDX[id];
  if (!c || k == null) return 0;
  return c[0] === k ? 2 : c[1] === k ? 1 : 0;
}
/** how many albums of `albums` have each colour as their main one */
export function counts(albums) {
  const out = new Array(N).fill(0);
  for (const a of albums) { const c = colorOf(a); if (c) out[c[0]]++; }
  return out;
}
