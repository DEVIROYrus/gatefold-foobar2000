/*
 * Gatefold · canvas.js — «Холст»: fullscreen, distraction-free Now Playing.
 *
 * Layers (all motion is transform/opacity on composited layers):
 *   backdrop   the cover pre-blurred on a 48 px canvas, stretched to the screen
 *              (bilinear upscaling of a tiny image IS a perfect blur, for free)
 *              + two palette glows + vignette, drifting very slowly
 *   cover      large, rounded, deep shadow; slow Ken Burns drift inside its frame
 *   text       title / artist / album, synced lyrics (lyrics.js LyricView)
 *   chrome     progress hairline, clock, controls — auto-hidden with the cursor
 *
 * Hosts: the main window (overlay, app.js feeds it via setHost/notify) or a
 * popup window on another monitor (canvas.html → canvas-main.js), same module.
 * Layouts: cover (cover + lyrics side by side) · lyrics (lyrics first) · minimal · visual (MilkDrop on the
 * whole screen, a small card with the cover and the title — milkdrop.js; only when turned on in Settings).
 */
import { call, ok, on, esc, fmtTime } from './bridge.js';
import { fetchArt } from './artbytes.js';
import { setFullscreen } from './winfs.js';
import { settings, setSetting, onSettings } from './settings.js';
import * as LY from './lyrics.js';
import * as MD from './milkdrop.js';

import { $t } from './i18n.js';
let host = null;             // { getPos, getDur, state, track, art, standalone, palette? }
let el = null, view = null, isOpen = false, enteredFullscreen = false, auto = false;
let lyrKey = '', curArt = '', flip = false, hideT = 0, clockT = 0, raf = 0, offset = 0;
export const canvasEvents = new EventTarget();

export function setHost(h) { host = h; }
export const opened = () => isOpen;

