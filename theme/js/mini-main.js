/*
 * Gatefold · mini-main.js — the mini player (mini.html), a small window of its own above the others:
 * cover, title, a seek line and the transport. It has its own WebView and bridge, follows playback
 * itself, takes the colours of the cover like the main window, and remembers where it was put.
 */
import './i18n-boot.js';
import './tooltip.js';
import { waitForBridge, call, on, ok, normTrack, artUrl, fmtTime, log } from './bridge.js';
import { settings, setSetting } from './settings.js';
import * as Theme from './theme.js';
import * as Likes from './likes.js';
import { placeholder } from './ui.js';
import { $t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const S = { track: null, state: 'stopped', pos: 0, dur: 0, t0: performance.now(), vol: 100, muted: false };
const getPos = () => Math.min(S.dur || Infinity, S.state === 'playing' ? S.pos + (performance.now() - S.t0) / 1000 : S.pos);
const setPos = (p, d) => { S.pos = +p || 0; S.t0 = performance.now(); if (d != null && +d > 0) S.dur = +d; };
const stateOf = (v) => { const x = String(v || '').toLowerCase(); return /play/.test(x) && !/pause/.test(x) ? 'playing' : /pause/.test(x) ? 'paused' : 'stopped'; };
const BOUNDS = 'gatefold.mini.bounds';

async function loadSprite() {
  try {
    const html = await (await fetch('index.html', { cache: 'no-store' })).text();
    const m = html.match(/<svg width="0" height="0"[\s\S]*?<\/svg>/);
    if (m) document.body.insertAdjacentHTML('afterbegin', m[0]);
  } catch (e) { log('sprite', e); }
}

/* ---------------------------------------------------------------- painting */
function paintState() {
  $('miPlay').querySelector('use').setAttribute('href', S.state === 'playing' ? '#i-pause' : '#i-play');
  $('miPlay').title = S.state === 'playing' ? $t('Приостановить') : $t('Воспроизвести');
}
function paintLike() {
  const on = !!(S.track && Likes.has(S.track));
  $('miLike').classList.toggle('on', on);
  $('miLike').querySelector('use').setAttribute('href', on ? '#i-heart-f' : '#i-heart');
}
function paintVol() { $('miVol').querySelector('use').setAttribute('href', S.muted || S.vol === 0 ? '#i-vol-x' : '#i-vol'); }
function tick() {
  const d = S.dur || 0, p = getPos();
  $('miFill').style.width = d ? Math.min(100, (p / d) * 100) + '%' : '0';
  $('miCur').textContent = fmtTime(p);
  $('miDur').textContent = d ? fmtTime(d) : '';
  requestAnimationFrame(tick);
}

let artTok = 0;
async function loadArt(t) {
  const tok = ++artTok;
  const img = $('miImg');
  const r = await call('artwork.getFb2kUrl', { type: 'front', maxSize: Math.round(160 * (devicePixelRatio || 1)) });
  if (tok !== artTok) return;
  const url = ok(r) && r.available !== false && r.dataUrl ? artUrl(r.dataUrl) : '';
  img.classList.remove('on');
  if (url) { img.onload = () => img.classList.add('on'); img.onerror = () => img.removeAttribute('src'); img.src = url; } else img.removeAttribute('src');
  Theme.themeForTrack(t, { available: !!url, url, small: url });
}
async function setTrack(t) {
  const prev = S.track;
  S.track = t;
  if (t && t.duration) S.dur = t.duration;
  $('miTitle').textContent = t ? (t.title || (t.path || '').split('\\').pop()) : 'Gatefold';
  $('miSub').textContent = t ? [t.artist, t.album].filter(Boolean).join(' · ') : $t('Ничего не играет');
  document.title = t ? `${t.title} — ${t.artist} · Gatefold` : $t('Gatefold · Мини-плеер');
  const ph = placeholder(t ? t.album || t.title : 'Gatefold', t ? t.albumArtist || t.artist : '');
  $('miPh').style.background = ph.bg; $('miPh').textContent = ph.ini;
  paintLike();
  if (!t) { $('miImg').removeAttribute('src'); return; }
  if (!prev || prev.album !== t.album || prev.albumArtist !== t.albumArtist || !$('miImg').getAttribute('src')) loadArt(t);
}

async function sync() {
  const [cur, st, pos, vo] = await Promise.all([call('playback.getCurrentTrack'), call('playback.getState'), call('playback.getPosition'), call('playback.getVolume')]);
  if (ok(st)) S.state = stateOf(st.state);
  if (ok(pos)) setPos(pos.position, pos.duration);
  if (ok(vo)) { S.vol = Math.round(vo.volume); S.muted = !!(vo.isMuted ?? vo.muted); }
  await setTrack(ok(cur) && cur.found !== false ? normTrack(cur.track || cur.playing || cur) : null);
  paintState(); paintVol();
}

/* ---------------------------------------------------------------- controls */
function bind() {
  on('playback:trackChanged', (d) => { setPos(0); setTrack(normTrack(d)); });
  on('playback:starting', (d) => { if (!d.paused) { S.state = 'playing'; paintState(); } });
  on('playback:stateChanged', (d) => { if (d.state) S.state = stateOf(d.state); if (d.position != null) setPos(d.position, d.duration); paintState(); });
  on('playback:paused', (d) => { setPos(getPos()); S.state = d.paused ? 'paused' : 'playing'; paintState(); });
  on('playback:stopped', (d) => { if (!/another|starting/i.test(String(d.reason || ''))) { S.state = 'stopped'; setPos(0); paintState(); } });
  on('playback:time', (d) => setPos(d.position));
  on('playback:seeked', (d) => setPos(d.position));
  on('playback:volumeChanged', (d) => { S.vol = Math.round(d.volume); S.muted = !!(d.isMuted ?? d.muted); paintVol(); });
  on('playback:dynamicInfoTrack', (d) => { if (S.track && d.title) setTrack({ ...S.track, title: d.title, artist: d.artist || S.track.artist }); });
  Likes.events.addEventListener('change', paintLike);

  $('miPlay').onclick = async () => { const r = await call('playback.playOrPause'); if (!ok(r)) call('playback.play'); };
  $('miPrev').onclick = () => call('playback.previous');
  $('miNext').onclick = () => call('playback.next');
  $('miLike').onclick = () => S.track && Likes.toggle(S.track);
  $('miVol').onclick = () => call('playback.toggleMute');
  $('mini').addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = Math.max(0, Math.min(100, S.vol + (e.deltaY < 0 ? 4 : -4)));
    S.vol = v; call('playback.setVolume', { volume: v }); paintVol(); volTip(v);
  }, { passive: false });
  const seek = $('miSeek');
  seek.addEventListener('pointerdown', (e) => {
    if (!S.dur) return;
    const r = seek.getBoundingClientRect(), p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.dur;
    setPos(p); call('playback.setPosition', { position: p });
    e.stopPropagation();
  });
  $('miOpen').onclick = () => call('window.focus', { windowId: 'main' });
  $('miClose').onclick = () => call('window.close');
  const pin = $('miPin');
  const paintPin = () => { pin.classList.toggle('on', !!settings.miniTopmost); pin.title = settings.miniTopmost ? $t('Поверх всех окон: включено') : $t('Поверх всех окон: выключено'); };
  pin.onclick = async () => { setSetting('miniTopmost', !settings.miniTopmost); await call('window.setAlwaysOnTop', { enabled: !!settings.miniTopmost }); paintPin(); };
  paintPin();
  // drag the window by any empty spot
  $('mini').addEventListener('pointerdown', (e) => { if (e.button === 0 && !e.target.closest('button, .mi-seek')) call('window.startDrag'); });
  $('mini').addEventListener('dblclick', (e) => { if (!e.target.closest('button, .mi-seek')) call('window.focus', { windowId: 'main' }); });
  addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === ' ') { e.preventDefault(); $('miPlay').click(); }
    else if (k === 'Escape') call('window.close');
    else if (k === 'ArrowRight') call(e.shiftKey ? 'playback.next' : 'playback.setPosition', e.shiftKey ? undefined : { position: getPos() + 5 });
    else if (k === 'ArrowLeft') call(e.shiftKey ? 'playback.previous' : 'playback.setPosition', e.shiftKey ? undefined : { position: Math.max(0, getPos() - 5) });
    else if (/^[lLдД]$/.test(k)) $('miLike').click();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  setInterval(() => { if (document.visibilityState === 'visible') call('playback.getPosition').then((r) => { if (ok(r) && Math.abs(+r.position - getPos()) > 0.6) setPos(r.position, r.duration); }); }, 5000);
}
let tipT = 0;
function volTip(v) {
  let t = document.querySelector('.mi-vol-tip');
  if (!t) { t = document.createElement('div'); t.className = 'mi-vol-tip'; document.body.append(t); }
  t.textContent = $t('Громкость {0}%', v);
  clearTimeout(tipT); tipT = setTimeout(() => t.remove(), 900);
}

(async function boot() {
  await loadSprite();
  if (!(await waitForBridge())) { $('miTitle').textContent = $t('Нет связи с foobar2000'); return; }
  bind();
  Likes.init().then(paintLike);
  await sync();
  requestAnimationFrame(tick);
  // remember where the user keeps it (moving a window fires no DOM event)
  let last = '';
  setInterval(async () => {
    const b = await call('window.getBounds'); if (!ok(b)) return;
    const k = [b.x, b.y, b.width, b.height].join();
    if (k !== last) { last = k; try { localStorage.setItem(BOUNDS, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height })); } catch {} }
  }, 3000);
})();
