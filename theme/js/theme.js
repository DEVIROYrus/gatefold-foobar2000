/*
 * Gatefold · theme.js — turns album art into the live UI palette.
 *
 * Art acquisition (in order, first that yields readable pixels wins):
 *   1. fb2k://artwork URL at 128px via fetch() → Blob → ImageBitmap (never taints canvas)
 *   2. same URL via <img> + canvas (works if the scheme is same-origin-ish)
 *   3. data: URL from artwork.getCurrent / getForTrack (always readable, heavier)
 * Clusters (not palettes) are cached per album, so changing intensity or
 * light/dark mode re-derives the palette instantly without touching the image.
 */
import { call, ok, albumKeyOf, log, artUrl } from './bridge.js';
import { settings, JsonStore } from './settings.js';

import { $t } from './i18n.js';
const PC = window.PaletteCore;
const clusterCache = new JsonStore('aurora.clusters.v2', 1200);
const blurCache = new Map(); // key → small blurred PNG (memory only)

let worker = null, seq = 0;
const pending = new Map();
try {
  worker = new Worker('js/palette-worker.js');
  worker.onmessage = (e) => { const r = pending.get(e.data.id); if (r) { pending.delete(e.data.id); r(e.data); } };
  worker.onerror = (e) => { log('palette worker failed, using main thread', e.message); worker = null; for (const r of pending.values()) r({ ok: false }); pending.clear(); };
} catch { worker = null; }

function analyzePixels(data, w, h) {
  if (worker) {
    return new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      const buf = data.buffer.slice(0);
      worker.postMessage({ id, buffer: buf, w, h, opts: {} }, [buf]);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(mainThread()); } }, 1500);
    }).then((r) => (r && r.ok ? r.clusters : mainThread()));
  }
  return Promise.resolve(mainThread());
  function mainThread() { return PC.analyze(data, w, h, {}).clusters; }
}

function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('img load failed'));
    im.src = url;
  });
}

/** Returns { data, w, h, blur } or throws. */
async function pixelsFrom(url) {
  let src = null;
  try {
    const resp = await fetch(url);
    if (resp.ok) src = await createImageBitmap(await resp.blob(), { resizeWidth: 64, resizeHeight: 64, resizeQuality: 'high' });
  } catch { /* fall through */ }
  if (!src) src = await loadImg(url);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0, 64, 64);
  const data = x.getImageData(0, 0, 64, 64).data; // throws SecurityError if tainted
  if (src.close) src.close();
  // Pre-blurred backdrop: blurring once here costs ~0.2 ms; a CSS blur() on a
  // full-window layer would be re-evaluated by the compositor on every frame
  // the aurora animates above it.
  const b = document.createElement('canvas');
  b.width = b.height = 40;
  const bx = b.getContext('2d');
  bx.filter = 'blur(3px) saturate(1.15)';
  bx.drawImage(c, -6, -6, 52, 52);
  return { data, w: 64, h: 64, blur: b.toDataURL('image/png') };
}

async function tryPixels(urls) {
  for (const u of urls) {
    if (!u) continue;
    try { return await pixelsFrom(u); } catch { /* next */ }
  }
  return null;
}

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** A stable, pleasant pseudo-palette for albums without art (hue from album name). */
function syntheticClusters(seed) {
  const h = hash(seed || 'aurora') % 360;
  const mk = (L, C, hh, share) => { const [a, b] = [C * Math.cos(hh * Math.PI / 180), C * Math.sin(hh * Math.PI / 180)]; return { L, C, h: hh, share, lab: [L, a, b] }; };
  return [mk(0.28, 0.05, h, 0.55), mk(0.62, 0.13, (h + 30) % 360, 0.25), mk(0.45, 0.09, (h + 320) % 360, 0.2)];
}

/* ---------------------------------------------------------------- fixed themes
   For people who want a calm, constant interface instead of one that follows the cover.
   Values are OKLCH; text/background pairs are checked to WCAG AA (normal text ≥ 4.5:1),
   secondary text ≥ 4.5:1, tertiary ≥ 3:1, accent on its surfaces ≥ 3:1. */
