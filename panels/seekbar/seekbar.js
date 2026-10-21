/*
 * Gatefold Seekbar — a waveform seek bar in the colours of the playing album, for any foobar2000
 * layout: a «WebView2 Panel» in Default UI or Columns UI with this template (gatefold-seekbar).
 * A separate add-on: it needs foo_ui_webview2, not the Gatefold interface. gf/ holds a few
 * modules copied unchanged from Gatefold (the bridge to foobar2000, the palette maths).
 *
 *   · the waveform comes from the component (audio.generateFullWaveform, cached by it);
 *   · colours: worked out from the cover (gf/palette-core.js), or a fixed dark / light / grey;
 *   · click or drag to seek, the wheel steps ±5 s (Shift ±30 s), middle click plays / pauses,
 *     ← / → when focused; right click: the panel's settings.
 *   · drawing: three pre-rendered layers (rest, played, hover) composited per frame, and a frame
 *     only when a pixel would change — an idle panel costs nothing.
 */
import './gf/input-guard.js';
import { waitForBridge, call, on, ok, normTrack, artUrl, fmtTime, log } from './gf/bridge.js';
import { follower } from './gf/position.js';

/* ---------------------------------------------------------------- language (English / Russian) */
const RU = {
  'Seekbar': 'Полоса перемотки', 'Position': 'Позиция', 'No connection to foobar2000': 'Нет связи с foobar2000',
  'Bars': 'Столбики', 'Solid': 'Сплошная', 'Line': 'Линия', 'Album': 'Из обложки', 'Dark': 'Тёмные', 'Light': 'Светлые', 'Grey': 'Серые',
  'Colour': 'Цветной', 'Transparent': 'Прозрачный', 'Elapsed / total': 'Прошло / всего', 'Remaining': 'Осталось', 'None': 'Нет',
  'Style': 'Вид', 'Colours': 'Цвета', 'Background': 'Фон', 'Time': 'Время', 'Show the cover': 'Показывать обложку',
  'Mouse wheel seeks': 'Колесо мыши перематывает', 'Reset this panel': 'Сбросить настройки панели',
};
const LANG = (() => {
  try { const l = (JSON.parse(localStorage.getItem('aurora.settings.v1') || '{}') || {}).language; if (l === 'ru' || l === 'en') return l; } catch {}
  for (const l of navigator.languages || [navigator.language || 'en']) { const b = String(l).toLowerCase().split('-')[0]; if (b === 'ru' || b === 'be' || b === 'kk') return 'ru'; if (b === 'en') return 'en'; }
  return 'en';
})();
const $t = (s) => (LANG === 'ru' && RU[s]) || s;
document.documentElement.lang = LANG;

