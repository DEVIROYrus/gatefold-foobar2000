/*
 * Gatefold · app.js — boot, window chrome, playback state, Now Playing, player bar.
 */
import './input-guard.js';
import './i18n-boot.js';
import './tooltip.js';
import './select.js';
import './coverfit.js';
import * as UpdUI from './update-ui.js';
import * as Welcome from './welcome.js';
import * as WinInteg from './wininteg.js';
import * as Mini from './mini.js';
import * as Radio from './radio.js';
import * as Ambient from './ambient.js';
import * as Sound from './ml/sound.js';
import * as SoundUI from './ml/sound-ui.js';
import * as Genres from './ml/genres.js';
import { waitForBridge, call, on, ok, normTrack, esc, fmtTime, debounce, log, albumKeyOf, hasBridge, artUrl, plural } from './bridge.js';
import { settings, setSetting, onSettings } from './settings.js';
import { router, onRoute, $, h, icon, toast, popupMenu, closeMenus } from './ui.js';
import * as Theme from './theme.js';
import * as WFS from './winfs.js';
import * as Viz from './viz.js';
import * as Loud from './loudness.js';
import { follower } from './position.js';
import * as VU from './vu.js';
import * as CF from './coverfetch.js';
import * as Lib from './library.js';
import * as SoundPanel from './soundpanel.js';
import * as Folders from './folders.js';
import * as VIS from './visual.js';
import * as LY from './lyrics.js';
import * as Canvas from './canvas.js';
import * as Likes from './likes.js';
import { slot, bgCall, idle as idleP } from './sched.js';
import './panels.js';
import * as Art from './artists.js';
import './dropzone.js';

import { $t } from './i18n.js';
import * as Own from './ownart.js';
import * as CoverPick from './coverpick.js';
const root = document.documentElement, body = document.body;
const app = { track: null, state: 'stopped', art: { available: false, url: '', small: '', key: '' }, volume: 100, muted: false, order: 0, maximized: false, fullscreen: false, standalone: false };
window.aurora = app; // handy in DevTools

// ================================================================ appearance
function applyAppearance(key) {
  const b = settings.baseSize;
  const px = (k) => Math.round(b * k) + 'px';
  root.style.setProperty('--fs-xs', px(0.79)); root.style.setProperty('--fs-sm', px(0.875)); root.style.setProperty('--fs', b + 'px');
  root.style.setProperty('--fs-md', px(1.08)); root.style.setProperty('--fs-lg', px(1.29)); root.style.setProperty('--fs-xl', px(1.65));
  root.style.setProperty('--fs-2xl', px(2.35)); root.style.setProperty('--fs-hero', px(3.7));
  { const m = Lib.rowMetrics(b); root.style.setProperty('--row', m.row + 'px'); root.style.setProperty('--rowc', m.rowc + 'px'); root.style.setProperty('--head', m.head + 'px'); }
  root.style.setProperty('--tx', settings.transitionMs + 'ms');
  root.dataset.font = settings.fontMode;
  root.dataset.crisp = settings.crispText ? '1' : '0';
  if (key === 'crispText' || key === 'ambient') Ambient.refresh();
  root.dataset.lyr = settings.lyricsSize || 'm';
  body.classList.toggle('no-ambient', !settings.ambient);
  body.classList.toggle('no-motion', !settings.ambientMotion);
  body.classList.toggle('no-viz', !settings.visualizer);
  body.classList.toggle('side-collapsed', !!settings.sidebarCollapsed);
  if (key === 'colorSource' || key === '*') Theme.refreshSource();
  else if (key === 'themeMode' || key === 'colorIntensity') Theme.rebuild();
  if (key === 'customTheme' && settings.colorSource === 'custom') Theme.refreshSource();
  if (key === 'albumColors') Theme.reapply();
  if (key === 'waveformSeek') { if (settings.waveformSeek) Viz.loadWaveform(app.track); else Viz.refreshWaveVisibility(); }
  if (key === 'backdrop') applyBackdrop();
  if (key === 'baseSize') setTimeout(() => { Viz.resizeAll(); updateDragRegions(); Lib.relayoutForFont(); Art.relayoutArtists && Art.relayoutArtists(); }, 50);
  updateSpectrum();
}
onSettings((k) => applyAppearance(k));

// ---------------------------------------------------------------- fun mode (loaded only when on)
const funCore = () => import('./fun/core.js');
onSettings((k, v) => {
  if (k === 'funMode') funCore().then((m) => (v ? m.enable() : m.disable()));
  if (k === '*' && !settings.funMode) funCore().then((m) => m.isEnabled() && m.disable());
});
/* the only door: 10 quick clicks on «Gatefold» switch the mode on and off; while it is on,
   a right click on the logo opens its window (styles, achievements) */
{
  const brand = document.querySelector('.brand');
  let clicks = [];
  brand?.addEventListener('click', () => {
    const t = Date.now(); clicks = clicks.filter((x) => t - x < 4000); clicks.push(t);
    brand.classList.remove('tap'); void brand.offsetWidth; if (clicks.length >= 6) brand.classList.add('tap');
    if (clicks.length >= 10) { clicks = []; setSetting('funMode', !settings.funMode); }
  });
  brand?.addEventListener('contextmenu', async (e) => {
    if (!settings.funMode) return;
    e.preventDefault(); e.stopPropagation();
    const id = await popupMenu([{ id: 'panel', label: $t('Стили и достижения…') }, { id: 'trophies', label: $t('Все достижения') }, { type: 'sep' }, { id: 'off', label: $t('Выключить режим приколов') }], e.clientX, e.clientY + 6);
    if (id === 'panel') funCore().then((m) => m.openPanel());
    if (id === 'trophies') funCore().then(async (m) => { if (!m.isEnabled()) await m.enable({ quiet: true }); (await import('./fun/achievements.js')).trophyRoom(); });
    if (id === 'off') setSetting('funMode', false);
  });
}

// grain texture, generated once (no network, no per-frame cost)
function makeGrain() {
  const c = document.createElement('canvas'); c.width = c.height = 180;
  const x = c.getContext('2d'), d = x.createImageData(180, 180);
  for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
  x.putImageData(d, 0, 0);
  document.querySelector('#bg .grain').style.backgroundImage = `url(${c.toDataURL()})`;
}

// ================================================================ window chrome
async function initWindow() {
  const m = await call('window.getMode');
  app.standalone = ok(m) && !m.panelMode && (m.mode === 'standalone' || !m.mode);
  if (!app.standalone) { body.classList.add('panel-mode'); return; }
  if (settings.frameless) {
    const r = await call('window.setFrameless', { frameless: true });
    if (!ok(r)) body.classList.add('native-frame');
  } else {
    body.classList.add('native-frame');
    call('window.setFrameless', { frameless: false });
  }
  const s = await call('window.getState');
  if (ok(s)) setWinState(s);
  if (ok(s)) fitOnScreen(s);
  call('window.setMinSize', { width: Math.round(760 * devicePixelRatio), height: Math.round(520 * devicePixelRatio) });
  applyBackdrop();
  updateDragRegions();
  new ResizeObserver(debounce(updateDragRegions, 60)).observe($('titlebar'));
  on('window:stateChanged', setWinState);
}

/* the first start on a small screen (1366 × 768, a 1024 × 768 VM) can open the window larger than the
   screen, its left edge and the sidebar out of reach: bring it inside, centred. Only when it is
   bigger than the work area or mostly off it — a window kept half on another monitor stays put. */