export const FIXED = {
  dark: {   // soft blue-black, never pure #000 (less halation on bright text), periwinkle accent
    dark: true, name: $t('Тёмная'),
    bg: [0.172, 0.012, 266], surface: [0.207, 0.013, 266], surface2: [0.247, 0.014, 266],
    text: [0.93, 0.008, 266], text2: [0.795, 0.012, 266], text3: [0.655, 0.014, 266],
    accent: [0.74, 0.12, 270], accentInk: [0.82, 0.095, 270], accent2: [0.76, 0.09, 205], onAccent: [0.18, 0.03, 270], glow: [0.56, 0.11, 270],
    blobs: [[0.27, 0.035, 266], [0.3, 0.045, 285], [0.25, 0.03, 225], [0.31, 0.05, 270]],
  },
  light: {  // warm paper white (not blue-white), ink text, deep indigo accent
    dark: false, name: $t('Светлая'),
    bg: [0.972, 0.005, 85], surface: [0.993, 0.003, 85], surface2: [0.94, 0.007, 85],
    text: [0.235, 0.012, 266], text2: [0.42, 0.013, 266], text3: [0.53, 0.012, 266],
    accent: [0.53, 0.17, 268], accentInk: [0.47, 0.17, 268], accent2: [0.56, 0.11, 200], onAccent: [0.99, 0.004, 268], glow: [0.64, 0.12, 268],
    blobs: [[0.93, 0.02, 85], [0.92, 0.03, 268], [0.94, 0.022, 205], [0.9, 0.035, 268]],
  },
  gray: {   // graphite: neutral mid-dark grey, silver accent — monochrome, nothing competes with cover art
    dark: true, name: $t('Серая'),
    bg: [0.262, 0.003, 250], surface: [0.298, 0.003, 250], surface2: [0.338, 0.004, 250],
    text: [0.94, 0.003, 250], text2: [0.83, 0.003, 250], text3: [0.708, 0.004, 250],
    accent: [0.88, 0.006, 250], accentInk: [0.93, 0.004, 250], accent2: [0.74, 0.01, 250], onAccent: [0.22, 0.004, 250], glow: [0.62, 0.006, 250],
    blobs: [[0.33, 0.004, 250], [0.36, 0.005, 250], [0.31, 0.003, 250], [0.38, 0.006, 250]],
  },
};
const fcss = (L, C, h) => `oklch(${(L * 100).toFixed(1)}% ${C.toFixed(4)} ${h.toFixed(1)})`;
const fpack = ([L, C, h]) => ({ css: fcss(L, C, h), hex: PC.srgbHex(PC.lchToSrgb(L, C, h)), L, C, h });
export function fixedPalette(id) {
  if (id === 'custom') return customPalette(settings.customTheme);
  const d = FIXED[id]; if (!d) return null;
  const p = { dark: d.dark, monochrome: id === 'gray', fixed: id, stats: {}, blobs: d.blobs.map(fpack) };
  for (const k of VARS) p[k] = fpack(d[k]);
  p.swatches = ['bg', 'surface', 'surface2', 'text3', 'text2', 'text', 'accent', 'accent2'].map((k) => ({ hex: p[k].hex, share: 0.125 }));
  return p;
}
export const fixedId = () => (settings.colorSource && (FIXED[settings.colorSource] || (settings.colorSource === 'custom' && settings.customTheme)) ? settings.colorSource : null);

/* ---------------------------------------------------------------- colours you chose
   · an album's own colours (album page → «Цвета…»): an accent, and a background tint if you like —
     kept for that album (or that edition) instead of the ones read from its cover;
   · «Своя тема»: your background and accents, constant like the fixed themes.
   Both go through the same palette builder, so text keeps its contrast whatever is picked, and an
   accent too close to the background is moved just enough to stay visible (palette.adjusted says by how much). */