/* ---------------------------------------------------------------- palettes */
const PC = window.PaletteCore;
const pack = ([L, C, h]) => ({ hex: PC.srgbHex(PC.lchToSrgb(L, C, h)) });
// the fixed themes of Gatefold (OKLCH, contrast-checked there)
const FIXED = {
  dark: { dark: true, bg: [0.172, 0.012, 266], surface: [0.207, 0.013, 266], text: [0.93, 0.008, 266], text2: [0.795, 0.012, 266], text3: [0.655, 0.014, 266], accent: [0.74, 0.12, 270], accent2: [0.76, 0.09, 205] },
  light: { dark: false, bg: [0.972, 0.005, 85], surface: [0.993, 0.003, 85], text: [0.235, 0.012, 266], text2: [0.42, 0.013, 266], text3: [0.53, 0.012, 266], accent: [0.53, 0.17, 268], accent2: [0.56, 0.11, 200] },
  gray: { dark: true, bg: [0.262, 0.003, 250], surface: [0.298, 0.003, 250], text: [0.94, 0.003, 250], text2: [0.83, 0.003, 250], text3: [0.708, 0.004, 250], accent: [0.88, 0.006, 250], accent2: [0.74, 0.01, 250] },
};
const KEYS = ['bg', 'surface', 'text', 'text2', 'text3', 'accent', 'accent2'];
function fixedPalette(id) { const f = FIXED[id]; const p = { dark: f.dark }; for (const k of KEYS) p[k] = pack(f[k]); return p; }
const hashStr = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; };
function synthetic(seed) {   // a stable palette for a track without a cover (hue from the album name)
  const h = hashStr(seed || 'gatefold') % 360;
  const mk = (L, C, hh, share) => ({ L, C, h: hh, share, lab: [L, C * Math.cos(hh * Math.PI / 180), C * Math.sin(hh * Math.PI / 180)] });
  return PC.buildPalette([mk(0.28, 0.05, h, 0.55), mk(0.62, 0.13, (h + 30) % 360, 0.25), mk(0.45, 0.09, (h + 320) % 360, 0.2)], { mode: 'auto', intensity: 1 });
}
const palCache = new Map();
async function albumPalette(url, key) {
  if (palCache.has(key)) return palCache.get(key);
  let p = null;
  try {
    const bm = await createImageBitmap(await (await fetch(url)).blob(), { resizeWidth: 64, resizeHeight: 64, resizeQuality: 'high' });
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bm, 0, 0, 64, 64); bm.close && bm.close();
    p = PC.buildPalette(PC.analyze(x.getImageData(0, 0, 64, 64).data, 64, 64, {}).clusters, { mode: 'auto', intensity: 1 });
  } catch (e) {
    // fb2k:// pixels unreadable: the cover as a data: URL instead
    const r = await call('artwork.getCurrent', { type: 'front' });
    if (ok(r) && r.dataUrl && r.dataUrl !== url) return albumPalette(r.dataUrl, key);
    log('seekbar: palette', e);
  }
  if (p) { palCache.set(key, p); if (palCache.size > 40) palCache.delete(palCache.keys().next().value); }
  return p;
}
const palListeners = new Set();
function applyPalette(p) {
  const r = document.documentElement.style;
  r.setProperty('--bg', p.bg.hex); r.setProperty('--surface', p.surface.hex); r.setProperty('--text', p.text.hex);
  r.setProperty('--text-2', p.text2.hex); r.setProperty('--text-3', p.text3.hex); r.setProperty('--accent', p.accent.hex);
  document.documentElement.dataset.scheme = p.dark ? 'dark' : 'light';
  for (const fn of palListeners) fn(p);
}
const Theme = { onPalette: (fn) => palListeners.add(fn) };
let palTok = 0;
async function themeFor(t, url) {
  const tok = ++palTok;
  if (P.colors !== 'album') { applyPalette(fixedPalette(P.colors)); return; }
  const key = t ? (t.albumArtist || t.artist || '') + '|' + (t.album || '') : 'none';
  const p = (url && await albumPalette(url, key)) || synthetic(key);
  if (tok === palTok) applyPalette(p);
}

/* placeholder cover: a two-hue gradient + initials */
function placeholder(name, artist) {
  const hh = hashStr((artist || '') + '|' + (name || '')) % 360;
  const ini = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '♪';
  return { bg: `linear-gradient(135deg, oklch(55% 0.13 ${hh}), oklch(32% 0.09 ${(hh + 50) % 360}))`, ini };
}

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dpr = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1));

/* ---------------------------------------------------------------- preferences (this panel's own) */
const PKEY = 'gatefold.seekbar.v1';
const DEF = { style: 'bars', colors: 'album', bg: 'album', time: 'both', cover: false, wheel: true };
const P = (() => { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(PKEY) || '{}') || {}) }; } catch { return { ...DEF }; } })();
const save = () => { try { localStorage.setItem(PKEY, JSON.stringify(P)); } catch {} };
const STYLES = ['bars', 'solid', 'line'], COLORS = ['album', 'dark', 'light', 'gray'], BGS = ['album', 'none'], TIMES = ['both', 'remaining', 'none'];

/* ---------------------------------------------------------------- playback state */
const S = { track: null, state: 'stopped', pos: 0, dur: 0, t0: performance.now(), hover: -1, drag: -1, isPanel: false };
const getPos = () => Math.min(S.dur || Infinity, S.state === 'playing' ? S.pos + (performance.now() - S.t0) / 1000 : S.pos);
const setPos = (p, d) => { S.pos = Math.max(0, +p || 0); S.t0 = performance.now(); if (d != null && +d > 0) S.dur = +d; kick(); };
const stateOf = (v) => { const x = String(v || '').toLowerCase(); return /play/.test(x) && !/pause/.test(x) ? 'playing' : /pause/.test(x) ? 'paused' : 'stopped'; };
// the ~10 Hz playback:timeHighRes drives the position (see gf/position.js); nothing moves the knob while it is dragged
const Pos = follower({ set: (p, d) => { if (S.drag < 0) setPos(p, d); else if (d != null && +d > 0) S.dur = +d; }, get: () => getPos(), playing: () => S.state === 'playing' });
const seekTo = (sec) => { if (!S.dur) return; sec = clamp(sec, 0, Math.max(0, S.dur - 0.25)); setPos(sec); Pos.seeked(sec); call('playback.setPosition', { position: sec }); };