async function fitOnScreen(s) {
  if (s.isMaximized || s.maximized || s.isFullscreen || s.fullscreen || s.isMinimized || s.minimized) return;
  const b = await call('window.getBounds'); if (!ok(b) || !(b.width > 0)) return;
  const d = devicePixelRatio || 1;
  const L = (screen.availLeft || 0) * d, T = (screen.availTop || 0) * d, W = screen.availWidth * d, H = screen.availHeight * d;
  if (!(W > 0 && H > 0)) return;
  const vis = Math.max(0, Math.min(b.x + b.width, L + W) - Math.max(b.x, L)) * Math.max(0, Math.min(b.y + b.height, T + H) - Math.max(b.y, T));
  if (b.width <= W + 2 && b.height <= H + 2 && vis >= b.width * b.height * 0.6) return;
  const w = Math.min(b.width, W), h = Math.min(b.height, H);
  call('window.setBounds', { x: Math.round(L + (W - w) / 2), y: Math.round(T + (H - h) / 2), width: Math.round(w), height: Math.round(h) });
}

function setWinState(s) {
  app.maximized = !!(s.isMaximized ?? s.maximized);
  app.fullscreen = !!(s.isFullscreen ?? s.fullscreen);
  $('capMaxIcon').setAttribute('href', app.maximized ? '#i-restore' : '#i-max');
  body.classList.toggle('fullscreen', app.fullscreen);
  const minimized = !!(s.isMinimized ?? s.minimized);
  Viz.vizState.windowVisible = !minimized && document.visibilityState === 'visible';
  body.classList.toggle('paused-bg', !Viz.vizState.windowVisible);
  updateSpectrum(); Viz.kick();
  setTimeout(updateDragRegions, 30);
}

const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
function updateDragRegions() {
  if (!app.standalone || body.classList.contains('native-frame')) return;
  const tb = $('titlebar');
  call('window.setDragRegions', { regions: [rect(tb)] });
  // the logo is clickable (10 clicks = «Режим приколов»), so it must not be a window-drag area
  call('window.setNoDragRegions', { regions: [...tb.querySelectorAll('button, .search, .brand')].map(rect) });
  call('window.setMaximizeButtonRegion', { region: rect($('capMax')) }).then((r) => { if (ok(r) && r.snapLayouts) $('capMax').removeAttribute('title'); });
}

async function applyBackdrop() {
  if (!app.standalone) return;
  const mica = settings.backdrop === 'mica';
  await call('window.setBackgroundTransparency', { transparent: mica });
  await call('window.setMica', { enabled: mica, variant: 'mica-alt', darkMode: root.dataset.scheme !== 'light' });
  body.classList.toggle('mica', mica);
  document.documentElement.classList.toggle('mica', mica); // instead of :root:has(body.mica)
  document.getElementById('bg').style.opacity = mica ? '0.82' : '';
  Ambient.refresh();
}

$('capMin').onclick = () => call('window.minimize');
$('capMax').onclick = () => call(app.maximized ? 'window.restore' : 'window.maximize');
$('capClose').onclick = () => call('window.close');
$('btnFull').onclick = () => Canvas.open();
$('btnMini').onclick = (e) => Mini.open({ minimizeMain: e.shiftKey });
async function toggleFullscreen() {
  if (!app.standalone) return;
  const r = await WFS.setFullscreen(!app.fullscreen);
  if (ok(r)) { app.fullscreen = !!r.fullscreen; body.classList.toggle('fullscreen', app.fullscreen); if (app.fullscreen) router.go('now'); }
}
$('btnSidebar').onclick = () => { setSetting('sidebarCollapsed', !settings.sidebarCollapsed); setTimeout(() => { updateDragRegions(); Viz.resizeAll(); }, 280); };

// foobar2000 main menu, rendered in the theme's own popup
$('btnMainMenu').onclick = async (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const res = await call('menu.getMainMenu', {});
  let items = ok(res) && Array.isArray(res.items) && res.items.length ? mapMenu(res.items, '') : null;
  if (!items) items = [
    { id: JSON.stringify({ p: 'File/Add files...' }), label: $t('Добавить файлы…') },
    { id: JSON.stringify({ p: 'File/Add folder...' }), label: $t('Добавить папку…') },
    { type: 'sep' },
    { id: JSON.stringify({ p: 'Library/Search' }), label: $t('Поиск по медиатеке (foobar)') },
    { id: JSON.stringify({ p: 'View/Console' }), label: $t('Консоль') },
    { id: JSON.stringify({ p: 'File/Preferences' }), label: $t('Настройки foobar2000') },
  ];
  const id = await popupMenu(items, r.left, r.bottom + 4);
  if (!id) return;
  runMenu(JSON.parse(id), r.left, r.bottom + 4);
};

/* foobar's own dialogs have dedicated calls — no name lookup involved */
const DIRECT = { 'file/preferences': 'misc.showPreferences', 'view/console': 'misc.showConsole', 'library/search': 'misc.showLibrarySearch' };
const norm = (p) => String(p || '').toLowerCase().replace(/\.{3}|…/g, '').replace(/\s+/g, ' ').trim();
/**
 * Run a main-menu command. GUID first (stable, language-independent). A command
 * known only by its path is resolved by the host by its LAST segment, so several
 * commands named e.g. "Preferences" make it fail with MENU_MATCH_AMBIGUOUS —
 * then the candidate is picked by its internal name, or the user picks.
 */
export async function runMenu(c, x = innerWidth / 2 - 120, y = 80) {
  if (c.g) {
    const out = await call('menu.runMainMenuCommand', { command: c.g, ...(c.s ? { subGuid: c.s } : {}) });
    if (!ok(out)) toast($t('Команда недоступна: ') + esc(out.error || out.code || ''));
    return out;
  }
  const direct = DIRECT[norm(c.p)] || DIRECT[norm(String(c.p).split('/').slice(-2).join('/'))];
  if (direct) { const r = await call(direct, {}); if (ok(r)) return r; }
  let out = await call('menu.runMainMenuCommand', { command: c.p });
  if (!ok(out) && out.code === 'MENU_MATCH_AMBIGUOUS' && Array.isArray(out.candidates) && out.candidates.length) {
    const leaf = norm(String(c.p).split('/').pop());
    const exact = out.candidates.filter((k) => norm(k.name) === leaf);
    let guid = exact.length === 1 ? exact[0].guid : '';
    if (!guid) guid = await popupMenu(out.candidates.map((k) => ({ id: k.guid, label: k.displayLabel || k.name })), x, y) || '';
    if (!guid) return out;
    out = await call('menu.runMainMenuCommand', { command: guid });
  }
  if (!ok(out)) toast($t('Команда недоступна: ') + esc(out.error || out.code || ''));
  return out;
}
function mapMenu(arr, prefix) {
  return arr.filter((it) => it && !it.hidden).map((it) => {
    if (it.type === 'separator' || it.separator) return { type: 'sep' };
    const label = String(it.displayLabel || it.label || it.name || '').replace(/&(?!&)/g, '').replace(/\t.*$/, '');
    const kids = it.children || it.items || it.submenu;
    const path = it.path || (prefix ? prefix + '/' + label : label);
    const isMenu = kids && kids.length;
    return {
      id: JSON.stringify(it.guid ? { g: it.guid, s: it.subGuid || '' } : { p: path, c: it.commandId }),
      label, checked: !!(it.checked || it.radioChecked),
      disabled: !isMenu && (it.enabled === false || it.available === false),
      children: isMenu ? mapMenu(kids, path) : null,
    };
  }).filter((x, i, a) => !(x.type === 'sep' && (i === 0 || a[i - 1].type === 'sep')));
}