// ---------------------------------------------------------------- DOM
const ICON = (n, s = 20) => `<svg width="${s}" height="${s}"><use href="#i-${n}"/></svg>`;
function build() {
  el = document.createElement('div');
  el.id = 'canvas';
  el.className = 'cv';
  el.innerHTML = `
    <div class="cv-md" aria-hidden="true"></div>
    <div class="cv-bg" aria-hidden="true"><div class="cv-blur a"></div><div class="cv-blur b"></div><div class="cv-glow g1"></div><div class="cv-glow g2"></div><div class="cv-vignette"></div></div>
    <div class="cv-stage">
      <div class="cv-art"><div class="cv-art-frame"><img class="a" alt=""><img class="b" alt=""><div class="cv-noart">${ICON('music', 72)}</div></div></div>
      <div class="cv-side">
        <div class="cv-meta"><div class="cv-kicker"></div><h1 class="cv-title"></h1><div class="cv-artist"></div><div class="cv-album"></div></div>
        <div class="cv-lyrics"></div>
      </div>
    </div>
    <div class="cv-clock num"></div>
    <div class="cv-hint"></div>
    <div class="cv-chrome">
      <div class="cv-progress"><i></i></div>
      <div class="cv-controls">
        <span class="cv-time num" data-cur>0:00</span>
        <div class="cv-transport">
          <button class="cv-btn" data-a="prev" title="${$t('Предыдущий (Shift+←)')}">${ICON('prev')}</button>
          <button class="cv-btn big" data-a="play" title="${$t('Пауза / воспроизведение (Пробел)')}">${ICON('play', 26)}</button>
          <button class="cv-btn" data-a="next" title="${$t('Следующий (Shift+→)')}">${ICON('next')}</button>
        </div>
        <span class="cv-time num" data-dur>0:00</span>
        <div class="cv-tools">
          <div class="cv-seg" data-a="layout"><button data-v="cover" title="${$t('Обложка и текст')}">${$t('Обложка')}</button><button data-v="lyrics" title="${$t('Крупный текст')}">${$t('Текст\u0004lyrics')}</button><button data-v="minimal" title="${$t('Только обложка')}">${$t('Минимум')}</button><button data-v="visual" title="${$t('Визуализация MilkDrop (V)')}">${$t('Визуал')}</button></div>
          <div class="cv-vol"><button class="cv-btn" data-a="mute" title="${$t('Без звука (M)')}">${ICON('vol')}</button><input class="cv-range" type="range" min="0" max="100" step="1" aria-label="${$t('Громкость')}"></div>
          <button class="cv-btn" data-a="lyrics" title="${$t('Текст песни (T)')}">${ICON('quote')}</button>
          <button class="cv-btn" data-a="screen" title="${$t('Открыть на другом мониторе')}">${ICON('monitor2')}</button>
          <button class="cv-btn" data-a="close" title="${$t('Выйти (Esc)')}">${ICON('x')}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
  view = new LY.LyricView(el.querySelector('.cv-lyrics'), {
    getPos: () => host.getPos(),
    seek: (p) => { call('playback.setPosition', { position: p }); host.onSeek && host.onSeek(p); },
    playing: () => host.state() === 'playing',
    variant: 'canvas',
  });
  el.addEventListener('click', onClick);
  // volume: the same foobar2000 volume as the player bar, in either window
  const vr = el.querySelector('.cv-range');
  vr.addEventListener('input', () => { paintVol(+vr.value, false); call('playback.setVolume', { volume: +vr.value }); });
  vr.addEventListener('wheel', (e) => { e.preventDefault(); const v = Math.max(0, Math.min(100, vol.v + (e.deltaY < 0 ? 3 : -3))); paintVol(v, false); call('playback.setVolume', { volume: v }); }, { passive: false });
  call('playback.getVolume').then((r) => { if (ok(r)) paintVol(r.volume, r.isMuted ?? r.muted); });
  el.addEventListener('dblclick', (e) => { if (host.standalone && !e.target.closest('.cv-chrome, .ln')) toggleWindowFullscreen(); });
  el.addEventListener('pointermove', poke);
  el.addEventListener('pointerdown', (e) => { poke(); if (host.standalone && !host.fullscreen && e.button === 0 && !e.target.closest('button, .cv-chrome, .ln')) call('window.startDrag'); });
  el.querySelector('.cv-progress').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect(); const d = host.getDur();
    if (d > 0) { const p = (e.clientX - r.left) / r.width * d; call('playback.setPosition', { position: p }); host.onSeek && host.onSeek(p); }
  });
}

const vol = { v: 100, m: false };
function paintVol(v, m) {
  if (v != null) vol.v = Math.round(+v);
  if (m != null) vol.m = !!m;
  if (!el) return;
  const r = el.querySelector('.cv-range'); if (!r) return;
  const shown = vol.m ? 0 : vol.v;
  if (document.activeElement !== r) r.value = shown;
  r.style.setProperty('--p', shown + '%');
  el.querySelector('[data-a=mute] use').setAttribute('href', vol.m || vol.v === 0 ? '#i-vol-x' : '#i-vol');
}
on('playback:volumeChanged', (d) => paintVol(d.volume, d.isMuted ?? d.muted));

function onClick(e) {
  const b = e.target.closest('[data-a], [data-v]');
  if (!b) return;
  const seg = e.target.closest('.cv-seg');
  if (seg && e.target.dataset.v) { setSetting('canvasLayout', e.target.dataset.v); return; }
  switch (b.dataset.a) {
    case 'prev': call('playback.previous'); break;
    case 'next': call('playback.next'); break;
    case 'play': call('playback.playOrPause').then((r) => { if (!ok(r)) call('playback.play'); }); break;
    case 'lyrics': setSetting('canvasLyrics', !settings.canvasLyrics); break;
    case 'mute': call('playback.toggleMute'); break;
    case 'screen': openOnOtherScreen(); break;
    case 'close': close(); break;
  }
}

/* ---------------------------------------------------------------- MilkDrop (layout «visual») */
const visOk = () => !!settings.milkdrop && MD.supported();
const layoutOf = () => { const l = settings.canvasLayout || 'cover'; return l === 'visual' && !visOk() ? 'cover' : l; };
const LAYOUTS = () => (visOk() ? ['cover', 'lyrics', 'minimal', 'visual'] : ['cover', 'lyrics', 'minimal']);
let md = null, freshT = 0;
function syncMilk() {
  const want = isOpen && layoutOf() === 'visual';
  if (want && !md) {
    md = new MD.Stage(el.querySelector('.cv-md'), {
      kind: 'canvas',
      playing: () => host.state() === 'playing',
      track: () => host.track(),
      onPreset: (name, why) => { if (why === 'next' || why === 'prev' || why === 'flash') hint(nice(name)); },
    });
  }
  if (md) { if (want) md.start().then(() => { if (isOpen && layoutOf() === 'visual') freshCard(); }); else md.stop(); }
  el.classList.toggle('md-tint', !!settings.mdTint);
}
/* «Flexi, martin + geiss - dedicated to the sherwin maxawow» → «dedicated to the sherwin maxawow — Flexi, martin + geiss» */
const nice = (n) => { const m = String(n).replace(/^[$!_\s-]+/, '').match(/^(.*?)\s+-\s+(.+)$/); return m ? `${m[2]} — ${m[1]}` : n; };
/** the card shows itself for a few seconds when the track changes, then fades with the cursor */
function freshCard() { el.classList.add('fresh'); clearTimeout(freshT); freshT = setTimeout(() => el.classList.remove('fresh'), 6000); }

function applySettings() {
  if (!el) return;
  el.dataset.layout = layoutOf();
  el.querySelector('.cv-seg [data-v=visual]').hidden = !visOk();
  el.classList.toggle('motion', !!settings.canvasMotion && !matchMedia('(prefers-reduced-motion: reduce)').matches);
  el.classList.toggle('no-lyrics', !settings.canvasLyrics || settings.canvasLayout === 'minimal');
  el.classList.toggle('clock', !!settings.canvasClock);
  el.querySelectorAll('.cv-seg button').forEach((x) => x.classList.toggle('on', x.dataset.v === layoutOf()));
  el.querySelector('[data-a=lyrics]').classList.toggle('on', !!settings.canvasLyrics);
  el.querySelector('[data-a=screen]').style.display = host && host.standalone ? 'none' : '';
  if (view && view.doc) { view.cur = -2; requestAnimationFrame(() => view && view.tick(true)); }
  syncMilk();
}
onSettings((k) => { if (/^(canvas|milkdrop|md)/.test(k) || k === '*') { applySettings(); if (isOpen && (k === 'canvasLyrics' || k === 'canvasLayout')) loadLyrics(true); } });

// ---------------------------------------------------------------- open / close
export async function open(opts = {}) {
  if (!host || isOpen) return;
  if (!el) build();
  auto = !!opts.auto;
  isOpen = true;
  el.classList.add('on');
  document.body.classList.add('canvas-open');
  applySettings();
  refresh(true);
  if (layoutOf() === 'visual') freshCard();
  poke(!auto);
  clockT = setInterval(tickClock, 5000); tickClock();
  startProgress();
  if (!host.standalone && opts.fullscreen !== false && host.canFullscreen && !host.isFullscreen()) {
    const r = await setFullscreen(true);
    enteredFullscreen = ok(r) && !!(r.fullscreen ?? r.isFullscreen ?? true);
    host.onFullscreen && host.onFullscreen(enteredFullscreen);
  }
  canvasEvents.dispatchEvent(new Event('open'));
}
export async function close() {
  if (!isOpen) return;
  if (host.standalone) { if (host.fullscreen) toggleWindowFullscreen(); else { await saveBounds(); call('window.close'); } return; }
  isOpen = false;
  el.classList.remove('on', 'idle');
  document.body.classList.remove('canvas-open');
  clearInterval(clockT); clearTimeout(hideT); stopProgress(); view.stop();
  syncMilk();
  if (enteredFullscreen) { const r = await call('window.setFullscreen', { enabled: false }); enteredFullscreen = false; host.onFullscreen && host.onFullscreen(false, r); }
  canvasEvents.dispatchEvent(new Event('close'));
}
export function toggle() { return isOpen ? close() : open(); }

async function toggleWindowFullscreen() {
  const r = await setFullscreen(!host.fullscreen);
  if (ok(r)) { host.fullscreen = !!(r.fullscreen ?? r.isFullscreen); saveBounds(); }
}

// ---------------------------------------------------------------- data from the host
/** Host calls this on any change: 'track' | 'state' | 'art' | 'seek' | 'palette'. */
export function notify(type) {
  if (!isOpen || !el) return;
  if (type === 'track') { refresh(false); freshCard(); if (md && md.on && settings.mdChange !== 'time' && settings.mdChange !== 'manual') md.next('track'); }
  else if (type === 'art') setArt();
  else if (type === 'state') { setState(); view.kick(); startProgress(); }
  else if (type === 'seek') { view.kick(); drawProgress(); }
  else if (type === 'palette') setBackdrop();
}

function refresh(first) {
  const t = host.track();
  const m = el.querySelector('.cv-meta');
  const write = () => {
    el.querySelector('.cv-title').textContent = t ? t.title : 'Gatefold';
    el.querySelector('.cv-artist').textContent = t ? t.artist : '';
    el.querySelector('.cv-album').textContent = t ? [t.album, t.year].filter(Boolean).join(' · ') : '';
    el.querySelector('[data-dur]').textContent = fmtTime(host.getDur());
  };
  if (first) write();
  else { m.classList.add('swap'); setTimeout(() => { write(); m.classList.remove('swap'); }, 260); }
  setState(); setArt(); loadLyrics(false);
}

function setState() {
  const st = host.state();
  el.querySelector('.cv-kicker').textContent = st === 'playing' ? $t('Сейчас играет') : st === 'paused' ? $t('Пауза') : $t('Остановлено');
  el.querySelector('[data-a=play] use').setAttribute('href', st === 'playing' ? '#i-pause' : '#i-play');
  el.classList.toggle('paused', st !== 'playing');
}

function setArt() {
  const a = host.art();
  const url = a && a.available ? a.url : '';
  el.classList.toggle('noart', !url);
  if (url === curArt) { setBackdrop(); return; }
  curArt = url;
  const imgs = el.querySelectorAll('.cv-art-frame img');
  const [next, prev] = flip ? [imgs[0], imgs[1]] : [imgs[1], imgs[0]];
  flip = !flip;
  if (!url) { imgs.forEach((i) => i.classList.remove('on')); setBackdrop(); return; }
  next.onload = async () => { try { await next.decode(); } catch {} next.classList.add('on'); prev.classList.remove('on'); setBackdrop(next); };
  next.src = url;
  // restart the Ken Burns drift from a per-album direction so consecutive albums don't move identically
  const f = el.querySelector('.cv-art-frame');
  const hsh = [...(url || 'x')].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7);
  f.style.setProperty('--kx', ((hsh % 7) - 3) * 0.6 + '%');
  f.style.setProperty('--ky', (((hsh >> 3) % 7) - 3) * 0.5 + '%');
}

let bgFlip = false;
/* An <img> loaded from fb2k:// is cross-origin to the page: drawing it would taint
   the canvas. The picture's bytes (artbytes.js picks a transport that works here)
   or a blob:/data: URL give readable pixels. */
const blurCache = new Map();
let bdTok = 0;
async function setBackdrop(img) {
  const tok = ++bdTok;
  const layers = el.querySelectorAll('.cv-blur');
  const src = img || el.querySelector('.cv-art-frame img.on');
  const url = src && src.getAttribute('src');
  let data = url ? blurCache.get(url) || '' : '';
  if (url && !data) {
    let bmp = null;
    try {
      let blob = null;
      if (/^fb2k:/i.test(url)) { const r = await fetchArt(url); if (r.status === 200) blob = r.blob; }
      else { const r = await fetch(url); if (r.ok) blob = await r.blob(); }
      if (blob) bmp = await createImageBitmap(blob, { resizeWidth: 64, resizeHeight: 64, resizeQuality: 'high' });
    } catch {}
    try {
      const c = document.createElement('canvas'); c.width = c.height = 48;
      const x = c.getContext('2d'); x.filter = 'blur(2px) saturate(1.25)';
      x.drawImage(bmp || src, -4, -4, 56, 56);
      data = c.toDataURL('image/png');
      blurCache.set(url, data); if (blurCache.size > 30) blurCache.delete(blurCache.keys().next().value);
    } catch { data = ''; }
    if (bmp) bmp.close();
  }
  if (tok !== bdTok) return;
  const [show, hide] = bgFlip ? [layers[0], layers[1]] : [layers[1], layers[0]];
  bgFlip = !bgFlip;
  show.style.backgroundImage = data ? `url("${data}")` : 'none';
  show.classList.add('on'); hide.classList.remove('on');
}

async function loadLyrics(force) {
  const t = host.track();
  if (!settings.canvasLyrics || layoutOf() === 'minimal' || layoutOf() === 'visual' || !t) { el.classList.add('no-text'); view.message(''); lyrKey = ''; return; }
  const k = LY.trackKey(t);
  if (!force && k === lyrKey) { view.kick(); return; }
  lyrKey = k;
  view.message('');
  const doc = await LY.getLyrics(t);
  if (lyrKey !== k || !isOpen) return;
  const has = !!(doc && !doc.instrumental && doc.lines.length);
  el.classList.toggle('no-text', !has);
  el.classList.toggle('plain-text', has && !doc.synced);
  if (has) { offset = doc.synced ? await LY.getOffset(t) : 0; view.show(doc, offset); }
  else view.message('');
}

// ---------------------------------------------------------------- chrome: progress, clock, auto-hide
function drawProgress() {
  const d = host.getDur(), p = host.getPos();
  el.querySelector('.cv-progress i').style.transform = `scaleX(${d > 0 ? Math.min(1, p / d).toFixed(5) : 0})`;
  const s = Math.floor(p);
  if (s !== drawProgress.s) { drawProgress.s = s; el.querySelector('[data-cur]').textContent = fmtTime(s); el.querySelector('[data-dur]').textContent = fmtTime(d); }
}
function startProgress() {
  stopProgress();
  const loop = () => { raf = 0; if (!isOpen) return; drawProgress(); if (host.state() === 'playing' && document.visibilityState === 'visible') raf = requestAnimationFrame(loop); };
  // the hairline is 2 px: 4 updates/s are indistinguishable from 60 and cost nothing
  const slow = () => { if (!isOpen) return; drawProgress(); if (host.state() === 'playing') raf = setTimeout(slow, 250); };
  el.classList.contains('idle') ? slow() : loop();
}
function stopProgress() { if (raf) { cancelAnimationFrame(raf); clearTimeout(raf); } raf = 0; }
function tickClock() { if (!el) return; const d = new Date(); el.querySelector('.cv-clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function poke(show = true) {
  if (!isOpen) return;
  if (show) { el.classList.remove('idle'); }
  clearTimeout(hideT);
  hideT = setTimeout(() => { el.classList.add('idle'); startProgress(); }, show ? 2600 : 0);
}

// ---------------------------------------------------------------- keyboard (active only while open)
document.addEventListener('keydown', (e) => {
  if (!isOpen) return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  const k = e.key;
  let handled = true;
  switch (k) {
    case 'Escape': close(); break;
    case 'f': case 'F': case 'а': case 'А': if (host.standalone) toggleWindowFullscreen(); else close(); break;
    case ' ': call('playback.playOrPause'); break;
    case 'ArrowRight': if (e.shiftKey) call('playback.next'); else { const p = host.getPos() + 5; call('playback.setPosition', { position: p }); host.onSeek && host.onSeek(p); } break;
    case 'ArrowLeft': if (e.shiftKey) call('playback.previous'); else { const p = Math.max(0, host.getPos() - 5); call('playback.setPosition', { position: p }); host.onSeek && host.onSeek(p); } break;
    case 'l': case 'L': case 'д': case 'Д': { const L = LAYOUTS(); setSetting('canvasLayout', L[(L.indexOf(layoutOf()) + 1) % L.length]); break; }
    case 'v': case 'V': case 'м': case 'М': if (visOk()) setSetting('canvasLayout', layoutOf() === 'visual' ? 'cover' : 'visual'); else handled = false; break;
    case 'n': case 'N': case 'т': case 'Т': if (md && md.on) md.next('next'); else handled = false; break;
    case 'p': case 'P': case 'з': case 'З': if (md && md.on) md.next('prev'); else handled = false; break;
    case 'b': case 'B': case 'и': case 'И': if (md && md.on) { const k2 = md.lock(); hint(k2 ? $t('Пресет закреплён: {0}', nice(k2)) : $t('Пресеты снова меняются')); } else handled = false; break;
    case 't': case 'T': case 'е': case 'Е': setSetting('canvasLyrics', !settings.canvasLyrics); break;
    case 'c': case 'C': case 'с': case 'С': setSetting('canvasClock', !settings.canvasClock); break;
    case 'ArrowUp': case 'ArrowDown': { const v = Math.max(0, Math.min(100, vol.v + (k === 'ArrowUp' ? 5 : -5))); paintVol(v, false); call('playback.setVolume', { volume: v }); hint($t('Громкость {0}%', v)); break; }
    case 'm': case 'M': case 'ь': case 'Ь': call('playback.toggleMute'); break;
    case '[': case 'х': case 'Х': nudge(-0.2); break;
    case ']': case 'ъ': case 'Ъ': nudge(0.2); break;
    default: handled = false;
  }
  if (handled) { e.preventDefault(); e.stopImmediatePropagation(); poke(); }
}, true);

function nudge(d) {
  const t = host.track(); if (!t || !view.doc || !view.doc.synced) return;
  offset = Math.round((offset + d) * 10) / 10; LY.setOffset(t, offset); view.setOffset(offset);
  hint($t('Сдвиг текста {0}{1} с', offset > 0 ? '+' : '', offset.toFixed(1)));
}
function hint(text) { const h = el.querySelector('.cv-hint'); h.textContent = text; h.classList.add('on'); clearTimeout(hint.t); hint.t = setTimeout(() => h.classList.remove('on'), 1400); }
export function showHint(text) { if (el) hint(text); }

// ---------------------------------------------------------------- second monitor (popup window)
const BOUNDS = 'aurora.canvas.bounds';
let popupId = '';
export async function openOnOtherScreen() {
  if (popupId) {
    const all = await call('window.getAllWindows');
    const alive = ok(all) && (all.items || all.windows || []).some((w) => (w.windowId || w.id) === popupId);
    if (alive) { call('window.focus', { windowId: popupId }); return; }
  }
  let b = null; try { b = JSON.parse(localStorage.getItem(BOUNDS) || 'null'); } catch {}
  const p = { url: 'canvas.html', title: $t('Gatefold · Холст'), frame: false, resizable: true, showInTaskbar: true, width: 1280, height: 760, minWidth: 480, minHeight: 300 };
  if (b && b.width > 200) Object.assign(p, { x: b.x, y: b.y, width: b.width, height: b.height });
  const r = await call('window.createPopup', p);
  if (!ok(r)) { canvasEvents.dispatchEvent(new CustomEvent('error', { detail: r.error || r.code || 'popup failed' })); return; }
  popupId = r.windowId;
  if (isOpen && !host.standalone) close();
}
/** popup side: remember where the user put it (and whether fullscreen) for next time */
export async function saveBounds() {
  if (!host || !host.standalone) return;
  const r = await call('window.getBounds');
  if (!ok(r)) return;
  const st = await call('window.getState');
  const fs = ok(st) && !!(st.isFullscreen ?? st.fullscreen);
  let prev = null; try { prev = JSON.parse(localStorage.getItem(BOUNDS) || 'null'); } catch {}
  const b = fs && prev ? { ...prev, fullscreen: true } : { x: r.x, y: r.y, width: r.width, height: r.height, fullscreen: fs };
  try { localStorage.setItem(BOUNDS, JSON.stringify(b)); } catch {}
}
export const savedBounds = () => { try { return JSON.parse(localStorage.getItem(BOUNDS) || 'null'); } catch { return null; } };