export function hexToLch(hex) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i); if (!m) return null;
  let x = m[1]; if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => PC.srgbToLinear(parseInt(x.slice(i, i + 2), 16) / 255));
  const [L, a, bb] = PC.linearRgbToOklab(r, g, b);
  return PC.toLch(L, a, bb);
}
const ovOpts = (ov) => {
  if (!ov) return {};
  const o = {}; for (const k of ['accent', 'accent2', 'bg']) { const c = ov[k] && hexToLch(ov[k]); if (c) o[k] = c; }
  return o;
};
/** the clusters a palette is built from when there is no cover (your theme: your colours) */
const clustersOf = (ov) => {
  const o = ovOpts(ov), out = [];
  if (o.bg) out.push({ ...o.bg, share: 0.7, lab: [o.bg.L, 0, 0] });
  if (o.accent) out.push({ ...o.accent, share: 0.2, lab: [o.accent.L, 0, 0] });
  if (o.accent2) out.push({ ...o.accent2, share: 0.1, lab: [o.accent2.L, 0, 0] });
  return out;
};
export function customPalette(t) {
  if (!t || !t.accent) return null;
  const o = ovOpts(t);
  const p = PC.buildPalette(clustersOf(t), { mode: o.bg ? 'auto' : settings.themeMode, intensity: 1, ...o });
  p.fixed = 'custom';
  return p;
}
/** the colours you set for an album (key: its edition's key or albumKeyOf(artist, album)), or null */
export const albumColorsFor = (...keys) => { const m = settings.albumColors || {}; for (const k of keys) if (k && m[k]) return m[k]; return null; };
let editionKey = () => '';
/** library.js tells which edition a track belongs to (an edition has colours of its own) */
export const setEditionKeyResolver = (fn) => { editionKey = fn; };
/** the cache key of a track's album: its edition when the album has several (each its own cover) */
const keyOf = (track) => (track ? editionKey(track) || albumKeyOf(track.albumArtist, track.album) : '');
const trackOv = (track) => (track ? albumColorsFor(editionKey(track), albumKeyOf(track.albumArtist, track.album)) : null);
let curOv = null;
function applyFixed() { const p = fixedPalette(fixedId()); applyPalette(p); setBackdrop(null); return p; }

function opts() {
  return { mode: settings.themeMode, intensity: settings.colorIntensity };
}

export function paletteFromClusters(clusters, ov = curOv) {
  return PC.buildPalette(clusters.map((c) => ({ ...c })), { ...opts(), ...ovOpts(ov) });
}

const VARS = ['bg', 'surface', 'surface2', 'text', 'text2', 'text3', 'accent', 'accentInk', 'accent2', 'onAccent', 'glow'];
const cssName = (k) => '--' + k.replace(/[A-Z0-9]/g, (m) => '-' + m.toLowerCase());

export function applyPalette(p, el = document.documentElement) {
  const st = el.style;
  for (const k of VARS) st.setProperty(cssName(k), p[k].css);
  // untouched album colours for interface skins, which override the live tokens with !important
  if (el === document.documentElement) for (const k of VARS) st.setProperty('--src' + cssName(k).slice(1), p[k].css);
  p.blobs.forEach((b, i) => st.setProperty(`--blob-${i + 1}`, b.css));
  if (el === document.documentElement) {
    el.dataset.scheme = p.dark ? 'dark' : 'light';
    st.colorScheme = p.dark ? 'dark' : 'light';
    current.palette = p;
    for (const fn of listeners) fn(p);
  }
}

const listeners = new Set();
export const onPalette = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const current = { palette: null, key: '', clusters: null, artUrl: '' };

let bgFlip = false;
function setBackdrop(blur) {
  const a = document.querySelector('#bg .bg-art.a'), b = document.querySelector('#bg .bg-art.b');
  if (!a || !b) return;
  const [show, hide] = bgFlip ? [a, b] : [b, a];
  bgFlip = !bgFlip;
  show.style.backgroundImage = blur ? `url("${blur}")` : 'none';
  show.classList.add('on');
  hide.classList.remove('on');
}