// ================================================================ playback state
const stateOf = (s) => { s = String(s || '').toLowerCase(); return s.includes('pause') ? 'paused' : s.includes('play') ? 'playing' : 'stopped'; };

function setState(st) {
  app.state = st;
  const playing = st === 'playing';
  body.classList.toggle('is-playing', playing);
  $('playIcon').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('npKicker').textContent = st === 'stopped' ? (app.track ? $t('Остановлено') : $t('Ничего не играет')) : playing ? $t('Сейчас играет') : $t('Пауза');
  Viz.setProgress(Viz.getPosition(), null, playing);
  updateSpectrum();
  Lib.shared.isPlaying = playing;
  lyrKick();
  Canvas.notify('state');
}

export function refreshSpectrum() { updateSpectrum(); }
/** Read-only view of the player state for optional modules. */
export const player = () => app;
function updateSpectrum() {
  const want = app.state === 'playing' && Viz.vizState.windowVisible &&
    ((router.current === 'now' && (settings.visualizer || settings.beatReact || settings.vuMeters)) || Viz.vizState.extra.size > 0);
  Viz.vizState.nowVisible = router.current === 'now';
  Viz.updateSpectrumSubscription(want);
  VU.kick();
}

async function setTrack(t, { fromEvent = false } = {}) {
  const prevKey = app.track ? albumKeyOf(app.track.albumArtist, app.track.album) : '';
  app.track = t;
  const prevH = Lib.shared.nowHandle;
  Lib.shared.nowHandle = t ? t.handle || t.path || '' : ''; Folders.nowPlaying();
  if (!t) {
    $('npTitle').textContent = 'Gatefold'; $('npArtist').textContent = ''; $('npAlbum').textContent = ''; $('npYear').textContent = '';
    $('pbTitle').textContent = '—'; $('pbArtist').textContent = ''; $('npBadges').innerHTML = ''; $('npActions').innerHTML = '';
    document.title = 'Gatefold';
    showArt(null); Viz.setProgress(0, 0, false);
    return;
  }
  Canvas.notify('track');
  $('npTitle').textContent = t.title;
  $('npArtist').textContent = t.artist;
  $('npAlbum').textContent = t.album;
  $('npYear').textContent = t.year ? ` · ${t.year}` : '';
  setPbMeta(t);
  document.title = `${t.title} — ${t.artist}`;
  call('window.setTitle', { title: `${t.artist} — ${t.title}` });
  Viz.setProgress(fromEvent ? 0 : Viz.getPosition(), t.duration, app.state === 'playing');
  $('tTot').textContent = fmtTime(t.duration);
  renderBadges(t);
  if (settings.soundAI) Genres.want(t.albumArtist || t.artist, t.album);
  const key = albumKeyOf(t.albumArtist, t.album);
  if (key !== prevKey || !app.art.key) await loadArt(t);
  Viz.loadWaveform(t);
  schedulePrefetch();
  renderNpPanel();
  Lib.refreshPlayingRow();
  refreshPlayingIndex();
}

async function renderBadges(t) {
  const r = await call('titleformat.eval', { pattern: '%__bitspersample%|%codec_profile%|$if2(%album dynamic range%,%dynamic range%)|$if(%replaygain_album_gain%,1,$if(%replaygain_track_gain%,1,))|%play_count%' });
  const [bits, profile, dr, rg, plays] = ok(r) ? String(r.result).split('|') : [];
  const b = [];
  if (t.codec) b.push(`<span class="chip accent">${esc(t.codec)}${profile && !/^(lossless|cbr|\?+|unknown)$/i.test(profile.trim()) ? ' ' + esc(profile.trim()) : ''}</span>`);
  if (t.sampleRate) b.push(`<span class="chip">${bits && bits !== '?' ? bits + '-bit / ' : ''}${(t.sampleRate / 1000).toFixed(1).replace('.0', '')} ${$t('кГц')}</span>`);
  if (t.bitrate) b.push(`<span class="chip">${t.bitrate} ${$t('кбит/с')}</span>`);
  if (t.channels && t.channels !== 2) b.push(`<span class="chip">${t.channels} ${$t('кан.')}</span>`);
  if (dr && /^\d+$/.test(dr.trim())) b.push(`<span class="chip" title="${$t('Динамический диапазон (foo_dr_meter)')}">DR${dr.trim()}</span>`);
  if (rg === '1') b.push('<span class="chip" title="ReplayGain">RG</span>');
  if (plays && +plays > 0) b.push(`<span class="chip" title="${$t('Прослушиваний (foo_playcount)')}">▶ ${plays}</span>`);
  b.push(`<span class="np-sound">${SoundUI.chips(t)}</span>`);
  $('npBadges').innerHTML = b.join('');
}
/* the sound-analysis chips appear as soon as the playing track has been analysed */
let genresStarted = false;
const refreshSoundChips = () => {
  const box = document.querySelector('#npBadges .np-sound');
  if (box && app.track) { const html = SoundUI.chips(app.track); if (html !== box.innerHTML) box.innerHTML = html; }
};
Sound.events.addEventListener('change', () => {
  if (!genresStarted && Sound.ready()) { genresStarted = true; Genres.start(); }
  const box = document.querySelector('#npBadges .np-sound');
  if (box && app.track && !box.childElementCount) refreshSoundChips();
});
Genres.events.addEventListener('change', refreshSoundChips);

// ---------------------------------------------------------------- next album, prepared ahead
/* While a track plays, the next album's cover is fetched at the exact URL the
   player will ask for (same raw path → same host cache entry, same browser cache
   entry) and decoded, and its palette + blurred backdrop are computed. At the
   track change the crossfade and the recolouring start immediately. Only for
   orders where "next" is known; through the background budget. */
const ahead = new Map(); // url → decoded Image (keeps it in the memory cache)
let prefT = 0;
function schedulePrefetch() { clearTimeout(prefT); prefT = setTimeout(prefetchNext, 4000); }
async function prefetchNext() {
  const cur = app.track;
  if (!cur || app.state !== 'playing') return;
  const ord = ORDERS[app.order] ? ORDERS[app.order][0] : 'default';
  if (ord !== 'default' && ord !== 'repeat-playlist') return;
  await slot('low');
  const F = ['title', 'artist', 'album', 'albumArtist', 'path', 'absolutePath', 'subsong'];
  let next = null;
  const q = await bgCall('queue.get', {});
  const qi = ok(q) && (q.items || q.tracks || q.queue);
  if (Array.isArray(qi) && qi.length) next = normTrack(qi[0]);
  if (!next) {
    const ci = await bgCall('playback.getCurrentTrackIndex', {});
    if (!ok(ci) || ci.found === false) return;
    let r = await bgCall('playlist.getTracks', { playlist: ci.playlist, start: ci.index + 1, count: 1, fields: F });
    if (ok(r) && !(r.tracks || []).length && ord === 'repeat-playlist') r = await bgCall('playlist.getTracks', { playlist: ci.playlist, start: 0, count: 1, fields: F });
    next = ok(r) && r.tracks && r.tracks[0] ? normTrack(r.tracks[0]) : null;
  }
  if (!next || app.track !== cur) return;
  if (albumKeyOf(next.albumArtist, next.album) === albumKeyOf(cur.albumArtist, cur.album)) return;
  const raw = next.rawPath || next.path;
  const big = Math.min(1600, Math.round(640 * Math.min(2, devicePixelRatio)));
  const b = await bgCall('artwork.getFb2kUrlByPathBatch', { items: [{ path: raw, maxSize: big }, { path: raw, maxSize: 128 }], type: 'front' });
  const rows = (ok(b) && b.artworks) || [];
  const [ub, us] = [rows[0], rows[1]].map((x) => (x && x.available !== false && x.dataUrl ? artUrl(x.dataUrl) : ''));
  if (ub && !ahead.has(ub)) {
    const im = new Image(); im.decoding = 'async'; im.src = ub;
    try { await im.decode(); ahead.set(ub, im); } catch { /* no art: nothing to prepare */ }
    while (ahead.size > 3) ahead.delete(ahead.keys().next().value);
  }
  if (us && await Theme.prefetchAlbum(next, us)) log('prepared next album:', next.album);
}