/* ---------------------------------------------------------------- colours (eased between albums) */
const hexRgb = (h) => { const n = parseInt(String(h).replace('#', '').slice(0, 6), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
let col = null, colFrom = null, colTo = null, colT0 = 0;
const COL_MS = 420;
Theme.onPalette((p) => {
  const next = { a: hexRgb(p.accent.hex), b: hexRgb(p.accent2.hex), text: hexRgb(p.text.hex), text3: hexRgb(p.text3.hex), bg: hexRgb(p.bg.hex), dark: !!p.dark };
  if (!col) { col = next; dirty = true; kick(); return; }
  colFrom = col; colTo = next; colT0 = performance.now(); kick();
});
function stepColours(now) {
  if (!colTo) return false;
  const k = clamp((now - colT0) / COL_MS, 0, 1), e = k * k * (3 - 2 * k);
  const mix = (x, y) => x.map((v, i) => v + (y[i] - v) * e);
  col = { a: mix(colFrom.a, colTo.a), b: mix(colFrom.b, colTo.b), text: mix(colFrom.text, colTo.text), text3: mix(colFrom.text3, colTo.text3), bg: mix(colFrom.bg, colTo.bg), dark: colTo.dark };
  dirty = true;
  if (k >= 1) { col = colTo; colTo = colFrom = null; }
  return true;
}

/* ---------------------------------------------------------------- waveform data */
let wave = null, waveFor = '', waveTask = null, grow = 1, growT0 = 0;
function toPeaks(w) {
  if (!w) return null;
  if (w.peaks) w = w.peaks;
  if (w.data) w = w.data;
  if (!Array.isArray(w) || !w.length) return null;
  let out;
  if (Array.isArray(w[0])) { const len = w[0].length; out = new Float32Array(len); for (const ch of w) for (let i = 0; i < len; i++) out[i] = Math.max(out[i], Math.abs(+ch[i] || 0)); }
  else if (typeof w[0] === 'object') out = Float32Array.from(w, (p) => Math.max(Math.abs(+p.min || 0), Math.abs(+p.max || 0), Math.abs(+p.peak || 0), Math.abs(+p.rms || 0)));
  else out = Float32Array.from(w, (v) => Math.abs(+v || 0));
  let mx = 0; for (const v of out) mx = Math.max(mx, v);
  if (mx > 0) for (let i = 0; i < out.length; i++) out[i] = Math.pow(out[i] / mx, 0.8);
  return out;
}
function gotWave(w) { wave = toPeaks(w); grow = 0; growT0 = performance.now(); dirty = true; kick(); }
async function loadWave(t) {
  wave = null; waveTask = null; dirty = true; kick();
  if (!t || !t.path || /^https?:/i.test(t.path)) { waveFor = ''; return; }
  const key = t.handle || t.path; waveFor = key;
  const r = await call('audio.generateFullWaveform', { path: key, resolution: 1600, method: 'peak', scale: 'linear', preferCache: true });
  if (waveFor !== key) return;
  if (!ok(r)) { log('seekbar: waveform unavailable', r.error); return; }
  if (r.status === 'ready' && r.waveform) gotWave(r.waveform); else waveTask = r.taskId || null;
}
on('audio:fullWaveformReady', (d) => { if ((waveTask && d.taskId === waveTask) || (d.path && d.path === waveFor)) gotWave(d.waveform); });

/* ---------------------------------------------------------------- drawing */
const track = $('sbTrack'), cv = $('sbWave'), tip = $('sbTip');
let ctx = null, W = 0, H = 0, dirty = true, layers = null, lastKey = '';
function size() {
  const r = track.getBoundingClientRect(), d = dpr();
  W = Math.max(1, Math.round(r.width * d)); H = Math.max(1, Math.round(r.height * d));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  ctx = cv.getContext('2d');
}
new ResizeObserver(() => { dirty = true; kick(); }).observe(track);

/* column values: the waveform resampled to n columns (max of each span), scaled by the grow-in */
function columns(n) {
  const v = new Float32Array(n);
  if (!wave) return v;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i / n * wave.length), b = Math.max(a + 1, Math.floor((i + 1) / n * wave.length));
    let m = 0; for (let j = a; j < b; j++) m = Math.max(m, wave[j]);
    v[i] = m * grow;
  }
  return v;
}
function shape(c, style) {
  const d = dpr(), mid = H / 2;
  const amp = H * 0.92;
  if (style === 'line' || !wave) {
    // a plain line: the «Line» style, and every style while the waveform is not there (yet)
    const th = Math.max(Math.round(3 * d), Math.round(H * (style === 'line' ? 0.16 : 0.09)));
    c.beginPath(); c.roundRect(0, Math.round(mid - th / 2), W, th, th / 2); c.fill();
    return;
  }
  if (style === 'solid') {
    const n = Math.max(2, Math.floor(W / Math.max(1, Math.round(d)))), v = columns(n);
    // light smoothing: a 3-tap filter, so the envelope reads as a shape, not as noise
    const s = Float32Array.from(v, (x, i) => (v[Math.max(0, i - 1)] + 2 * x + v[Math.min(n - 1, i + 1)]) / 4);
    const minH = Math.max(1.2 * d, H * 0.04);
    c.beginPath(); c.moveTo(0, mid);
    for (let i = 0; i < n; i++) c.lineTo(i * W / (n - 1), mid - Math.max(minH, s[i] * amp) / 2);
    for (let i = n - 1; i >= 0; i--) c.lineTo(i * W / (n - 1), mid + Math.max(minH, s[i] * amp) / 2);
    c.closePath(); c.fill();
    return;
  }
  // bars: 2 px bars with 1 px gaps (3 / 1 on taller panels), rounded, mirrored around the middle
  const tall = H / d >= 44;
  const bw = Math.max(1, Math.round((tall ? 3 : 2) * d)), step = bw + Math.max(1, Math.round(d * (tall ? 1.5 : 1)));
  const n = Math.max(1, Math.floor((W + step - bw) / step)), v = columns(n);
  const off = Math.floor((W - (n * step - (step - bw))) / 2);
  for (let i = 0; i < n; i++) {
    const h = Math.max(1.5 * d, v[i] * amp);
    c.beginPath(); c.roundRect(off + i * step, mid - h / 2, bw, h, bw / 2); c.fill();
  }
}
function mkLayer(fill) {
  const l = document.createElement('canvas'); l.width = W; l.height = H;
  const c = l.getContext('2d'); c.fillStyle = fill(c); shape(c, P.style);
  return l;
}
function buildLayers() {
  size();
  if (!col || !W) return null;
  const restA = col.dark ? 0.2 : 0.17;
  return {
    rest: mkLayer(() => rgba(col.text, restA)),
    hover: mkLayer(() => rgba(col.text, restA + 0.22)),
    played: mkLayer((c) => { const g = c.createLinearGradient(0, 0, W, 0); g.addColorStop(0, rgba(col.b)); g.addColorStop(1, rgba(col.a)); return g; }),
  };
}

