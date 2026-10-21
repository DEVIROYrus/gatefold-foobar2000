/*
 * Gatefold · canvas-main.js — boots «Холст» in its own popup window (canvas.html),
 * e.g. fullscreen on a second monitor while foobar2000 stays usable on the first.
 * The popup has its own WebView and bridge, so it tracks playback itself.
 */
import './i18n-boot.js';
import './input-guard.js';
import './tooltip.js';
import { waitForBridge, call, on, ok, normTrack, artUrl, log } from './bridge.js';
import * as Theme from './theme.js';
import * as Canvas from './canvas.js';
import { setFullscreen, unpin } from './winfs.js';
import { follower } from './position.js';

import { $t } from './i18n.js';
const S = { track: null, state: 'stopped', pos: 0, dur: 0, t0: performance.now(), art: { available: false, url: '', small: '' } };
const getPos = () => (S.state === 'playing' ? S.pos + (performance.now() - S.t0) / 1000 : S.pos);
const setPos = (p, d) => { S.pos = +p || 0; S.t0 = performance.now(); if (d != null && +d > 0) S.dur = +d; };
const Pos = follower({ set: setPos, get: getPos, playing: () => S.state === 'playing' });
const stateOf = (v) => { const x = String(v || '').toLowerCase(); return /play/.test(x) && !/pause/.test(x) ? 'playing' : /pause/.test(x) ? 'paused' : 'stopped'; };

const host = {
  standalone: true, fullscreen: false,
  getPos, getDur: () => S.dur || (S.track && S.track.duration) || 0,
  state: () => S.state, track: () => S.track, art: () => S.art,
  onSeek: (p) => { Pos.seeked(p); Canvas.notify('seek'); },
};

async function loadSprite() {
  try {
    const html = await (await fetch('index.html', { cache: 'no-store' })).text();
    const m = html.match(/<svg width="0" height="0"[\s\S]*?<\/svg>/);
    if (m) document.body.insertAdjacentHTML('afterbegin', m[0]);
  } catch (e) { log('sprite', e); }
}

const loads = (url) => new Promise((res) => { const im = new Image(); im.onload = () => res(im.naturalWidth > 1); im.onerror = () => res(false); im.src = url; });
let artTok = 0;
async function loadArt() {
  const tok = ++artTok;
  const [big, small] = await Promise.all([
    call('artwork.getFb2kUrl', { type: 'front', maxSize: Math.min(2000, Math.round(Math.min(screen.width, screen.height) * 0.75 * (devicePixelRatio || 1))) }),
    call('artwork.getFb2kUrl', { type: 'front', maxSize: 128 }),
  ]);
  let url = ok(big) && big.available !== false && big.dataUrl ? artUrl(big.dataUrl) : '';
  if (url && !(await loads(url))) url = '';
  if (!url) { const d = await call('artwork.getCurrent', { type: 'front' }); if (ok(d) && d.available !== false && d.dataUrl && await loads(d.dataUrl)) url = d.dataUrl; }
  if (tok !== artTok) return;
  S.art = { available: !!url, url, small: url && ok(small) && small.dataUrl ? artUrl(small.dataUrl) : url };
  Canvas.notify('art');
  Theme.themeForTrack(S.track, S.art);
}

async function setTrack(t) {
  const prevKey = S.track ? (S.track.albumArtist + '\u0001' + S.track.album) : '';
  S.track = t;
  if (t && t.duration) S.dur = t.duration;
  document.title = t ? $t('{0} — {1} · Холст', t.title, t.artist) : $t('Gatefold · Холст');
  Canvas.notify('track');
  if (!t) return;
  if ((t.albumArtist + '\u0001' + t.album) !== prevKey || !S.art.url) await loadArt();
}

async function sync() {
  const [cur, st, pos] = await Promise.all([call('playback.getCurrentTrack'), call('playback.getState'), call('playback.getPosition')]);
  if (ok(st)) S.state = stateOf(st.state);
  if (ok(pos)) Pos.sample(pos);
  const t = ok(cur) && cur.found !== false ? normTrack(cur.track || cur.playing || cur) : null;
  await setTrack(t);
  Canvas.notify('state');
}

function bind() {
  on('playback:trackChanged', (d) => { setPos(0); setTrack(normTrack(d)); });
  on('playback:starting', (d) => { if (!d.paused) { S.state = 'playing'; Canvas.notify('state'); } });
  on('playback:stateChanged', (d) => { if (d.state) S.state = stateOf(d.state); if (d.position != null) Pos.sample(d); Canvas.notify('state'); });
  on('playback:paused', (d) => { setPos(getPos()); S.state = d.paused ? 'paused' : 'playing'; Canvas.notify('state'); });
  on('playback:stopped', (d) => { if (!/another|starting/i.test(String(d.reason || ''))) { S.state = 'stopped'; setPos(0); Canvas.notify('state'); } });
  on('playback:time', Pos.coarse);
  on('playback:timeHighRes', Pos.fine);
  on('playback:seeked', (d) => { Pos.seeked(d.position); Canvas.notify('seek'); });
  on('playback:dynamicInfoTrack', (d) => { if (S.track && d.title) { S.track = { ...S.track, title: d.title, artist: d.artist || S.track.artist }; Canvas.notify('track'); } });
  on('playback:edited', (d) => { const t = normTrack(d); if (t) setTrack(t); });
  Theme.onPalette(() => Canvas.notify('palette'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  // events can be missed while the window is hidden; a cheap resync keeps the clock honest
  setInterval(() => { if (document.visibilityState === 'visible') call('playback.getPosition').then((r) => { if (ok(r) && Math.abs(+r.position - getPos()) > 0.6) { Pos.sample(r); Canvas.notify('seek'); } }); }, 5000);
}

function firstRunTip() {
  const tip = document.createElement('div');
  tip.className = 'cv-tip';
  tip.innerHTML = `<b>${$t('Холст в отдельном окне')}</b>${$t('<kbd>F</kbd> — на весь экран')}`;
  document.body.appendChild(tip);
  const kill = () => tip.remove();
  setTimeout(kill, 15000);
  addEventListener('dblclick', kill, { once: true });
  addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') kill(); });
}

(async function boot() {
  await loadSprite();
  if (!(await waitForBridge())) { document.body.insertAdjacentHTML('beforeend', `<div class="cv-tip"><b>${$t('Нет связи с foobar2000')}</b>${$t('Эта страница открывается из Gatefold.')}</div>`); return; }
  Canvas.setHost(host);
  bind();
  await sync();
  await Canvas.open();
  const st = await call('window.getState');
  host.fullscreen = ok(st) && !!(st.isFullscreen ?? st.fullscreen);
  if (host.fullscreen) unpin();          // the popup can be created already fullscreen
  const saved = Canvas.savedBounds();
  if (saved && saved.fullscreen && !host.fullscreen) {
    const r = await setFullscreen(true);
    host.fullscreen = ok(r) && !!(r.fullscreen ?? r.isFullscreen ?? true);
  }
  if (!saved) firstRunTip();
  // remember where the user keeps the window (moving it fires no DOM event)
  let last = '';
  setInterval(async () => {
    const s2 = await call('window.getState'); host.fullscreen = ok(s2) && !!(s2.isFullscreen ?? s2.fullscreen);
    if (host.fullscreen) return;
    const b = await call('window.getBounds'); if (!ok(b)) return;
    const k = [b.x, b.y, b.width, b.height].join(); if (k !== last) { last = k; Canvas.saveBounds(); }
  }, 4000);
})();