// ---------------------------------------------------------------- album art
let artToken = 0, imgFlip = false;
const loadsOk = (url) => new Promise((res) => { const im = new Image(); im.onload = () => res(im.naturalWidth > 1); im.onerror = () => res(false); im.src = url; });

async function loadArt(t) {
  const token = ++artToken;
  // a cover you chose and Gatefold keeps (ownart.js) comes first; such an album is never searched for
  const own = await Own.urlForPath(t.handle || t.path, 'full');
  if (own) {
    const small = await Own.urlForPath(t.handle || t.path, 'thumb');
    if (token !== artToken) return;
    app.art = { available: true, url: own, small: small || own, key: albumKeyOf(t.albumArtist, t.album), own: true };
    showArt(own); Canvas.notify('art'); Theme.themeForTrack(t, app.art); renderNpActions();
    return;
  }
  const [big, small] = await Promise.all([
    call('artwork.getFb2kUrl', { type: 'front', maxSize: Math.min(1600, Math.round(640 * Math.min(2, devicePixelRatio))) }),
    call('artwork.getFb2kUrl', { type: 'front', maxSize: 128 }),
  ]);
  if (token !== artToken) return;
  // A fb2k:// URL is only a promise of an image — verify it really decodes.
  let url = ok(big) && big.available !== false && big.dataUrl ? artUrl(big.dataUrl) : '';
  if (url && !(await loadsOk(url))) url = '';
  if (!url) {
    const d = await call('artwork.getCurrent', { type: 'front' });
    if (ok(d) && d.available !== false && d.dataUrl && await loadsOk(d.dataUrl)) url = d.dataUrl;
  }
  if (token !== artToken) return;
  app.art = { available: !!url, url, small: url && ok(small) && small.dataUrl && small.dataUrl.startsWith('fb2k') === url.startsWith('fb2k') ? artUrl(small.dataUrl) : url, key: albumKeyOf(t.albumArtist, t.album) };
  showArt(url || null);
  Canvas.notify('art');
  Theme.themeForTrack(t, app.art);
  renderNpActions();
  if (!url && settings.coverAuto) {
    const job = CF.jobFromTrack(t);
    if (job && CF.enqueue(job, true)) setArtEmpty($t('Ищу обложку…'), true);
  }
}

function showArt(url) {
  const a = $('npImgA'), b = $('npImgB');
  const [next, prev] = imgFlip ? [a, b] : [b, a];
  if (!url) { a.classList.remove('on'); b.classList.remove('on'); $('npArtEmpty').style.display = ''; setArtEmpty($t('Нет обложки')); $('pbArt').innerHTML = ''; return; }
  imgFlip = !imgFlip;
  next.onload = async () => {
    try { await next.decode(); } catch {}
    next.classList.add('on'); prev.classList.remove('on');
    $('npArtEmpty').style.display = 'none';
  };
  next.onerror = null;
  next.src = url;
  $('pbArt').innerHTML = `<img alt="" src="${esc(app.art.small || url)}">`;
}
function setArtEmpty(text, busy) { $('npArtEmptyText').innerHTML = busy ? `<span style="display:inline-flex;gap:8px;align-items:center"><span class="spinner"></span>${esc(text)}</span>` : esc(text); }

function renderNpActions() {
  const box = $('npActions');
  box.innerHTML = '';
  const t = app.track; if (!t) return;
  const btn = (html, fn, cls = '') => { const e = h(`<button class="btn sm ${cls}">${html}</button>`); e.onclick = fn; box.append(e); return e; };
  const lk = btn('', () => toggleLike(), 'like-pill'); lk.id = 'npLike';
  syncLike();
  if (t.album) btn($t('{0}Альбом', icon('grid')), openNpAlbum).id = 'npAlbumBtn';
  function openNpAlbum() { openTrackAlbum(t); }
  if (!app.art.available && t.album) btn($t('{0}Обложка…', icon('image')), () => CoverPick.open(Lib.albumOfTrack(t)), 'primary');
  // the track playing when the button is pressed: these buttons are drawn when the cover changes,
  // so within one album `t` would still be the first track that played (the radio then started from it)
  if (t.artist) btn($t('{0}Радио', icon('sparkle')), () => app.track && Radio.start(app.track));
  if (settings.soundAI) btn($t('{0}Похожие', icon('queue')), () => app.track && SoundUI.similar(app.track));
  btn(`${icon('more')}`, () => call('menu.showNativePopup', { mode: 'nowPlaying' }));
}

Own.events.addEventListener('change', () => { if (app.track) loadArt(app.track); });
CF.events.addEventListener('saved', async (e) => {
  const { job, url, cand } = e.detail;
  toast(`${$t('Обложка установлена:')} <b>${esc(job.album)}</b> · ${esc(cand.src)}`, { img: url });
  if (app.track && job.key === albumKeyOf(app.track.albumArtist, app.track.album)) {
    app.art = { ...app.art, available: true, url, small: url };
    showArt(url);
    Canvas.notify('art');
    Theme.themeFromUrl(app.track, url);
    renderNpActions();
    if (npTab === 'next') renderNpPanel();
    // once foobar has picked up cover.jpg, switch to its own (cached, resizable) URL
    setTimeout(() => { if (app.track && job.key === albumKeyOf(app.track.albumArtist, app.track.album)) loadArt(app.track); }, 2500);
  }
});
CF.events.addEventListener('repaired', () => { if (app.track) { app.art.key = ''; loadArt(app.track); } });
CF.events.addEventListener('change', () => {
  if (!app.track || app.art.available) return;
  const key = albumKeyOf(app.track.albumArtist, app.track.album);
  if (!(CF.state.busy && CF.state.busy.key === key) && !CF.state.queue.some((j) => j.key === key)) setArtEmpty($t('Нет обложки'));
});

// ---------------------------------------------------------------- Now Playing panel (next / lyrics / palette)
let npTab = 'next', lyr = null;
document.querySelectorAll('.np-tab').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.np-tab').forEach((x) => x.classList.toggle('active', x === b));
  npTab = b.dataset.tab; renderNpPanel();
});

async function refreshPlayingIndex() {
  const r = await call('playback.getCurrentTrackIndex');
  if (ok(r) && r.found !== false) { Lib.shared.playing = { playlist: r.playlist, index: r.index }; Lib.refreshPlayingRow(); }
  return r;
}