let lastX = -2, lastHover = -2;
function draw() {
  const frac = S.drag >= 0 ? S.drag : (S.dur > 0 ? clamp(getPos() / S.dur, 0, 1) : 0);
  const key = [P.style, W, H, !!wave].join();
  if (dirty || key !== lastKey || !layers) { layers = buildLayers(); dirty = false; lastKey = [P.style, W, H, !!wave].join(); lastX = -2; }
  if (!layers) return;
  const x = S.track ? Math.round(frac * W) : 0, hx = S.hover >= 0 ? Math.round(S.hover * W) : -1;
  if (x === lastX && hx === lastHover) return;           // nothing visible changed
  lastX = x; lastHover = hx;
  const c = ctx, d = dpr();
  c.clearRect(0, 0, W, H);
  c.drawImage(layers.rest, 0, 0);
  if (hx > x) c.drawImage(layers.hover, x, 0, hx - x, H, x, 0, hx - x, H);
  if (x > 0) c.drawImage(layers.played, 0, 0, x, H, 0, 0, x, H);
  if (S.track && S.dur > 0) {
    if (P.style === 'line' || !wave) {
      // a knob on the line while the pointer is over the bar (or dragging)
      if (hx >= 0 || S.drag >= 0) { const r = Math.max(4 * d, H * 0.2); c.fillStyle = rgba(col.text); c.beginPath(); c.arc(clamp(x, r, W - r), H / 2, r, 0, Math.PI * 2); c.fill(); }
    } else {
      // the playhead: a thin line, a little taller than the loudest bar
      const w = Math.max(1, Math.round(1.5 * d)), h = H * 0.96;
      c.fillStyle = rgba(col.text, 0.9); c.fillRect(clamp(x - (w >> 1), 0, W - w), (H - h) / 2, w, h);
    }
  }
}