/**
 * Theme the whole UI for a track. `artUrl` is what the caller already
 * displays (fb2k:// URL or data:); we fetch a 128px variant for analysis.
 */
let themeToken = 0;
let lastTrack = null, lastArt = null;
export async function themeForTrack(track, artInfo) {
  const token = ++themeToken;
  lastTrack = track; lastArt = artInfo;
  if (fixedId()) { if (current.key !== 'fixed:' + fixedId()) { current.key = 'fixed:' + fixedId(); applyFixed(); } return; }
  const key = keyOf(track) || 'none';
  curOv = trackOv(track);
  const cached = clusterCache.get(key);
  if (cached && current.key !== key) {
    current.key = key; current.clusters = cached;
    applyPalette(paletteFromClusters(cached));
    if (blurCache.has(key)) setBackdrop(blurCache.get(key));
  }

  // computed from this very cover earlier in the session (e.g. prefetched while the
  // previous track played) → nothing to fetch or analyse
  if (cached && fresh.has(key) && blurCache.has(key) && artInfo && artInfo.available) {
    if (current.key !== key) { current.key = key; current.clusters = cached; applyPalette(paletteFromClusters(cached)); }
    setBackdrop(blurCache.get(key));
    return;
  }

  if (!artInfo || !artInfo.available) {
    if (!cached) {
      const cl = syntheticClusters(key);
      current.key = key; current.clusters = cl;
      applyPalette(paletteFromClusters(cl));
    }
    setBackdrop(null);
    return;
  }

  const urls = [artInfo.small, artInfo.url];
  let px = await tryPixels(urls);
  if (!px && track?.path) {
    const r = await call('artwork.getCurrent', { type: 'front' });
    if (ok(r) && r.dataUrl) px = await tryPixels([r.dataUrl]);
  }
  if (token !== themeToken) return; // a newer track won the race
  if (!px) { log('palette: no readable pixels'); return; }
  blurCache.set(key, px.blur);
  if (blurCache.size > 60) blurCache.delete(blurCache.keys().next().value);
  setBackdrop(px.blur);

  const clusters = await analyzePixels(px.data, px.w, px.h);
  if (token !== themeToken) return;
  const slim = clusters.map((c) => ({ L: +c.L.toFixed(4), C: +c.C.toFixed(4), h: +c.h.toFixed(1), share: +c.share.toFixed(4), lab: c.lab.map((v) => +v.toFixed(4)) }));
  clusterCache.set(key, slim);
  fresh.add(key);
  current.key = key; current.clusters = slim;
  applyPalette(paletteFromClusters(slim));
}

const fresh = new Set();
export const forgetFresh = (key) => (key ? fresh.delete(key) : fresh.clear());
/** Palette + blurred backdrop of an album that is about to play (next in queue). */
export async function prefetchAlbum(track, smallUrl) {
  const key = keyOf(track);
  if (!key || fresh.has(key) || !smallUrl) return false;
  const px = await tryPixels([smallUrl]);
  if (!px) return false;
  blurCache.set(key, px.blur);
  if (blurCache.size > 60) blurCache.delete(blurCache.keys().next().value);
  const clusters = await analyzePixels(px.data, px.w, px.h);
  clusterCache.set(key, clusters.map((c) => ({ L: +c.L.toFixed(4), C: +c.C.toFixed(4), h: +c.h.toFixed(1), share: +c.share.toFixed(4), lab: c.lab.map((v) => +v.toFixed(4)) })));
  fresh.add(key);
  return true;
}