async function renderNpPanel() {
  const box = $('npPanel');
  if (npTab !== 'lyrics' && lyrView) { lyrView.destroy(); lyrView = null; lyrFor = ''; box.classList.remove('lyr-mode'); box.innerHTML = ''; }
  if (npTab === 'next') {
    const ci = await refreshPlayingIndex();
    if (!ok(ci) || ci.found === false) { box.innerHTML = '<div class="empty" style="padding:20px">—</div>'; return; }
    const r = await call('playlist.getTracks', { playlist: ci.playlist, start: ci.index + 1, count: 15, fields: ['title', 'artist', 'album', 'duration', 'absolutePath'] });
    const rows = (ok(r) && r.tracks) || [];
    if (npTab !== 'next') return;
    if (!rows.length) { box.innerHTML = `<div class="empty" style="padding:20px">${$t('Это последний трек плейлиста')}</div>`; return; }
    box.innerHTML = rows.map((t) => `<div class="up-row" data-i="${t.index}"><img alt="" style="visibility:hidden"><div style="min-width:0"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)} · ${esc(t.album)}</div></div><div class="d num">${fmtTime(t.duration)}</div></div>`).join('');
    box.ondblclick = (e) => { const row = e.target.closest('.up-row'); if (row) call('playlist.playTrack', { playlist: ci.playlist, index: +row.dataset.i }); };
    const paths = [...new Set(rows.map((t) => t.absolutePath))];
    const a = await call('artwork.getFb2kUrlByPathBatch', { paths, maxSize: 80 });
    const arr = ok(a) && (a.artworks || a.items);
    const map = new Map(paths.map((p, i) => [p, Array.isArray(arr) && arr[i] && arr[i].available !== false ? artUrl(arr[i].dataUrl || arr[i].url) : '']));
    box.querySelectorAll('.up-row').forEach((el, i) => { const u = map.get(rows[i].absolutePath); const img = el.querySelector('img'); if (u) { img.src = u; img.style.visibility = ''; } else img.replaceWith(h('<div class="ph"></div>')); });
  } else if (npTab === 'lyrics') {
    await renderLyricsTab(false);
  } else {
    const p = Theme.current.palette;
    if (!p) { box.innerHTML = ''; return; }
    const role = (n, c) => `<div style="display:flex;align-items:center;gap:10px;padding:4px 0"><i style="width:22px;height:22px;border-radius:6px;background:${c.hex};box-shadow:inset 0 0 0 1px var(--line)"></i><span style="flex:1;color:var(--text-2)">${n}</span><code class="num" style="color:var(--text-3)">${c.hex}</code></div>`;
    box.innerHTML = `<div class="swatches" style="margin-bottom:10px">${p.swatches.map((s) => `<i title="${s.hex} · ${Math.round(s.share * 100)}%" style="background:${s.hex};width:${Math.max(16, Math.round(s.share * 160))}px"></i>`).join('')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;column-gap:24px">${role($t('Фон'), p.bg)}${role($t('Поверхность'), p.surface)}${role($t('Акцент'), p.accent)}${role($t('Акцент · текст'), p.accentInk)}${role($t('Второй акцент'), p.accent2)}${role($t('Свечение'), p.glow)}${role($t('Текст'), p.text)}${role($t('Вторичный текст'), p.text2)}</div>
      <div class="desc" style="margin-top:8px">${$t('{0} схема · {1} · средняя светлота {2}%', p.dark ? $t('Тёмная') : $t('Светлая'), p.monochrome ? $t('монохромная обложка') : $t('кластеров: ') + p.stats.clusters, (p.stats.avgL * 100).toFixed(0))}</div>`;
  }
}
Theme.onPalette(() => Ambient.changed());
Theme.onPalette(() => { if (npTab === 'palette' && router.current === 'now') renderNpPanel(); Canvas.notify('palette'); });

// ---------------------------------------------------------------- lyrics tab
let lyrView = null, lyrFor = '', lyrDoc = null;
async function renderLyricsTab(force) {
  const box = $('npPanel');
  const t = app.track;
  if (!lyrView || !box.contains(lyrView.el)) {
    box.classList.add('lyr-mode');
    box.innerHTML = '<div class="lyr-bar" id="lyrBar"></div><div id="lyrBox"></div>';
    lyrView = new LY.LyricView($('lyrBox'), {
      getPos: Viz.getPosition,
      seek: (p) => { call('playback.setPosition', { position: p }); Pos.seeked(p); lyrView && lyrView.kick(); },
      playing: () => app.state === 'playing',
      variant: 'panel',
    });
    lyrFor = '';
  }
  if (!t) { lyrView.message(''); $('lyrBar').innerHTML = ''; return; }
  const key = LY.trackKey(t);
  if (!force && lyrFor === key) { lyrView.kick(); return; }
  lyrFor = key; lyrDoc = null;
  lyrView.message('<span class="spinner"></span>');
  renderLyrBar(null, t, true);
  const doc = await LY.getLyrics(t, { refresh: force });
  if (lyrFor !== key || npTab !== 'lyrics' || !lyrView) return;
  lyrDoc = doc;
  const off = doc && doc.synced ? await LY.getOffset(t) : 0;
  if (doc) lyrView.show(doc, off);
  else lyrView.message(`<b>${$t('Текста нет')}</b>`);
  renderLyrBar(doc, t, false, off);
}
function renderLyrBar(doc, t, loading, off = 0) {
  const bar = $('lyrBar'); if (!bar) return;
  bar.innerHTML = '';
  const add = (html, title, fn, cls = 'icon-btn') => { const b = h(`<button class="${cls}" title="${esc(title)}">${html}</button>`); b.onclick = fn; bar.append(b); return b; };
  if (loading) { bar.append(h(`<span class="src">${$t('Ищу текст…')}</span>`)); }
  else {
    const kind = !doc ? '' : doc.instrumental ? '' : doc.synced ? (doc.lines.some((l) => l.words) ? $t(' · по словам') : $t(' · по строкам')) : $t(' · без таймингов');
    const src = h(`<span class="src" title="${$t('Источник текста')}">${doc ? esc(LY.sourceLabel(doc)) + kind : ''}</span>`);
    bar.append(src);
    // other variants found by the other providers: pick one, it is remembered for this track
    if (doc && doc.alts && doc.alts.length > 1) {
      src.classList.add('pick'); src.title = $t('Найдено вариантов: {0} — выбрать другой', doc.alts.length);
      src.onclick = async (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const kindOf = (a) => a.instrumental ? $t('инструментал') : a.synced ? (a.words ? $t('по словам') : $t('по строкам')) : $t('без таймингов');
        const id = await popupMenu(doc.alts.map((a, i) => ({ id: String(i), label: `${LY.sourceLabel({ source: a.src })} · ${kindOf(a)}${a.title ? ' — ' + a.title : ''}`, checked: i === (doc.pick || 0) })), r.left, r.bottom + 4);
        if (id == null || id === 'null' || +id === (doc.pick || 0)) return;
        if (await LY.choose(t, +id)) renderLyricsTab(false);
      };
    }
    if (doc && doc.synced) {
      const show = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + $t(' с');
      const lbl = h(`<span class="off" title="${$t('Сдвиг текста относительно звука')}">${show(off)}</span>`);
      const step = (d) => { off = Math.round((off + d) * 10) / 10; LY.setOffset(t, off); lyrView && lyrView.setOffset(off); lbl.textContent = show(off); };
      add('−', $t('Текст раньше на 0,2 с ( [ )'), () => step(-0.2));
      bar.append(lbl);
      add('+', $t('Текст позже на 0,2 с ( ] )'), () => step(0.2));
      bar._step = step;
    }
    if (doc && doc.alts && !doc.instrumental) add($t('{0}Сохранить', icon('download', 14)), $t('Сохранить .lrc рядом с треком (его увидит и Lyric Show Panel)'), async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await LY.saveToTrack(t, doc.text, 'file'); toast($t('Текст сохранён') + (r.savedTo ? ': ' + esc(r.savedTo.split(/[\\/]/).pop()) : '')); }
      catch (err) { toast($t('Не удалось сохранить: ') + esc(err.message)); e.currentTarget.disabled = false; }
    }, 'btn sm');
  }
  add(icon('refresh', 15), $t('Искать заново (без кэша)'), () => renderLyricsTab(true));
  add(icon('expand', 15), $t('Холст — полноэкранный режим (F)'), () => Canvas.open());
}
function lyrKick() { if (lyrView) lyrView.kick(); }