function paintTimes() {
  const p = getPos(), d = S.dur || 0, has = !!S.track && d > 0;
  $('sbCur').textContent = has && P.time !== 'none' ? fmtTime(p) : '';
  $('sbDur').textContent = has && P.time !== 'none' ? (P.time === 'remaining' ? '−' + fmtTime(Math.max(0, d - p)) : fmtTime(d)) : '';
  track.setAttribute('aria-valuemax', String(Math.round(d)));
  track.setAttribute('aria-valuenow', String(Math.round(p)));
  track.setAttribute('aria-valuetext', has ? `${fmtTime(p)} / ${fmtTime(d)}` : '');
}
function showTip(frac) {
  if (frac < 0 || !S.dur || !S.track) { tip.classList.remove('on'); return; }
  tip.textContent = fmtTime(frac * S.dur);
  const r = track.getBoundingClientRect(), tw = tip.offsetWidth || 40;
  let left = frac * r.width + 8; if (left + tw > r.width - 2) left = frac * r.width - tw - 8;
  tip.style.transform = `translate(${Math.round(clamp(left, 0, Math.max(0, r.width - tw)))}px, -50%)`;
  tip.classList.add('on');
}

/* the frame loop: runs while something moves; otherwise wakes once per pixel of progress */
let raf = 0, timer = 0, lastTimes = '';
function frame(now) {
  raf = 0;
  let again = stepColours(now);
  if (grow < 1) { grow = clamp((now - growT0) / 380, 0, 1); grow = 1 - Math.pow(1 - grow, 3); dirty = true; again = true; }
  if (document.visibilityState === 'visible') {
    draw();
    const tk = Math.floor(getPos()) + '|' + S.dur + '|' + P.time + '|' + !!S.track;
    if (tk !== lastTimes) { lastTimes = tk; paintTimes(); }
  }
  if (again || S.drag >= 0) raf = requestAnimationFrame(frame);
  else if (S.state === 'playing' && S.dur > 0) {
    const ms = clamp((S.dur * 1000) / Math.max(1, W), 16, 1000);
    timer = setTimeout(() => { timer = 0; kick(); }, Math.min(ms, 1000 - (getPos() % 1) * 1000 + 5));
  }
}
function kick() { if (timer) { clearTimeout(timer); timer = 0; } if (!raf) raf = requestAnimationFrame(frame); }

/* ---------------------------------------------------------------- the track, its cover and colours */
let artTok = 0;
async function loadArt(t) {
  const tok = ++artTok;
  const r = await call('artwork.getFb2kUrl', { type: 'front', maxSize: Math.round(128 * dpr()) });
  if (tok !== artTok) return;
  const url = ok(r) && r.available !== false && r.dataUrl ? artUrl(r.dataUrl) : '';
  const img = $('sbImg');
  img.classList.remove('on');
  if (url) { img.onload = () => img.classList.add('on'); img.onerror = () => img.removeAttribute('src'); img.src = url; } else img.removeAttribute('src');
  themeFor(t, url);
}
function setTrack(t) {
  const prev = S.track;
  S.track = t;
  if (t && t.duration) S.dur = t.duration; else if (!t) S.dur = 0;
  const ph = placeholder(t ? t.album || t.title : 'Gatefold', t ? t.albumArtist || t.artist : '');
  $('sbPh').style.background = ph.bg; $('sbPh').textContent = ph.ini;
  $('sb').classList.toggle('idle', !t);
  document.title = t ? `${t.title} — ${t.artist} · Gatefold` : 'Gatefold · ' + $t('Seekbar');
  track.title = t ? [t.artist, t.title].filter(Boolean).join(' — ') : '';
  if (!t) { wave = null; waveFor = ''; dirty = true; kick(); return; }
  const same = prev && (prev.handle || prev.path) === (t.handle || t.path);
  if (!same) loadWave(t);
  if (!prev || prev.album !== t.album || prev.albumArtist !== t.albumArtist || !$('sbImg').getAttribute('src')) loadArt(t);
  kick();
}
async function sync() {
  const [cur, st, pos] = await Promise.all([call('playback.getCurrentTrack'), call('playback.getState'), call('playback.getPosition')]);
  if (ok(st)) S.state = stateOf(st.state);
  if (ok(pos)) Pos.sample(pos);
  setTrack(ok(cur) && cur.found !== false ? normTrack(cur.track || cur.playing || cur) : null);
}