/** Theme from an image we already hold (e.g. a cover the fetcher just saved). */
export async function themeFromUrl(track, url) {
  if (fixedId()) return;
  const px = await tryPixels([url]);
  if (!px) return;
  const key = keyOf(track);
  curOv = trackOv(track);
  blurCache.set(key, px.blur);
  setBackdrop(px.blur);
  const clusters = await analyzePixels(px.data, px.w, px.h);
  clusterCache.set(key, clusters.map((c) => ({ L: c.L, C: c.C, h: c.h, share: c.share, lab: c.lab })));
  fresh.add(key);
  current.key = key; current.clusters = clusters;
  applyPalette(paletteFromClusters(clusters));
}

/** Palette for an arbitrary album (album page) — scoped, not global. */
export async function paletteForAlbum(artist, album, path, edKey = '') {
  if (fixedId()) return fixedPalette(fixedId());
  const key = albumKeyOf(artist, album);
  const ov = albumColorsFor(edKey, key);
  const cl = await albumClusters(edKey || key, path);
  return paletteFromClusters(cl || syntheticClusters(key), ov);
}
/** the colour clusters of an album's cover (cached), or null */
export async function albumClusters(key, path) {
  let cl = clusterCache.get(key);
  if (!cl && path) {
    const r = await call('artwork.getFb2kUrlByPath', { path, maxSize: 128 });
    let px = ok(r) && r.available !== false && r.dataUrl ? await tryPixels([artUrl(r.dataUrl)]) : null;
    if (!px) {
      const d = await call('artwork.getForTrack', { path });
      if (ok(d) && d.available !== false && d.dataUrl) px = await tryPixels([d.dataUrl]);
    }
    if (px) {
      cl = await analyzePixels(px.data, px.w, px.h);
      clusterCache.set(key, cl.map((c) => ({ L: c.L, C: c.C, h: c.h, share: c.share, lab: c.lab })));
    }
  }
  return cl || null;
}

/** Palette of any readable image URL (data:, blob:, same-origin) — e.g. a YouTube thumbnail. */
const urlPalettes = new Map();
export async function paletteFromImage(url, key = url) {
  if (fixedId()) return fixedPalette(fixedId());
  if (urlPalettes.has(key)) return urlPalettes.get(key);
  const px = await tryPixels([url]);
  const p = paletteFromClusters(px ? await analyzePixels(px.data, px.w, px.h) : syntheticClusters(key));
  urlPalettes.set(key, p); if (urlPalettes.size > 60) urlPalettes.delete(urlPalettes.keys().next().value);
  return p;
}

/** the colours you set changed: the playing album takes them at once */
export function reapply() {
  curOv = trackOv(lastTrack);
  if (fixedId()) { applyFixed(); return; }
  if (current.clusters) applyPalette(paletteFromClusters(current.clusters));
}
/** a cluster as #rrggbb (the swatches of a cover) */
export const clusterHex = (c) => PC.srgbHex(PC.lchToSrgb(c.L, c.C, c.h));
/** the palette an album would get with these colours (the editor's preview) */
export async function previewPalette(a, ov) {
  const key = albumKeyOf(a.albumArtist, a.name);
  const cl = await albumClusters(a.edKey || key, a.firstTrackAbsolutePath);
  return { palette: paletteFromClusters(cl || syntheticClusters(key), ov), clusters: cl || [] };
}
/** Re-derive from cached clusters after a settings change (instant). */
export function rebuild() {
  if (fixedId()) { applyFixed(); return; }
  if (current.clusters) applyPalette(paletteFromClusters(current.clusters));
}
/** colour source switched (album ↔ fixed theme): re-theme from scratch */
export function refreshSource() {
  current.key = '';
  curOv = trackOv(lastTrack);
  if (fixedId()) { current.key = 'fixed:' + fixedId(); applyFixed(); return; }
  if (lastTrack || lastArt) themeForTrack(lastTrack, lastArt);
  else applyPalette(paletteFromClusters(syntheticClusters('aurora')));
}
// a fixed theme is painted as soon as the module loads — no album colours flash first
if (fixedId()) { current.key = 'fixed:' + fixedId(); queueMicrotask(applyFixed); }