// ================================================================ player bar
$('btnPlay').onclick = async () => { const r = await call('playback.playOrPause'); if (!ok(r)) call('playback.play'); };
$('btnPrev').onclick = () => call('playback.previous');
$('btnNext').onclick = () => call('playback.next');
$('btnSac').onclick = () => call('playback.toggleStopAfterCurrent');
$('btnQueue').onclick = () => router.go('queue');
SoundPanel.init($('btnSound'));

// ---------------------------------------------------------------- «Понравившиеся»
function syncLike() {
  const t = app.track, on = !!(t && Likes.has(t));
  const b = $('btnLike');
  b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.disabled = !t;
  b.querySelector('use').setAttribute('href', on ? '#i-heart-f' : '#i-heart');
  b.title = on ? $t('Убрать из понравившихся (L)') : $t('В понравившиеся (L)');
  const n = $('npLike');
  if (n) { n.classList.toggle('on', on); n.innerHTML = `<svg><use href="#i-${on ? 'heart-f' : 'heart'}"/></svg>${on ? $t('Нравится') : $t('В понравившиеся')}`; }
}
async function toggleLike(t = app.track) {
  if (!t) return;
  const was = Likes.has(t);
  if (t === app.track) for (const el of [$('btnLike'), $('npLike')]) if (el) { el.classList.remove('pop', 'unpop'); void el.offsetWidth; el.classList.add(was ? 'unpop' : 'pop'); }
  const now = await Likes.toggle(t);
  if (now !== !was) toast($t('Не удалось изменить плейлист «Понравившиеся»'));
}
$('btnLike').onclick = () => toggleLike();
Likes.events.addEventListener('change', () => syncLike());
$('pbArt').onclick = () => router.go('now');
/* player bar: title → the playlist it plays from, artist → artist page, album → album page */
function setPbMeta(t) {
  $('pbTitle').innerHTML = `<span class="lnk" data-go="track" title="${$t('Показать в плейлисте')}">${esc(t.title || '—')}</span>`;
  const parts = [];
  if (t.artist) parts.push(Lib.artistLinks(t.artist, $t('Открыть исполнителя')));
  if (t.album) parts.push(`<span class="lnk" data-go="album" title="${$t('Открыть альбом')}">${esc(t.album)}</span>`);
  $('pbArtist').innerHTML = parts.join('<span class="sep">—</span>');
}
/** the album page of a track's album; `focus` (a track handle) marks that song there */
export async function openTrackAlbum(t, focus = '') {
  if (!t || !t.album) return;
  // an album with several editions: the one this track is on
  const ed = Lib.editionOfPath(t.handle) || Lib.editionOfPath(t.path) || Lib.editionOfPath(t.absolutePath);
  if (ed) { if (focus) Lib.focusNextAlbumTrack(focus); router.go('album', ed); return; }
  const r = await call('library.getAlbums', { query: t.album, limit: 60 });
  const rows = (ok(r) && r.albums) || [];
  const lc = (x) => String(x || '').toLowerCase();
  const row = rows.find((a) => a.name === t.album && (a.albumArtist === t.albumArtist || a.artist === t.albumArtist))
    || rows.find((a) => a.name === t.album && (lc(a.albumArtist) === lc(t.artist) || lc(a.artist) === lc(t.artist)))
    || rows.find((a) => a.name === t.album);
  if (row) { if (focus) Lib.focusNextAlbumTrack(focus); router.go('album', row); } else Lib.openSearch(t.album);
}
document.querySelector('.pb-meta').addEventListener('click', (e) => {
  const l = e.target.closest('.lnk'); const t = app.track; if (!l || !t) return;
  if (l.dataset.go === 'track') Lib.revealPlaying();
  if (l.dataset.go === 'artist') router.go('artist', l.textContent || t.artist || t.albumArtist);
  if (l.dataset.go === 'album') openTrackAlbum(t);
});
$('npArtist').onclick = () => app.track && router.go('artist', app.track.albumArtist || app.track.artist);
$('npAlbum').onclick = () => $('npAlbumBtn')?.click();

const ORDERS = [['default', $t('По порядку'), 'order'], ['repeat-playlist', $t('Повтор плейлиста'), 'repeat'], ['repeat-track', $t('Повтор трека'), 'repeat1'], ['random', $t('Случайно'), 'shuffle'], ['shuffle-tracks', $t('Перемешать треки'), 'shuffle'], ['shuffle-albums', $t('Перемешать альбомы'), 'shuffle'], ['shuffle-folders', $t('Перемешать папки'), 'shuffle']];
function setOrder(i) {
  app.order = Math.max(0, Math.min(ORDERS.length - 1, +i || 0));
  $('orderIcon').setAttribute('href', '#i-' + ORDERS[app.order][2]);
  $('btnOrder').classList.toggle('on', app.order !== 0);
  $('btnOrder').title = $t('Порядок: ') + ORDERS[app.order][1];
}
$('btnOrder').onclick = async (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const id = await popupMenu(ORDERS.map((o, i) => ({ id: String(i), label: o[1], checked: i === app.order })), r.left, r.top - 8 - ORDERS.length * 32 - 10);
  if (id != null) { const res = await call('playback.setPlaybackOrder', { order: +id }); if (ok(res)) setOrder(res.order ?? id); }
};

// volume
const vol = $('vol');
function setVolumeUI(v, muted) {
  if (v != null) app.volume = Math.round(+v);
  if (muted != null) app.muted = !!muted;
  vol.value = app.volume;
  vol.style.setProperty('--p', (app.muted ? 0 : app.volume) + '%');
  $('volIcon').setAttribute('href', app.muted || app.volume === 0 ? '#i-vol-x' : '#i-vol');
}
vol.oninput = () => { setVolumeUI(+vol.value, false); call('playback.setVolume', { volume: +vol.value }); };
vol.addEventListener('wheel', (e) => { e.preventDefault(); const v = Math.max(0, Math.min(100, app.volume + (e.deltaY < 0 ? 3 : -3))); setVolumeUI(v); call('playback.setVolume', { volume: v }); }, { passive: false });
$('btnMute').onclick = () => call('playback.toggleMute');

// seek
const seek = $('seek'), tip = $('seekTip');
let dragging = false;
const fracAt = (e) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
function showTip(f) { tip.textContent = fmtTime(f * (app.track?.duration || 0)); tip.style.left = (f * 100) + '%'; }
seek.addEventListener('pointerdown', (e) => {
  if (!app.track || !app.track.duration) return;
  dragging = true; seek.setPointerCapture(e.pointerId); seek.classList.add('drag');
  const f = fracAt(e); Viz.setDrag(f); showTip(f);
});
seek.addEventListener('pointermove', (e) => {
  const f = fracAt(e); showTip(f);
  if (dragging) Viz.setDrag(f); else Viz.setHover(f);
});
seek.addEventListener('pointerleave', () => { if (!dragging) Viz.setHover(-1); });
const seekReset = () => { if (!dragging) return; dragging = false; seek.classList.remove('drag'); Viz.setDrag(-1); };
seek.addEventListener('lostpointercapture', seekReset);
addEventListener('gatefold:input-reset', seekReset);
seek.addEventListener('pointerup', async (e) => {
  if (!dragging) return;
  dragging = false; seek.classList.remove('drag');
  const pos = fracAt(e) * (app.track?.duration || 0);
  Viz.setDrag(-1); Pos.seeked(pos);
  await call('playback.setPosition', { position: pos });
});