/* ---------------------------------------------------------------- look */
function applyLook() {
  const sb = $('sb');
  for (const s of STYLES) sb.classList.toggle('st-' + s, P.style === s);
  sb.classList.toggle('with-cover', !!P.cover);
  sb.classList.toggle('no-time', P.time === 'none');
  document.body.classList.toggle('sb-transparent', P.bg === 'none');
  if (S.isPanel) call('panel.setConfig', { transparentBackground: P.bg === 'none' });
  dirty = true; lastTimes = ''; kick();
}
function setPref(k, v) {
  if (P[k] === v) return;
  P[k] = v; save();
  if (k === 'colors') themeFor(S.track, $('sbImg').getAttribute('src') || '');
  applyLook();
}

/* ---------------------------------------------------------------- settings menu (right click) */
const L = () => ({
  style: [$t('Bars'), $t('Solid'), $t('Line')],
  colors: [$t('Album'), $t('Dark'), $t('Light'), $t('Grey')],
  bg: [$t('Colour'), $t('Transparent')],
  time: [$t('Elapsed / total'), $t('Remaining'), $t('None')],
});
let menuId = '';
on('menu:valueChanged', (d) => {
  if (!d || d.menuId !== menuId) return;
  const lists = { style: STYLES, colors: COLORS, bg: BGS, time: TIMES };
  if (lists[d.itemId]) setPref(d.itemId, lists[d.itemId][clamp(Math.round(+d.value || 0), 0, lists[d.itemId].length - 1)]);
});
on('menu:select', (d) => {
  if (!d || d.menuId !== menuId) return;
  menuAction(d.itemId);
});
function menuAction(id) {
  if (id === 'cover') setPref('cover', !P.cover);
  else if (id === 'wheel') setPref('wheel', !P.wheel);
  else if (id === 'reset') { for (const k of Object.keys(DEF)) setPref(k, DEF[k]); }
}
async function openMenu(e) {
  const l = L();
  const seg = (id, label, list, vals) => ({ id, type: 'segmented', label, value: Math.max(0, vals.indexOf(P[id])), segments: list.map((x) => ({ label: x })) });
  const items = [
    seg('style', $t('Style'), l.style, STYLES),
    seg('colors', $t('Colours'), l.colors, COLORS),
    seg('bg', $t('Background'), l.bg, BGS),
    seg('time', $t('Time'), l.time, TIMES),
    { type: 'separator' },
    { id: 'cover', label: $t('Show the cover'), checked: !!P.cover },
    { id: 'wheel', label: $t('Mouse wheel seeks'), checked: !!P.wheel },
    { type: 'separator' },
    { id: 'reset', label: $t('Reset this panel') },
  ];
  const d = dpr();
  const r = await call('menu.show', { items, x: Math.round(e.screenX * d), y: Math.round(e.screenY * d), windowModel: 'contentSized', backdrop: 'acrylic', backdropDarkMode: col ? col.dark : true });
  if (ok(r) && r.menuId) { menuId = r.menuId; return; }
  // an older component without menu.show: a strip of options over the bar itself
  inlineOptions();
}
function inlineOptions() {
  document.querySelector('.sb-opts')?.remove();
  const l = L(), bar = document.createElement('div'); bar.className = 'sb-opts';
  const lists = { style: STYLES, colors: COLORS, bg: BGS, time: TIMES };
  const paint = () => {
    bar.innerHTML = '';
    for (const [k, vals] of Object.entries(lists)) {
      const btn = document.createElement('button');
      btn.textContent = `${$t({ style: 'Style', colors: 'Colours', bg: 'Background', time: 'Time' }[k])}: ${l[k][Math.max(0, vals.indexOf(P[k]))]}`;
      btn.onclick = () => { setPref(k, vals[(vals.indexOf(P[k]) + 1) % vals.length]); paint(); };
      bar.append(btn);
    }
    for (const k of ['cover', 'wheel']) {
      const btn = document.createElement('button');
      btn.textContent = (P[k] ? '✓ ' : '') + $t(k === 'cover' ? 'Show the cover' : 'Mouse wheel seeks');
      btn.onclick = () => { setPref(k, !P[k]); paint(); };
      bar.append(btn);
    }
    const x = document.createElement('button'); x.textContent = '✕'; x.className = 'x'; x.onclick = () => bar.remove(); bar.append(x);
  };
  paint();
  document.body.append(bar);
}

/* ---------------------------------------------------------------- input */
function bind() {
  on('playback:trackChanged', (d) => { setPos(0); setTrack(normTrack(d)); });
  on('playback:starting', (d) => { if (!d.paused) { S.state = 'playing'; kick(); } });
  on('playback:stateChanged', (d) => { if (d.state) S.state = stateOf(d.state); if (d.position != null) Pos.sample(d); kick(); });
  on('playback:paused', (d) => { setPos(getPos()); S.state = d.paused ? 'paused' : 'playing'; kick(); });
  on('playback:stopped', (d) => { if (!/another|starting/i.test(String(d.reason || ''))) { S.state = 'stopped'; setPos(0); setTrack(null); } });
  on('playback:time', Pos.coarse);
  on('playback:timeHighRes', Pos.fine);
  on('playback:seeked', (d) => Pos.seeked(d.position));
  on('playback:dynamicInfoTrack', (d) => { if (S.track && d.title) { S.track = { ...S.track, title: d.title, artist: d.artist || S.track.artist }; track.title = [S.track.artist, S.track.title].join(' — '); } });

  const fracAt = (e) => { const r = track.getBoundingClientRect(); return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1); };
  track.addEventListener('pointerdown', (e) => {
    if (e.button === 1) { e.preventDefault(); call('playback.playOrPause'); return; }
    if (e.button !== 0 || !S.dur || !S.track) return;
    track.setPointerCapture(e.pointerId);
    S.drag = fracAt(e); showTip(S.drag); kick();
  });
  track.addEventListener('pointermove', (e) => {
    const f = fracAt(e);
    if (S.drag >= 0) S.drag = f; else S.hover = f;
    showTip(f); kick();
  });
  const end = (e, commit) => {
    if (S.drag < 0) return;
    const f = S.drag; S.drag = -1;
    try { track.releasePointerCapture(e.pointerId); } catch {}
    if (commit) seekTo(f * S.dur);
    if (!track.matches(':hover')) showTip(-1);
    kick();
  };
  track.addEventListener('pointerup', (e) => end(e, true));
  track.addEventListener('pointercancel', (e) => end(e, false));
  track.addEventListener('pointerleave', () => { S.hover = -1; if (S.drag < 0) showTip(-1); kick(); });
  addEventListener('gatefold:input-reset', () => { S.drag = -1; S.hover = -1; showTip(-1); kick(); });
  let wheelTip = 0;
  $('sb').addEventListener('wheel', (e) => {
    if (!P.wheel || !S.dur || !S.track) return;
    e.preventDefault();
    const step = (e.shiftKey ? 30 : 5) * (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
    seekTo(getPos() + step);
    showTip(getPos() / S.dur); clearTimeout(wheelTip); wheelTip = setTimeout(() => { if (S.hover < 0) showTip(-1); }, 700);
  }, { passive: false });
  track.addEventListener('keydown', (e) => {
    if (!S.dur) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); seekTo(getPos() + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 30 : 5)); }
    else if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
  });
  $('sb').addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(e); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { sync(); dirty = true; kick(); } });
  // the position drifts if a time event is missed while the panel is hidden
  setInterval(() => { if (document.visibilityState === 'visible' && S.track) call('playback.getPosition').then((r) => { if (ok(r) && S.drag < 0 && Math.abs(+r.position - getPos()) > 0.6) Pos.sample(r); }); }, 5000);
}

(async function boot() {
  applyLook();
  if (!(await waitForBridge())) { $('sbCur').textContent = $t('No connection to foobar2000'); return; }
  const m = await call('window.getMode');
  S.isPanel = ok(m) && (!!m.panelMode || /^(dui|cui)$/i.test(String(m.mode || '')));
  document.body.classList.toggle('sb-panel', S.isPanel);
  if (S.isPanel) applyLook();
  bind();
  track.setAttribute('aria-label', $t('Position'));
  await sync();
  if (!S.track) themeFor(null, '');
  kick();
})();