/* the position follows foo_ui_webview2's ~10 Hz playback:timeHighRes (see position.js) */
const Pos = follower({ set: (p, d) => Viz.setProgress(p, d), get: Viz.getPosition, playing: () => app.state === 'playing' });

// elapsed time text: updated only when the visible second changes
let lastSec = -1;
setInterval(() => {
  const s = Math.floor(Viz.getPosition());
  if (s !== lastSec) { lastSec = s; $('tCur').textContent = fmtTime(s); }
}, 200);

// ================================================================ events from foobar2000
function bindEvents() {
  on('playback:trackChanged', (d) => { setTrack(normTrack(d), { fromEvent: true }); });
  on('playback:starting', (d) => { if (!d.paused) setState('playing'); });
  on('playback:stateChanged', (d) => { if (d.state) setState(stateOf(d.state)); if (d.position != null) Pos.sample(d); });
  on('playback:paused', (d) => setState(d.paused ? 'paused' : 'playing'));
  on('playback:stopped', (d) => { if (!/another|starting/i.test(String(d.reason || ''))) { setState('stopped'); Viz.setProgress(0, null, false); } });
  on('playback:time', Pos.coarse);
  on('playback:timeHighRes', Pos.fine);
  on('playback:seeked', (d) => { Pos.seeked(+d.position || 0); lyrKick(); Canvas.notify('seek'); });
  on('playback:volumeChanged', (d) => setVolumeUI(d.volume, d.isMuted ?? d.muted));
  on('playback:orderChanged', (d) => setOrder(d.orderIndex ?? d.order));
  on('playback:stopAfterCurrentChanged', (d) => $('btnSac').classList.toggle('on', !!d.enabled));
  on('playback:dynamicInfoTrack', (d) => { if (app.track && d.title) { app.track.title = d.title; app.track.artist = d.artist || app.track.artist; $('npTitle').textContent = d.title; setPbMeta(app.track); $('npArtist').textContent = app.track.artist; } });
  on('playback:edited', (d) => { const t = normTrack(d); if (t) setTrack(t); });
  on('playlist:itemsReordered', debounce(() => { if (npTab === 'next') renderNpPanel(); }, 300));
  on('system:themeChanged', () => Theme.rebuild());
  document.addEventListener('visibilitychange', () => {
    Viz.vizState.windowVisible = document.visibilityState === 'visible';
    body.classList.toggle('paused-bg', !Viz.vizState.windowVisible);
    updateSpectrum(); Viz.kick(); lyrKick();
    // no position events reach a hidden page: catch up at once instead of waiting for the next one
    if (Viz.vizState.windowVisible && app.track) call('playback.getPosition').then((r) => { if (ok(r)) { Pos.sample(r); lyrKick(); } });
  });
}

async function syncAll() {
  const [cur, st, pos, vo, ord, sac] = await Promise.all([
    call('playback.getCurrentTrack'), call('playback.getState'), call('playback.getPosition'),
    call('playback.getVolume'), call('playback.getPlaybackOrder'), call('playback.getStopAfterCurrent'),
  ]);
  if (ok(st)) setState(stateOf(st.state));
  if (ok(vo)) setVolumeUI(vo.volume, vo.isMuted ?? vo.muted);
  if (ok(ord)) setOrder(ord.orderIndex ?? ord.order);
  if (ok(sac)) $('btnSac').classList.toggle('on', !!sac.enabled);
  const t = ok(cur) && cur.found !== false ? normTrack(cur.track || cur.playing || cur) : null;
  if (t && ok(pos)) { Viz.setProgress(Viz.getPosition(), +pos.duration || t.duration, app.state === 'playing'); Pos.sample(pos); }
  await setTrack(t);
}

// ================================================================ navigation, search, keyboard
document.querySelectorAll('.nav-item[data-view]').forEach((n) => n.addEventListener('click', () => router.go(n.dataset.view)));
onRoute((view) => Ambient.setView(view));
onRoute((view) => {
  updateSpectrum();
  if (view === 'now') { Viz.resizeAll(); if (npTab !== 'lyrics') renderNpPanel(); else lyrKick(); }
  if (view !== 'search') $('searchInput').value = '';
  closeMenus();
});
router.on('now', () => {});
router.on('youtube', (arg) => import('./youtube.js').then((m) => m.open(arg)));

const search = $('searchInput');
search.addEventListener('input', debounce(() => { if (search.value.trim().length >= 2) Lib.openSearch(search.value); }, 260));
search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { search.value = ''; search.blur(); router.back(); } if (e.key === 'Enter') Lib.openSearch(search.value); });

document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  const k = e.key;
  if (e.ctrlKey && k.toLowerCase() === 'f') { e.preventDefault(); search.focus(); search.select(); return; }
  if (e.ctrlKey && k.toLowerCase() === 'r') { e.preventDefault(); location.reload(); return; }
  if (e.ctrlKey && k.toLowerCase() === 'p') { e.preventDefault(); runMenu({ p: 'File/Preferences' }); return; }
  if (e.altKey && k === 'ArrowLeft') { e.preventDefault(); router.back(); return; }
  if (e.altKey && k === 'ArrowRight') { e.preventDefault(); router.forward(); return; }
  if (e.altKey && /^[1-8]$/.test(k)) { e.preventDefault(); router.go(['now', 'playlist', 'artists', 'library', 'queue', 'covers', 'settings', 'youtube'][+k - 1]); return; }
  switch (k) {
    case ' ': e.preventDefault(); $('btnPlay').click(); break;
    case 'ArrowRight': e.preventDefault(); if (e.shiftKey) call('playback.next'); else call('playback.setPosition', { position: Viz.getPosition() + (e.ctrlKey ? 30 : 5) }); break;
    case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) call('playback.previous'); else call('playback.setPosition', { position: Math.max(0, Viz.getPosition() - (e.ctrlKey ? 30 : 5)) }); break;
    case 'ArrowUp': if (!e.target.closest('.scroller')) { e.preventDefault(); const v = Math.min(100, app.volume + 5); setVolumeUI(v); call('playback.setVolume', { volume: v }); } break;
    case 'ArrowDown': if (!e.target.closest('.scroller')) { e.preventDefault(); const v = Math.max(0, app.volume - 5); setVolumeUI(v); call('playback.setVolume', { volume: v }); } break;
    case 'm': case 'M': case 'ь': case 'Ь': call('playback.toggleMute'); break;
    case 'l': case 'L': case 'д': case 'Д': if (!e.ctrlKey && !e.altKey) toggleLike(); break;
    case 'F11': e.preventDefault(); toggleFullscreen(); break;
    case 'i': case 'I': case 'ш': case 'Ш': if (!e.ctrlKey && !e.altKey && router.current === 'album') Lib.toggleAlbumDetails(); break;
    case 'f': case 'F': case 'а': case 'А': if (!e.ctrlKey && !e.altKey) { e.preventDefault(); Canvas.open(); } break;
    case '[': case 'х': case 'Х': if (lyrView && $('lyrBar')?._step) $('lyrBar')._step(-0.2); break;
    case ']': case 'ъ': case 'Ъ': if (lyrView && $('lyrBar')?._step) $('lyrBar')._step(0.2); break;
    case 'Escape': if (app.fullscreen) toggleFullscreen(); else if (['album', 'artist', 'search'].includes(router.current)) router.back(); break;
    case 'Backspace': router.back(); break;
  }
});
/* mouse side buttons: back / forward through Gatefold's own screens (never the page history) */
addEventListener('mousedown', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); }, true);
addEventListener('mouseup', (e) => { if (e.button === 3) { e.preventDefault(); router.back(); } else if (e.button === 4) { e.preventDefault(); router.forward(); } }, true);
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('.vrow, .tile, .atile, .pl-item, input')) e.preventDefault(); });
window.addEventListener('resize', debounce(() => { Viz.resizeAll(); updateDragRegions(); }, 80));

// ================================================================ Canvas («Холст»)
Canvas.setHost({
  standalone: false,
  getPos: Viz.getPosition,
  getDur: () => Viz.progressState.dur || (app.track && app.track.duration) || 0,
  state: () => app.state,
  track: () => app.track,
  art: () => app.art,
  get canFullscreen() { return app.standalone; },
  isFullscreen: () => app.fullscreen,
  onSeek: (p) => Pos.seeked(p),
  onFullscreen: (fs) => { app.fullscreen = fs; body.classList.toggle('fullscreen', fs); },
});
/* ---------------------------------------------------------------- the visualiser behind Now Playing (visual.js) */
let npMd = null;
function syncNowMilk() {
  const eng = VIS.engine();
  const want = eng !== 'off' && !!settings.visNow && router.current === 'now' && !Canvas.opened() && !document.hidden;
  if (npMd && npMd.engine !== eng) { npMd.destroy(); npMd = null; }
  if (want && !npMd) npMd = VIS.createStage($('npMd'), { kind: 'backdrop', playing: () => Lib.shared.isPlaying, track: () => app.track, cover: () => (app.art && app.art.available ? app.art.url : '') });
  if (npMd) { if (want) npMd.start(); else npMd.stop(); }
  $('npMd').classList.toggle('tinted', eng === 'milkdrop' && !!settings.mdTint);
  body.classList.toggle('with-np-md', want);
}
onRoute(syncNowMilk);
onSettings((k) => { if (k === '*' || /^(visual|visNow|md|gf)/.test(k)) syncNowMilk(); });
document.addEventListener('visibilitychange', syncNowMilk);
Canvas.canvasEvents.addEventListener('open', syncNowMilk);
Canvas.canvasEvents.addEventListener('close', syncNowMilk);
/* the character of a track for the choice of presets: 0 calm … 1 vivid (from the sound analysis) */
VIS.setMoodProvider((t) => {
  const r = Sound.get(t); if (!r) return null;
  const up = (Sound.mood(r, 'aggressive') * 1.2 + Sound.mood(r, 'party') + Sound.mood(r, 'danceable') + Sound.mood(r, 'electronic') * 0.5) / 3.7;
  const down = (Sound.mood(r, 'relaxed') + Sound.mood(r, 'sad') * 0.8 + Sound.mood(r, 'acoustic') * 0.7) / 2.5;
  return Math.max(0, Math.min(1, 0.5 + (up - down) * 0.9));
});
Canvas.canvasEvents.addEventListener('error', (e) => toast($t('Не удалось открыть окно: ') + esc(e.detail)));
let lastInput = Date.now();
['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach((ev) => addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true }));
setInterval(() => {
  const m = +settings.canvasIdleMin;
  if (!m || Canvas.opened() || app.state !== 'playing' || document.visibilityState !== 'visible' || !document.hasFocus()) return;
  if (document.querySelector('.menu, .modal')) return; // never over an open menu/dialog
  if (Date.now() - lastInput >= m * 60000) Canvas.open({ auto: true, fullscreen: false });
}, 15000);

Lib.shared.onPlayAlbum = () => { if (router.current !== 'now') toast($t('Воспроизведение начато')); };

// ================================================================ boot
(async function boot() {
  applyAppearance('*');
  makeGrain();
  Ambient.init();
  const bridged = await waitForBridge();
  if (!bridged) {
    body.classList.remove('booting');
    toast($t('Мост foo_ui_webview2 не найден — интерфейс запущен вне foobar2000'), { ms: 8000 });
    router.go('now');
    return;
  }
  bindEvents();
  await initWindow();
  router.go(settings.startView || 'now', null, { push: false });
  await syncAll();
  Lib.renderPlaylists();
  Lib.renderQueue();
  // album list: from the on-disk snapshot at once (counts, Artists, Library), refreshed in the background
  Lib.getAllAlbums();
  Likes.init();
  UpdUI.init();
  Welcome.init();
  Radio.init({ getAllAlbums: Lib.getAllAlbums });
  Own.ready();                                   // your covers (ownart.js), before the first tiles are drawn
  // covers by your path rule: new albums get theirs a while after the start
  if (settings.coverPattern) setTimeout(async () => CoverPick.patternScan(await Lib.getAllAlbums()), 20000);
  Lib.shared.radioFor = (t) => Radio.start(t);
  Lib.shared.radioWhy = (t) => Radio.why(t);
  Lib.shared.openTrackAlbum = (t, focus) => openTrackAlbum(t, focus);
  Lib.shared.radioActive = () => Radio.active();
  Lib.shared.radioBan = (name) => Radio.ban(name);
  Lib.shared.similarFor = (t) => SoundUI.similar(t);
  Sound.init();
  Loud.init();
  Genres.init({ getAllAlbums: Lib.getAllAlbums });
  Lib.getAllAlbums().then((a) => SoundUI.maybeOffer({ albums: (a || []).length }));
  VU.init({ onNeedSpectrum: updateSpectrum });
  WinInteg.init({
    state: () => app.state, track: () => app.track, pos: () => Viz.getPosition(),
    dur: () => Viz.progressState.dur || (app.track && app.track.duration) || 0,
    liked: (t) => Likes.has(t), toggleLike: () => toggleLike(), playPause: () => $('btnPlay').click(), openMini: () => Mini.open(),
  });
  Likes.events.addEventListener('change', () => WinInteg.poke());
  // first screens of the grid into the thumbnail cache while the window is idle
  setTimeout(() => idleP(5000).then(() => Lib.prewarm()), 12000);
  $('coverBadge').textContent = CF.getReview().length || '';
  body.classList.remove('booting');
  // Covers installed by an earlier version? Check once per start that none of them
  // landed in a folder shared by several albums (see coverfetch.js → diagnosis).
  if (CF.getStats().ok > 0) setTimeout(async () => {
    const d = await CF.diagnoseSharedCovers();
    if (d.files.length) {
      $('coverBadge').textContent = '!';
      toast($t('В папках с несколькими альбомами лежат ошибочно записанные обложки ({0}) — из-за них у альбомов одинаковые обложки.', d.files.length), { ms: Infinity, action: { label: $t('Исправить'), fn: () => router.go('covers') } });
    }
  }, 6000);
  // background sweep after the UI has settled (and never during the first seconds of playback start)
  if (settings.coverSweep) {
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1));
    setTimeout(() => idle(() => CF.sweepLibrary(), { timeout: 10000 }), 25000);
  }
  if (settings.funMode) funCore().then((m) => m.enable({ quiet: true }));
  log('ready', hasBridge());
})();
