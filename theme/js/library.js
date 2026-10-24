/*
 * Gatefold · library.js — playlist (virtualised, grouped by album), library grid
 * (virtualised, lazy covers), album page (scoped palette), search, queue.
 *
 * Virtualisation keeps the DOM at ~40–80 nodes regardless of list size, so a
 * 50 000-track playlist scrolls exactly like a 50-track one.
 */
import { call, on, ok, normTrack, esc, fmtTime, fmtDuration, plural, debounce, settle, log, sleep, artUrl, albumKeyOf } from './bridge.js';
import { settings, setSetting } from './settings.js';
import { router, onRoute, $, h, icon, toast, placeholder, popupMenu, backButton } from './ui.js';
import { idle, slot, spent } from './sched.js';
import { paletteForAlbum, setEditionKeyResolver } from './theme.js';
import * as AC from './albumcolors.js';
import * as CF from './coverfetch.js';
import * as TC from './thumbcache.js';
import * as SORT from './sorting.js';
import * as IDB from './idb.js';
import * as Likes from './likes.js';
import { bgCall } from './sched.js';

import { $t } from './i18n.js';
import { emptyActions } from './welcome.js';
import * as SmartPL from './smartpl.js';
import * as Colors from './colors.js';
import * as SoundUI from './ml/sound-ui.js';
import * as Sound from './ml/sound.js';
import * as Loud from './loudness.js';
import * as AD from './album-details.js';
import * as Cx from './columns.js';
import * as Own from './ownart.js';
import * as CoverPick from './coverpick.js';
import * as Names from './artistnames.js';
import * as Folders from './folders.js';
import * as TS from './trackstore.js';
import * as Tracks from './tracks.js';
const ownRg = () => performance.now() < Loud.writingUntil;   // Gatefold's own ReplayGain tag writes change nothing shown
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
/** A track as the host's context-menu/handle APIs want it: path, or path|subsong:N. */
const trackHandle = (t) => t.handle || ((t.subsong ? `${t.absolutePath || t.path}|subsong:${t.subsong}` : (t.absolutePath || t.path)));
/* ---- hearts on track rows */
/* a text that leads somewhere: the song (its album page, the song marked), the artist, the album */
const lnk = (go, text) => (!text ? '' : go === 'artist' ? artistLinks(text) : `<span class="lnk" data-go="${go}">${esc(text)}</span>`);
/** «A; B»: each artist its own link (the separators in Settings → Library) */
export const artistLinks = (text, title = '') => Names.segments(text).map((g) => (g.name ? `<span class="lnk" data-go="artist"${title ? ` title="${esc(title)}"` : ''}>${esc(g.text)}</span>` : esc(g.text))).join('');
const LIKE_BTN = `<button class="row-like" tabindex="-1" aria-label="${$t('Нравится')}" title="${$t('В понравившиеся')}"><svg><use href="#i-heart"/></svg></button>`;
const likeAttr = (t) => { const k = String(trackHandle(t) || '').toLowerCase(); return ` data-h="${esc(k)}"${Likes.has({ handle: k }) ? ' data-liked="1"' : ''}`; };
function likeRow(el) {
  const on = !!el.dataset.h && Likes.has({ handle: el.dataset.h });
  el.classList.toggle('liked', on);
  el.querySelector('.row-like use')?.setAttribute('href', on ? '#i-heart-f' : '#i-heart');
  const b = el.querySelector('.row-like'); if (b) b.title = on ? $t('Убрать из понравившихся') : $t('В понравившиеся');
}
Likes.events.addEventListener('change', () => { document.querySelectorAll('.vrow[data-h], .vtile[data-h]').forEach(likeRow); renderPlaylists(); });
/** click on a row heart: true when handled */
function heartClick(e, trackOf) {
  const b = e.target.closest('.row-like'); if (!b) return false;
  e.stopPropagation(); e.preventDefault();
  const row = b.closest('.vrow, .vtile'), t = trackOf(row);
  if (t) { b.classList.remove('pop'); void b.offsetWidth; if (!Likes.has(t)) b.classList.add('pop'); Likes.toggle(t); }
  return true;
}
export const shared = { playing: { playlist: -1, index: -1 }, isPlaying: false, onPlayAlbum: null, nowHandle: '' };
/** what a list of tracks elsewhere (folders.js) needs to look and behave like the playlist */
export const rowKit = { LIKE_BTN, likeAttr, likeRow, heartClick };

// ============================================================ cover URLs: disk thumbnail cache → fb2k:// URLs
const coverCache = new Map(); // `${path}@${size}` → fb2k url | ''
const pendingCapture = new Map(); // fb2k url → [[path, size], …]  (stored into the disk cache once it has loaded)
function takeCapture(url) { const l = pendingCapture.get(url); if (!l) return; pendingCapture.delete(url); for (const [p, S] of l) TC.capture(p, S, url); }
export async function coversFor(paths, size) {
  const own = await Own.prepare(paths);                // covers you chose, kept by Gatefold (ownart.js), come first
  const get = await fb2kCoversFor(paths, size);
  return (p) => own(p) || get(p);
}
async function fb2kCoversFor(paths, size) {
  const S = TC.enabled() ? TC.snap(size) : size;
  const hits = await TC.lookup(paths.filter(Boolean), S);
  const need = [...new Set(paths.filter((p) => p && !hits.has(p) && !coverCache.has(`${p}@${S}`)))];
  for (let i = 0; i < need.length; i += 80) {
    const chunk = need.slice(i, i + 80);
    const r = await call('artwork.getFb2kUrlByPathBatch', { paths: chunk, maxSize: S });
    const arr = ok(r) && (r.artworks || r.items || r.results);
    chunk.forEach((p, k) => {
      let it = Array.isArray(arr) ? arr[k] : arr && arr[p];
      const url = artUrl(it && (typeof it === 'string' ? it : it.available !== false ? (it.dataUrl || it.url || '') : ''));
      coverCache.set(`${p}@${S}`, url || '');
    });
  }
  return (p) => {
    const hit = hits.get(p); if (hit) return hit;
    const u = coverCache.get(`${p}@${S}`) || '';
    if (u && TC.enabled()) {
      const l = pendingCapture.get(u) || []; if (!l.some((x) => x[0] === p && x[1] === S)) l.push([p, S]); pendingCapture.set(u, l);
      if (pendingCapture.size > 3000) pendingCapture.delete(pendingCapture.keys().next().value);
    }
    return u;
  };
}
/** Images set outside setImg() report a successful load here so they get cached too. */
export function coverLoaded(url) { takeCapture(url); }
/** A cached thumbnail turned out stale/missing on revalidation → swap it wherever it is shown. */
TC.events.addEventListener('updated', (e) => {
  const { path, size, oldUrl, url } = e.detail;
  coverCache.delete(`${path}@${size}`);
  if (!oldUrl) return;
  document.querySelectorAll('img').forEach((im) => {
    if (im.getAttribute('src') !== oldUrl) return;
    if (url) im.src = url;
    else {
      im.removeAttribute('src'); im.style.display = 'none';
      for (const [k, el] of LIB.nodes) if (el.contains(im)) { el.remove(); LIB.nodes.delete(k); scheduleLib(true); }
    }
  });
});
/** Covers changed on disk (repair) → drop every cached URL and redraw what is on screen. */
CF.events.addEventListener('repaired', () => {
  coverCache.clear(); missingSeen.clear(); TC.clear();
  LIB.nodes.forEach((el) => el.remove()); LIB.nodes.clear();
  if (router.current === 'library') layoutLib();
  if (router.current === 'playlist') { PL.nodes.forEach((el) => el.remove()); PL.nodes.clear(); schedulePl(); }
});
/* a cover you chose (ownart.js) changed: tiles and rows show it at once */
Own.events.addEventListener('change', () => {
  LIB.nodes.forEach((el) => el.remove()); LIB.nodes.clear();
  if (router.current === 'library') layoutLib();
  if (PL.kind) { PL.nodes.forEach((el) => el.remove()); PL.nodes.clear(); schedulePl(); }
  if (router.current === 'album' && ALB.a && ALB.a.firstTrackAbsolutePath) {
    coversFor([ALB.a.firstTrackAbsolutePath], Math.round(220 * dpr())).then((get) => { const u = get(ALB.a.firstTrackAbsolutePath); const im = albumView.querySelector('.album-cover img'); if (u && im) setImg(im, u); });
  }
});
export function forgetCover(path) { for (const k of coverCache.keys()) if (k.startsWith(path + '@')) coverCache.delete(k); TC.forget(path); }

export function setImg(img, url, onFail) {
  if (!url) { img.style.display = 'none'; if (onFail) onFail(); return; }
  img.style.display = '';
  if (img.getAttribute('src') === url) return;
  img.classList.remove('on');
  img.onload = () => {
    if (img.naturalWidth > 1) { img.classList.add('on'); takeCapture(url); }
    else { img.style.display = 'none'; if (onFail) onFail(); }
  };
  img.onerror = () => { img.style.display = 'none'; if (onFail) onFail(); };
  img.src = url;
}
/** A tile that visibly has no cover is the most reliable "missing art" signal there is. */
const missingSeen = new Set();
function coverMissing(a) {
  if (!a || missingSeen.has(a.firstTrackAbsolutePath)) return;
  missingSeen.add(a.firstTrackAbsolutePath);
  const job = CF.jobFromAlbum(a);
  if (CF.reportMissing(job)) markFetching(a, job.key);
}
function markFetching(a, key) {
  const el = LIB.nodes.get(tileKey(a));
  const cov = el && el.querySelector('.cov');
  if (cov && !cov.querySelector('.fetching')) { const sp = h(`<span class="fetching" title="${$t('Ищу обложку')}"><span class="spinner"></span></span>`); sp.dataset.key = key; cov.appendChild(sp); }
}
CF.events.addEventListener('change', debounce(() => {
  const active = new Set([CF.state.busy && CF.state.busy.key, ...CF.state.queue.map((j) => j.key)]);
  document.querySelectorAll('.cov .fetching').forEach((sp) => { if (!active.has(sp.dataset.key)) sp.remove(); });
}, 400));

// ============================================================ playlist view
const PL = { guid: '', index: -1, name: '', total: 0, pages: new Map(), loading: new Set(), runs: [], allRuns: [], kind: null, ref: null, top: null, n: 0, height: 0, nodes: new Map(), sel: -1, selSet: new Set(), anchor: -1, locked: false, token: 0, mode: 'albums', rowH: 36, cols: 1, tw: 160, th: 220, cx: [], cxv: new Map() };
let ROW = 36, HEAD = 72, ROWC = 56;
const PAGE = 150, TGAP = 18, TMIN = 158;
/* row heights follow the text size (13…20 px), the same formula as the CSS variables set in app.js */
export const rowMetrics = (b = settings.baseSize || 14) => ({ row: Math.max(36, Math.round(b * 2.5)), rowc: Math.max(56, Math.round(b * 3.75)), head: Math.max(72, Math.round(b * 5.1)) });
/** height of the title + subtitle under an album tile (two text lines that grow with the text size) */
export const tileMeta = (b = settings.baseSize || 14) => Math.max(62, Math.round(28 + b * 2.7));
function syncMetrics() { const m = rowMetrics(); ROW = m.row; ROWC = m.rowc; HEAD = m.head; }
syncMetrics();
/** text size changed: lists re-lay out at the new row height */
export function relayoutForFont() {
  syncMetrics();
  if (PL.kind) { const keep = plScroller.scrollTop / Math.max(1, PL.height); buildLayout(); renderPlaylist(); plScroller.scrollTop = keep * PL.height; }
  if (LIB.loaded) { for (const el of LIB.nodes.values()) el.remove(); LIB.nodes.clear(); layoutLib(); }
}
/* Ways to show a playlist. Remembered per playlist; the default is «by album» where the
   playlist really consists of album runs, otherwise «with covers» (likes, mixes, radio dumps). */
export const PL_MODES = [
  { id: 'albums', label: $t('По альбомам'), hint: $t('Заголовок с обложкой у каждого альбома'), icon: 'v-albums' },
  { id: 'covers', label: $t('С обложками'), hint: $t('Обложка у каждого трека'), icon: 'v-covers' },
  { id: 'grid', label: $t('Плитки'), hint: $t('Крупные обложки сеткой'), icon: 'v-grid' },
  { id: 'compact', label: $t('Компактно'), hint: $t('Плотный список без обложек'), icon: 'v-list' },
];
const plModes = (() => { try { return JSON.parse(localStorage.getItem('aurora.plview') || '{}') || {}; } catch { return {}; } })();
const saveModes = () => { try { localStorage.setItem('aurora.plview', JSON.stringify(plModes)); } catch {} };
/** forget every playlist's own view (settings → «Плейлисты») */
export function resetPlaylistViews() { for (const k of Object.keys(plModes)) delete plModes[k]; saveModes(); if (PL.guid && router.current === 'playlist') openPlaylist(PL.guid); }
const plScroller = $('plScroller'), plList = $('plList');
const FIELDS = ['title', 'artist', 'album', 'albumArtist', 'duration', 'trackNumber', 'discNumber', 'date', 'codec', 'absolutePath', 'subsong', 'handle'];

/** Visit the library tiles currently in the DOM (for optional decorations). */
export function eachTile(fn) {
  const m = new Map(LIB.view.map((a) => [tileKey(a), a]));
  for (const [k, el] of LIB.nodes) { const a = m.get(k); if (a) fn(el, a); }
}

/* Prepare the first screens of the grid while nobody is using the window, so that
   opening "Library" after a restart shows finished tiles from the disk cache. */
export async function prewarm(maxTiles = 64) {
  if (!TC.enabled()) return 0;
  const albums = await getAllAlbums();
  if (!albums.length) return 0;
  if (!LIB.sorted) await sortLib();
  const W = Math.max(600, (libScroller.clientWidth || innerWidth - 300) - PAD * 2);
  const min = 168 + (settings.baseSize - 14) * 8;
  const cols = Math.max(2, Math.floor((W + GAP) / (min + GAP)));
  const tileW = (W - GAP * (cols - 1)) / cols;
  const size = Math.min(600, Math.round(tileW * dpr() / 50) * 50);   // exactly what renderLib asks for
  const list = (LIB.sorted || albums).slice(0, maxTiles).map((a) => a.firstTrackAbsolutePath).filter(Boolean);
  const get = await coversFor(list, size);
  let n = 0;
  for (const p of list) {
    const u = get(p);
    if (!u || /^blob:/.test(u)) continue;                              // missing, or already on disk
    await slot('low');
    const ok1 = await new Promise((res) => { const im = new Image(); im.decoding = 'async'; im.onload = () => res(im.naturalWidth > 1); im.onerror = () => res(false); im.src = u; });
    spent(2);
    if (ok1) { takeCapture(u); n++; }
  }
  return n;
}

export async function openPlaylist(guid) {
  const all = await call('playlist.getAll');
  const list = (ok(all) && all.playlists) || [];
  let pl = guid ? list.find((p) => p.guid === guid) : list.find((p) => p.isActive);
  if (!pl) pl = list[0];
  if (!pl) { plList.innerHTML = `<div class="empty"><b>${$t('Нет плейлистов')}</b></div>`; return; }
  const token = ++PL.token;
  // the same playlist again (an edit, a reorder): keep the scroll position and the selection
  const same = pl.guid === PL.guid, keepTop = plScroller.scrollTop;
  const keepSel = same ? new Set([...PL.selSet].filter((t) => t < pl.trackCount)) : new Set();
  Object.assign(PL, { guid: pl.guid, index: pl.index, name: pl.name, total: pl.trackCount, pages: new Map(), loading: new Set(), nodes: new Map(),
    sel: same && PL.sel < pl.trackCount ? PL.sel : -1, selSet: keepSel, anchor: same ? PL.anchor : -1, locked: !!(pl.isAutoplaylist || pl.isLocked), cxv: new Map() });
  plList.innerHTML = '';
  updateSelBar();
  $('plTitle').textContent = pl.name;
  const act = await call('playlist.getActive');
  $('plSub').textContent = `${pl.trackCount} ${plural(pl.trackCount, 'трек', 'трека', 'треков')}${ok(act) && act.guid === pl.guid && act.duration ? ' · ' + fmtDuration(act.duration) : ''}`;
  // album group runs → layout
  let runs = [];
  if (pl.trackCount) {
    const g = await call('playlist.getGroupRuns', { playlistGuid: pl.guid, patterns: ['$if2(%album artist%,%artist%) | %album%'] });
    if (ok(g) && g.runs) runs = g.runs;
  }
  if (token !== PL.token) return;
  PL.allRuns = runs;
  const albumish = runs.length > 0 && runs.length < pl.trackCount * 0.6;
  const isLiked = pl.guid === Likes.guid();
  const def = settings.plViewDefault && settings.plViewDefault !== 'auto' ? settings.plViewDefault : (albumish && !isLiked ? 'albums' : 'covers');
  PL.mode = plModes[pl.guid] || def;
  renderPlHead(pl, isLiked);
  buildLayout();
  plScroller.scrollTop = same ? keepTop : 0;
  renderPlaylist();
  if (!pl.trackCount) {
    plList.style.height = '';
    plList.innerHTML = isLiked
      ? `<div class="empty"><b>${$t('Пока нет лайков')}</b></div>`
      : `<div class="empty"><b>${$t('Плейлист пуст')}</b>${emptyActions({ library: false, guid: pl.guid })}</div>`;
  }
}

/* ---- header: cover collage, play / shuffle, view switch */
function renderPlHead(pl, isLiked) {
  const box = $('plCover');
  box.className = 'pl-cover' + (isLiked ? ' liked' : '');
  box.innerHTML = isLiked ? `<svg><use href="#i-heart-f"/></svg>` : `<svg><use href="#i-list"/></svg>`;
  $('plKicker').textContent = isLiked ? $t('Ваши лайки') : $t('Плейлист');
  const seg = $('plModes');
  seg.innerHTML = PL_MODES.map((m) => `<button data-m="${m.id}" title="${esc(m.label)} — ${esc(m.hint)}" aria-label="${esc(m.label)}" class="${m.id === PL.mode ? 'on' : ''}"><svg><use href="#i-${m.icon}"/></svg></button>`).join('');
  $('plPlay').disabled = $('plShuffle').disabled = !pl.trackCount;
  if (!isLiked && pl.trackCount) collage(pl.guid);
}
async function collage(guid) {
  // up to four different album covers from the start of the playlist
  const r = await call('playlist.getTracks', { playlistGuid: guid, start: 0, count: 120, fields: ['absolutePath', 'album'] });
  if (!ok(r) || PL.guid !== guid) return;
  const seen = new Set(), paths = [];
  for (const t of r.tracks || []) { const k = (t.album || '') + '|' + String(t.absolutePath || '').replace(/[\\/][^\\/]*$/, ''); if (!seen.has(k)) { seen.add(k); paths.push(t.absolutePath); } if (paths.length >= 4) break; }
  if (!paths.length) return;
  const get = await coversFor(paths, Math.round(96 * dpr()));
  const urls = paths.map(get).filter(Boolean);
  if (PL.guid !== guid || !urls.length) return;
  const box = $('plCover');
  const use = urls.length >= 4 ? urls.slice(0, 4) : urls.slice(0, 1);
  box.className = 'pl-cover' + (use.length === 4 ? ' quad' : ' one');
  box.innerHTML = use.map((u) => `<img alt="" src="${esc(u)}">`).join('');
}
$('plModes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-m]'); if (!b || b.dataset.m === PL.mode) return;
  PL.mode = b.dataset.m; plModes[PL.guid] = PL.mode; saveModes();
  $('plModes').querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b));
  const anchor = PL.sel >= 0 ? PL.sel : -1;
  buildLayout(); plScroller.scrollTop = 0; renderPlaylist();
  if (anchor >= 0) scrollToTrack(anchor, false);
});
$('plPlay').addEventListener('click', () => call('playlist.playTrack', { playlistGuid: PL.guid, index: 0 }));
$('plShuffle').addEventListener('click', () => shufflePlay(PL.guid, PL.total));
/** Shuffle without touching the playlist's own order: switch the playback order, start anywhere. */
export async function shufflePlay(guid, total) {
  if (!total) return;
  await call('playback.setPlaybackOrder', { name: 'shuffle-tracks' });
  await call('playlist.playTrack', { playlistGuid: guid, index: Math.floor(Math.random() * total) });
  libEvents.dispatchEvent(new Event('order'));
}

function buildLayout() {
  const total = PL.total, mode = PL.mode;
  const cx = mode === 'grid' ? [] : Cx.forView('pl');
  if (JSON.stringify(cx) !== JSON.stringify(PL.cx)) { PL.cx = cx; PL.cxv = new Map(); for (const p of PL.pages.keys()) loadCx(p, PL.token); }
  paintPlHead();
  for (const el of PL.nodes.values()) el.remove();
  PL.nodes.clear();
  plList.dataset.mode = mode;
  $('view-playlist').dataset.mode = mode;
  if (mode === 'grid') {
    const w = Math.max(320, plScroller.clientWidth - 32);
    const cols = Math.max(2, Math.floor((w + TGAP) / (TMIN + TGAP)));
    const tw = Math.floor((w - TGAP * (cols - 1)) / cols);
    const meta = Math.round(30 + (settings.baseSize || 14) * 2.3);
    Object.assign(PL, { cols, tw, th: tw + meta, rowH: tw + meta + TGAP, runs: [] });
    const rows = Math.ceil(total / cols);
    PL.kind = new Uint8Array(rows); PL.ref = new Int32Array(rows); PL.top = new Float64Array(rows + 1);
    for (let r = 0; r < rows; r++) { PL.kind[r] = 2; PL.ref[r] = r; PL.top[r] = 8 + r * PL.rowH; }
    PL.n = rows; PL.top[rows] = 8 + rows * PL.rowH; PL.height = PL.top[rows] + 24;
    plList.style.height = PL.height + 'px';
    return;
  }
  const runs = mode === 'albums' ? PL.allRuns : [];
  const rowH = mode === 'covers' ? ROWC : ROW;
  PL.runs = runs; PL.rowH = rowH; PL.cols = 1;
  const n = total + runs.length;
  PL.kind = new Uint8Array(n); PL.ref = new Int32Array(n); PL.top = new Float64Array(n + 1);
  let i = 0, y = mode === 'covers' ? 4 : 0, r = 0;
  for (let t = 0; t < total; t++) {
    if (r < runs.length && runs[r].start === t) { PL.kind[i] = 1; PL.ref[i] = r; PL.top[i] = y; y += HEAD; i++; r++; }
    PL.kind[i] = 0; PL.ref[i] = t; PL.top[i] = y; y += rowH; i++;
  }
  PL.n = i; PL.top[i] = y; PL.height = y + 24;
  plList.style.height = PL.height + 'px';
}
/** layout index of the element that shows track t */
function slotOf(t) {
  if (PL.mode === 'grid') return Math.floor(t / PL.cols);
  for (let i = 0; i < PL.n; i++) if (!PL.kind[i] && PL.ref[i] === t) return i;
  return -1;
}
function scrollToTrack(t, smooth, onlyIfHidden) {
  const i = slotOf(t); if (i < 0) return;
  const y = PL.top[i];
  if (onlyIfHidden && y >= plScroller.scrollTop && y <= plScroller.scrollTop + plScroller.clientHeight - PL.rowH) return;
  plScroller.scrollTo({ top: Math.max(0, y - plScroller.clientHeight / 3), behavior: smooth ? 'smooth' : 'auto' });
}

function firstVisible(y) {
  let lo = 0, hi = PL.n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (PL.top[m] <= y) lo = m; else hi = m - 1; }
  return lo;
}

const pageWait = new Map();
function loadPage(p) {
  if (PL.pages.has(p)) return Promise.resolve();
  if (pageWait.has(p) && PL.loading.has(p)) return pageWait.get(p);
  PL.loading.add(p);
  const token = PL.token;
  const pr = call('playlist.getTracks', { playlistGuid: PL.guid, start: p * PAGE, count: PAGE, fields: FIELDS }).then((r) => {
    PL.loading.delete(p); pageWait.delete(p);
    if (token !== PL.token || !ok(r)) return;
    PL.pages.set(p, r.tracks || []);
    schedulePl();
    loadCx(p, token);
  });
  pageWait.set(p, pr);
  return pr;
}
const trackAt = (t) => { const pg = PL.pages.get(Math.floor(t / PAGE)); return pg ? pg[t % PAGE] : null; };
/* your own columns (columns.js): their values come a page at a time, after the page's tracks */
function loadCx(p, token) {
  const cols = PL.cx, pg = PL.pages.get(p);
  if (!cols.length || !pg || PL.cxv.has(p)) return;
  PL.cxv.set(p, null);
  Cx.values(pg.map((t) => trackHandle(t)), cols).then((v) => { if (token !== PL.token || cols !== PL.cx) return; PL.cxv.set(p, v); schedulePl(); });
}
document.querySelector('#view-playlist .pl-lh').addEventListener('click', (e) => { const b = e.target.closest('.lh-cfg'); if (b) { const r = b.getBoundingClientRect(); Cx.headerMenu('pl', r.right - 220, r.bottom + 4); } });
document.querySelector('#view-playlist .pl-lh').addEventListener('contextmenu', (e) => { e.preventDefault(); Cx.headerMenu('pl', e.clientX, e.clientY); });
Cx.events.addEventListener('change', () => {
  if (PL.kind) { const keep = plScroller.scrollTop; buildLayout(); for (const el of PL.nodes.values()) el.remove(); PL.nodes.clear(); plScroller.scrollTop = keep; renderPlaylist(); }
  if (ALB.tracks) { ALB.cx = null; renderAlbumRows(); }
});
const cxAt = (t) => { const v = PL.cxv.get(Math.floor(t / PAGE)); return v ? v[t % PAGE] : null; };
/* the list header and the grid of the rows: the base columns, your own, a gap for the heart, the time */
function paintPlHead() {
  const head = document.querySelector('#view-playlist .pl-lh');
  const cv = PL.mode === 'covers', cols = PL.cx;
  const base = cv ? `<div>#</div><div>${$t('Название')}</div><div class="h-album">${$t('Альбом')}</div>`
    : `<div>#</div><div>${$t('Название')}</div><div class="h-artist">${$t('Исполнитель')}</div><div class="h-album">${$t('Альбом')}</div>`;
  head.innerHTML = base + (cols.length ? Cx.headHtml(cols) + '<div class="h-gap"></div>' : '') + `<div>${$t('Время')}</div><button class="lh-cfg icon-btn" title="${$t('Колонки')}" aria-label="${$t('Колонки')}">${icon('more')}</button>`;
  const grid = cols.length ? (cv ? `44px minmax(0, 2fr) minmax(0, 1fr) ${Cx.gridOf(cols)} 30px 64px` : `44px minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) ${Cx.gridOf(cols)} 30px 64px`) : '';
  for (const el of [head, plList]) { el.classList.toggle('cols', !!grid); if (grid) el.style.setProperty('--cols', grid); else el.style.removeProperty('--cols'); }
}

let plRaf = 0;
function schedulePl() { if (!plRaf) plRaf = requestAnimationFrame(() => { plRaf = 0; renderPlaylist(); }); }
plScroller.addEventListener('scroll', schedulePl, { passive: true });
new ResizeObserver(() => {
  // the grid re-flows when the number of columns changes; lists only need a repaint
  if (PL.mode === 'grid' && PL.kind) {
    const w = Math.max(320, plScroller.clientWidth - 32);
    const cols = Math.max(2, Math.floor((w + TGAP) / (TMIN + TGAP)));
    const tw = Math.floor((w - TGAP * (cols - 1)) / cols);
    if (cols !== PL.cols || Math.abs(tw - PL.tw) > 2) { const top = slotOf(Math.max(0, PL.sel)); buildLayout(); if (PL.sel >= 0 && top >= 0) scrollToTrack(PL.sel, false); }
  }
  schedulePl();
}).observe(plScroller);

function renderPlaylist() {
  if (!PL.kind || router.current !== 'playlist') return;
  const y0 = plScroller.scrollTop - 300, y1 = plScroller.scrollTop + plScroller.clientHeight + 300;
  const keep = new Set();
  const headerPaths = [], coverJobs = [];
  for (let i = firstVisible(Math.max(0, y0)); i < PL.n && PL.top[i] < y1; i++) {
    const key = (PL.kind[i] ? 'h' : 't') + PL.ref[i];
    keep.add(key);
    let el = PL.nodes.get(key);
    if (PL.kind[i] === 1) {
      const run = PL.runs[PL.ref[i]];
      const first = trackAt(run.start);
      if (!first) loadPage(Math.floor(run.start / PAGE));
      if (!el) {
        el = h(`<div class="vhead"><img alt="" style="display:none"><div style="min-width:0"><div class="h-album"></div><div class="h-meta"></div></div><button class="btn sm">${icon('play')}${$t('Альбом')}</button></div>`);
        el.querySelector('button').addEventListener('click', () => call('playlist.playTrack', { playlistGuid: PL.guid, index: run.start }));
        plList.appendChild(el); PL.nodes.set(key, el);
      }
      el.style.transform = `translateY(${PL.top[i]}px)`;
      if (first && !el.dataset.ok) {
        el.dataset.ok = '1';
        const [art, alb] = String(run.key).split(' | ');
        el.querySelector('.h-album').innerHTML = alb || first.album ? lnk('album', alb || first.album) : esc($t('Без альбома'));
        el.querySelector('.h-meta').innerHTML = [lnk('artist', art || first.albumArtist || first.artist || ''), (String(first.date || '').match(/\d{4}/) || [''])[0], `${run.count} ${plural(run.count, 'трек', 'трека', 'треков')}`].filter(Boolean).join(' · ');
        el.dataset.t = run.start;
        el.dataset.path = first.absolutePath;
      }
      if (el.dataset.path && !el.dataset.cov) headerPaths.push([el, el.dataset.path]);
    } else if (PL.kind[i] === 2) {
      // a row of track tiles
      const r = PL.ref[i];
      if (!el) { el = h('<div class="vtrow"></div>'); plList.appendChild(el); PL.nodes.set(key, el); }
      el.style.cssText = `transform:translateY(${PL.top[i]}px);grid-template-columns:repeat(${PL.cols},${PL.tw}px);column-gap:${TGAP}px`;
      for (let c = 0; c < PL.cols; c++) {
        const t = r * PL.cols + c; if (t >= PL.total) break;
        let tile = el.children[c];
        const tr = trackAt(t);
        if (!tr) loadPage(Math.floor(t / PAGE));
        if (!tile) {
          tile = h(`<div class="vtile" data-t="${t}"><div class="cov"><div class="ph"></div><img alt=""><button class="play" title="${$t('Слушать')}">${icon('play', 18)}</button>${LIKE_BTN}<span class="eqv"><span class="eq"><i></i><i></i><i></i></span></span></div><div class="tt"></div><div class="ta"></div></div>`);
          el.appendChild(tile);
        }
        if (tr && tile.dataset.filled !== '1') {
          tile.dataset.filled = '1';
          const ph = placeholder(tr.album || tr.title, tr.albumArtist || tr.artist);
          const p0 = tile.querySelector('.ph'); if (p0) { p0.style.background = ph.bg; p0.textContent = ph.ini; }
          tile.querySelector('.tt').innerHTML = lnk('track', tr.title || (tr.absolutePath || '').split('\\').pop());
          tile.querySelector('.ta').innerHTML = lnk('artist', tr.artist || '');
          tile.title = [tr.title, tr.artist, tr.album].filter(Boolean).join(' — ');
          tile.dataset.h = String(trackHandle(tr) || '').toLowerCase(); likeRow(tile);
          if (tr.absolutePath) coverJobs.push([tile, tr.absolutePath, Math.min(600, Math.round(PL.tw * dpr() / 50) * 50)]);
        } else if (!tr && !tile.dataset.filled) tile.querySelector('.tt').innerHTML = '<div class="skeleton" style="width:70%"></div>';
        const playing = PL.index === shared.playing.playlist && t === shared.playing.index;
        tile.classList.toggle('playing', playing);
        tile.classList.toggle('sel', PL.selSet.has(t));
        tile.classList.toggle('focus', t === PL.sel && PL.selSet.size > 1);
      }
    } else {
      const t = PL.ref[i];
      const tr = trackAt(t);
      const cv = PL.mode === 'covers';
      if (!tr) loadPage(Math.floor(t / PAGE));
      if (!el) {
        const cx = PL.cx.length ? Cx.emptyCells(PL.cx) + '<div class="c-gap"></div>' : '';
        el = cv
          ? h('<div class="vrow wc"><div class="c-n num"></div><div class="c-title"><div class="c-cov"><img alt=""></div><div class="c-tt"><b></b><span></span></div></div><div class="c-album"></div>' + cx + '<div class="c-dur num"></div>' + LIKE_BTN + '</div>')
          : h('<div class="vrow"><div class="c-n num"></div><div class="c-title"></div><div class="c-artist"></div><div class="c-album"></div>' + cx + '<div class="c-dur num"></div>' + LIKE_BTN + '</div>');
        el.dataset.t = t;
        plList.appendChild(el); PL.nodes.set(key, el);
      }
      el.style.transform = `translateY(${PL.top[i]}px)`;
      if (tr && el.dataset.filled !== '1') {
        el.dataset.filled = '1';
        const c = el.children;
        const title = tr.title || (tr.absolutePath || '').split('\\').pop();
        // title, artist and album are links: the song on its album page, the artist, the album
        if (cv) {
          const ph = placeholder(tr.album || title, tr.albumArtist || tr.artist);
          const box = el.querySelector('.c-cov'); box.style.background = ph.bg; box.dataset.ini = ph.ini;
          el.querySelector('.c-tt b').innerHTML = lnk('track', title);
          el.querySelector('.c-tt > span').innerHTML = lnk('artist', tr.artist || '');
          c[2].innerHTML = lnk('album', tr.album || '');
          if (tr.absolutePath) coverJobs.push([el, tr.absolutePath, Math.round(44 * dpr())]);
        } else {
          c[1].innerHTML = lnk('track', title);
          c[2].innerHTML = lnk('artist', tr.artist || '');
          c[3].innerHTML = lnk('album', tr.album || '');
        }
        el.querySelector('.c-dur').textContent = tr.duration ? fmtTime(tr.duration) : '';
        el.dataset.h = String(trackHandle(tr) || '').toLowerCase(); likeRow(el);
      } else if (!tr) { (cv ? el.querySelector('.c-tt b') : el.children[1]).innerHTML = '<div class="skeleton" style="width:60%"></div>'; }
      if (PL.cx.length && el.dataset.cxok !== '1') { const v = cxAt(t); if (v) { Cx.fill(el, v); el.dataset.cxok = '1'; } }
      const playing = PL.index === shared.playing.playlist && t === shared.playing.index;
      el.classList.toggle('playing', playing);
      el.classList.toggle('sel', PL.selSet.has(t));
      el.classList.toggle('focus', t === PL.sel && PL.selSet.size > 1);
      el.children[0].innerHTML = playing ? '<span class="eq"><i></i><i></i><i></i></span>' : (tr && tr.trackNumber && PL.mode === 'albums' ? tr.trackNumber : t + 1);
    }
  }
  for (const [k, el] of PL.nodes) if (!keep.has(k)) { el.remove(); PL.nodes.delete(k); }
  if (coverJobs.length) {
    const bySize = new Map();
    for (const j of coverJobs) { if (!bySize.has(j[2])) bySize.set(j[2], []); bySize.get(j[2]).push(j); }
    for (const [size, jobs] of bySize) coversFor(jobs.map((x) => x[1]), size).then((get) => {
      for (const [el, p] of jobs) {
        const img = el.querySelector('img'); const u = get(p);
        img.addEventListener('load', () => { if (img.naturalWidth > 1) el.querySelector('.cov > .ph')?.remove(); }, { once: true });
        setImg(img, u);
      }
    });
  }
  if (headerPaths.length) {
    const size = Math.round(52 * dpr());
    coversFor(headerPaths.map((x) => x[1]), size).then((get) => {
      for (const [el, p] of headerPaths) { el.dataset.cov = '1'; const img = el.querySelector('img'); const u = get(p); if (u) setImg(img, u); }
    });
  }
}

/* ---- editing: selection (click / Ctrl / Shift), Delete, drag to reorder or onto a sidebar playlist,
   undo / redo, a context menu of our own with foobar2000's actions one level down. foobar2000 keeps an
   undo point for every remove, insert and reorder, so Ctrl+Z is foobar2000's own undo. */
const selList = () => [...PL.selSet].sort((a, b) => a - b);
function selectOnly(t) { PL.selSet = new Set([t]); PL.sel = t; PL.anchor = t; }
function selRange(a, b, add) {
  if (!add) PL.selSet = new Set();
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) PL.selSet.add(i);
}
const pushSel = debounce(() => {
  if (!PL.guid) return;
  call('playlist.setSelection', { playlistGuid: PL.guid, indices: selList() });
  if (PL.sel >= 0) call('playlist.focusTrack', { playlistGuid: PL.guid, index: PL.sel });
}, 120);
function selChanged() { schedulePl(); updateSelBar(); pushSel(); }
export function clearPlaylistSelection() { if (!PL.selSet.size) return false; PL.selSet = new Set(); selChanged(); return true; }

/** every page that holds one of `ts` is loaded */
async function ensureTracks(ts) {
  const pages = [...new Set(ts.map((t) => Math.floor(t / PAGE)))].filter((p) => !PL.pages.has(p));
  for (let i = 0; i < pages.length; i += 6) await Promise.all(pages.slice(i, i + 6).map(loadPage));
}
async function selectedHandles() {
  const ts = selList();
  await ensureTracks(ts);
  return ts.map((t) => trackAt(t)).filter(Boolean).map(trackHandle).filter(Boolean);
}
const lockedMsg = () => toast($t('Этот плейлист нельзя менять вручную — это автоплейлист или он заблокирован компонентом'));
const failed = (r) => (r && /LOCK/i.test(String(r.code || r.error)) ? lockedMsg() : toast($t('foobar2000 не выполнил действие: {0}', esc((r && (r.error || r.code)) || '?'))));

export async function plUndo(redo = false) {
  if (!PL.guid) return;
  const r = await call(redo ? 'playlist.redo' : 'playlist.undo', { playlistGuid: PL.guid });
  if (!ok(r)) failed(r);
}
export async function removeSelected() {
  const items = selList();
  if (!items.length || !PL.guid) return;
  if (PL.locked) return lockedMsg();
  const r = await call('playlist.removeTracks', { playlistGuid: PL.guid, items });
  if (!ok(r)) return failed(r);
  const first = items[0];
  PL.selSet = new Set(); PL.sel = Math.min(first, PL.total - items.length - 1); PL.anchor = PL.sel;
  updateSelBar();
  toast($t('Удалено из плейлиста: {0} {1}', items.length, plural(items.length, 'трек', 'трека', 'треков')), { ms: 6000, action: { label: $t('Отменить'), fn: () => plUndo() } });
}
/** move the selected rows so that they start before row `pos` (of the current order) */
async function moveSelectionTo(pos) {
  const sel = selList(); const n = PL.total;
  if (!sel.length) return;
  if (PL.locked) return lockedMsg();
  const contiguous = sel[sel.length - 1] - sel[0] === sel.length - 1;
  if (contiguous && pos >= sel[0] && pos <= sel[sel.length - 1] + 1) return;     // dropped onto itself
  const S = PL.selSet, before = [], after = [];
  for (let i = 0; i < n; i++) if (!S.has(i)) (i < pos ? before : after).push(i);
  const r = await call('playlist.reorder', { playlistGuid: PL.guid, newOrder: [...before, ...sel, ...after] });
  if (!ok(r)) return failed(r);
  const start = before.length;
  PL.selSet = new Set(sel.map((_, k) => start + k)); PL.sel = start; PL.anchor = start;
  pushSel();
}
async function moveBy(delta) {
  const sel = selList();
  if (!sel.length) return;
  const pos = delta < 0 ? Math.max(0, sel[0] - 1) : Math.min(PL.total, sel[sel.length - 1] + 2);
  await moveSelectionTo(pos);
  scrollToTrack(PL.sel, false, true);
}
async function addSelectionTo(guid, name) {
  const handles = await selectedHandles();
  if (!handles.length) return;
  if (!guid) {
    const c = await call('playlist.create', { name: name || $t('Новый плейлист') });
    if (!ok(c)) return failed(c);
    guid = c.guid; name = name || $t('Новый плейлист');
  }
  const r = await call('playlist.addHandles', { playlistGuid: guid, handles });
  if (!ok(r)) return failed(r);
  toast($t('Добавлено в «{0}»: {1} {2}', esc(name), handles.length, plural(handles.length, 'трек', 'трека', 'треков')));
}
async function queueSelection() {
  const tracks = selList();
  const r = await call('queue.add', { playlistGuid: PL.guid, tracks });
  if (!ok(r)) return failed(r);
  toast($t('В очереди: +{0}', tracks.length));
}

/* the bar that appears while several rows are selected */
let selBar = null;
function updateSelBar() {
  const n = PL.selSet.size;
  if (!selBar) {
    selBar = h(`<div class="pl-selbar" hidden><span class="n"></span><span class="gap"></span>
      <button class="btn sm" data-sb="play">${icon('play')}${$t('Слушать')}</button>
      <button class="btn sm" data-sb="queue">${icon('queue')}${$t('В очередь')}</button>
      <button class="btn sm" data-sb="to">${icon('plus')}${$t('В плейлист')}</button>
      <button class="btn sm danger" data-sb="del">${icon('x')}${$t('Удалить')}</button>
      <button class="icon-btn" data-sb="clear" title="${$t('Снять выделение (Esc)')}">${icon('x', 14)}</button></div>`);
    $('view-playlist').append(selBar);
    selBar.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-sb]'); if (!b) return;
      const a = b.dataset.sb;
      if (a === 'play') call('playlist.playTrack', { playlistGuid: PL.guid, index: selList()[0] });
      if (a === 'queue') queueSelection();
      if (a === 'del') removeSelected();
      if (a === 'clear') clearPlaylistSelection();
      if (a === 'to') { const r = b.getBoundingClientRect(); const id = await popupMenu(await playlistTargets(), r.left, r.top - 8 - 32 * 6); pickTarget(id); }
    });
  }
  selBar.hidden = n < 2;
  if (n >= 2) selBar.querySelector('.n').textContent = $t('Выбрано: {0}', n);
}
export async function playlistTargets() {
  const all = await call('playlist.getAll');
  const list = ((ok(all) && all.playlists) || []).filter((p) => p.guid !== PL.guid && !p.isAutoplaylist);
  return [{ id: 'new', label: $t('Новый плейлист…') }, ...(list.length ? [{ type: 'sep' }] : []), ...list.map((p) => ({ id: 'pl:' + p.guid + '\u0001' + p.name, label: p.name }))];
}
function pickTarget(id) {
  if (!id) return;
  if (id === 'new') return addSelectionTo('', $t('Новый плейлист'));
  const [guid, name] = id.slice(3).split('\u0001');
  addSelectionTo(guid, name);
}

/* links in the list: the artist and the album open at once; the song waits a moment, because the
   first click of a double click (play) lands on the title too */
let goT = 0;
function follow(go, tr, name) {
  if (!tr) return;
  if (go === 'artist') router.go('artist', name || tr.artist || tr.albumArtist);
  else if (go === 'album' && shared.openTrackAlbum) shared.openTrackAlbum(tr);
  else if (go === 'track' && shared.openTrackAlbum) shared.openTrackAlbum(tr, trackHandle(tr));
}
plList.addEventListener('click', (e) => {
  if (dragJustEnded) return;
  clearTimeout(goT);
  const lk = e.target.closest('.lnk');
  if (lk && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.detail < 2) {
    const host = lk.closest('[data-t]'), tr = host && trackAt(+host.dataset.t);
    if (lk.dataset.go === 'track') goT = setTimeout(() => follow('track', tr), 280);
    else { e.stopPropagation(); follow(lk.dataset.go, tr, lk.textContent); return; }
  }
  if (heartClick(e, (r) => trackAt(+r.dataset.t))) return;
  const pb = e.target.closest('.vtile .play'); if (pb) { e.stopPropagation(); call('playlist.playTrack', { playlistGuid: PL.guid, index: +pb.closest('.vtile').dataset.t }); return; }
  const row = e.target.closest('.vrow, .vtile');
  if (!row) { if (e.target === plList) clearPlaylistSelection(); return; }
  const t = +row.dataset.t;
  if (e.shiftKey && PL.anchor >= 0) { selRange(PL.anchor, t, e.ctrlKey || e.metaKey); PL.sel = t; }
  else if (e.ctrlKey || e.metaKey) { if (PL.selSet.has(t)) PL.selSet.delete(t); else PL.selSet.add(t); PL.sel = t; PL.anchor = t; }
  else selectOnly(t);
  selChanged();
});
plList.addEventListener('dblclick', (e) => {
  clearTimeout(goT);
  if (e.target.closest('.row-like, .play') || e.shiftKey || e.ctrlKey) return;
  const row = e.target.closest('.vrow, .vtile'); if (!row) return;
  call('playlist.playTrack', { playlistGuid: PL.guid, index: +row.dataset.t });
});
plList.addEventListener('contextmenu', async (e) => {
  const row = e.target.closest('.vrow, .vtile'); if (!row) return;
  e.preventDefault();
  const t = +row.dataset.t;
  if (!PL.selSet.has(t)) selectOnly(t);
  PL.sel = t; selChanged();
  const n = PL.selSet.size;
  const tr0 = trackAt(t);
  const radio = shared.radioFor && tr0 ? [{ id: 'radio', label: $t('Радио «Похожее на это»') }] : [];
  if (shared.similarFor && tr0 && settings.soundAI) radio.push({ id: 'similar', label: $t('Похожие треки по звучанию') });
  if (shared.radioActive && shared.radioActive() === PL.guid && tr0 && (tr0.artist || tr0.albumArtist)) {
    if (shared.radioWhy && shared.radioWhy(tr0)) radio.push({ id: 'radiowhy', label: $t('Почему этот трек в радио?') });
    radio.push({ id: 'radioban', label: $t('Не то — больше не ставить {0}', tr0.albumArtist || tr0.artist) });
  }
  const id = await popupMenu([
    { id: 'play', label: $t('Воспроизвести') },
    { id: 'queue', label: n > 1 ? $t('Добавить в очередь ({0})', n) : $t('Добавить в очередь') },
    { id: 'to', label: $t('Добавить в плейлист'), children: await playlistTargets() },
    ...radio,
    { type: 'sep' },
    { id: 'del', label: n > 1 ? $t('Удалить из плейлиста ({0})  Del', n) : $t('Удалить из плейлиста  Del'), disabled: PL.locked },
    { type: 'sep' },
    { id: 'native', label: $t('Действия foobar2000…') },
  ], e.clientX, e.clientY);
  if (!id) return;
  if (id === 'play') call('playlist.playTrack', { playlistGuid: PL.guid, index: t });
  else if (id === 'queue') queueSelection();
  else if (id === 'del') removeSelected();
  else if (id === 'radio') shared.radioFor(trackAt(t));
  else if (id === 'radioban') shared.radioBan(tr0.albumArtist || tr0.artist);
  else if (id === 'radiowhy') toast(`<b>${esc(tr0.title || '')}</b> — ${esc(shared.radioWhy(tr0))}`, { ms: 7000 });
  else if (id === 'similar') shared.similarFor(trackAt(t));
  else if (id === 'new' || id.startsWith('pl:')) pickTarget(id);
  else if (id === 'native') {
    // foobar2000's own menu (Convert, ReplayGain, Properties, tagging…) for exactly these rows
    await call('playlist.setActive', { playlistGuid: PL.guid });
    await call('playlist.setSelection', { playlistGuid: PL.guid, indices: selList() });
    const r = await call('menu.showNativePopup', { mode: 'selection' });
    if (!ok(r)) { const hs = await selectedHandles(); if (hs.length) call('menu.showNativePopup', { mode: 'handles', handles: hs }); }
  }
});

/* drag: pointer based (HTML drag-and-drop belongs to files from Explorer, see dropzone.js) */
let drag = null, dragJustEnded = false;
plList.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.target.closest('button, .row-like, input')) return;
  const row = e.target.closest('.vrow, .vtile'); if (!row) return;
  drag = { t: +row.dataset.t, x: e.clientX, y: e.clientY, on: false, target: null };
});
function dropTarget(e) {
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const side = under && under.closest('.pl-item[data-guid]');
  if (side) return side.dataset.guid === PL.guid ? null : { guid: side.dataset.guid, name: side.querySelector('.name')?.textContent || '', el: side };
  const sr = plScroller.getBoundingClientRect();
  if (e.clientX < sr.left || e.clientX > sr.right || e.clientY < sr.top || e.clientY > sr.bottom || PL.locked) return null;
  const lr = plList.getBoundingClientRect();
  const y = e.clientY - lr.top, x = e.clientX - lr.left;
  if (PL.mode === 'grid') {
    const r = Math.max(0, Math.floor((y - 8) / PL.rowH)), c = Math.max(0, Math.min(PL.cols - 1, Math.floor(x / (PL.tw + TGAP))));
    let t = r * PL.cols + c; if (x - c * (PL.tw + TGAP) > PL.tw / 2) t++;
    t = Math.min(PL.total, t);
    const col = t % PL.cols, row = Math.floor(t / PL.cols);
    const atEnd = t === PL.total && col === 0 && t > 0;
    return { pos: t, gx: atEnd ? PL.cols * (PL.tw + TGAP) - TGAP / 2 : col * (PL.tw + TGAP) - TGAP / 2, gy: PL.top[atEnd ? row - 1 : row] ?? 8 };
  }
  if (!PL.n) return { pos: 0, y: 0 };
  const i = firstVisible(Math.max(0, y));
  if (PL.kind[i] === 1) { const run = PL.runs[PL.ref[i]]; return { pos: run.start, y: PL.top[i] }; }
  const t = PL.ref[i], h0 = PL.top[i + 1] - PL.top[i];
  if (y > PL.top[i] + h0 / 2) {
    // after this row: before the next album's header, if one follows
    const nx = i + 1 < PL.n && PL.kind[i + 1] === 1 ? PL.top[i + 1] : PL.top[i] + h0;
    return { pos: t + 1, y: nx };
  }
  return { pos: t, y: PL.top[i] };
}
let ghost = null, line = null, autoRaf = 0, lastMove = null;
function autoScroll() {
  autoRaf = 0;
  if (!drag || !drag.on || !lastMove) return;
  const r = plScroller.getBoundingClientRect(), y = lastMove.clientY;
  const v = y < r.top + 48 ? -Math.ceil((r.top + 48 - y) / 4) : y > r.bottom - 48 ? Math.ceil((y - r.bottom + 48) / 4) : 0;
  if (v && lastMove.clientX >= r.left && lastMove.clientX <= r.right) { plScroller.scrollTop += v; moveDrag(lastMove); }
  autoRaf = requestAnimationFrame(autoScroll);
}
function startDrag() {
  if (!PL.selSet.has(drag.t)) { selectOnly(drag.t); selChanged(); }
  drag.on = true;
  document.body.classList.add('pl-dragging');
  const n = PL.selSet.size, tr = trackAt(drag.t);
  ghost = h(`<div class="drag-ghost">${icon('music', 14)}<span></span></div>`);
  ghost.querySelector('span').textContent = n > 1 ? `${n} ${plural(n, 'трек', 'трека', 'треков')}` : (tr && tr.title) || '1';
  document.body.append(ghost);
  line = h('<div class="drop-line"></div>'); plList.append(line);
  autoRaf = requestAnimationFrame(autoScroll);
}
function moveDrag(e) {
  lastMove = { clientX: e.clientX, clientY: e.clientY };
  ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`;
  const tg = dropTarget(e);
  document.querySelectorAll('.pl-item.drop-hl').forEach((x) => { if (!tg || x !== tg.el) x.classList.remove('drop-hl'); });
  drag.target = tg;
  if (tg && tg.el) { tg.el.classList.add('drop-hl'); line.hidden = true; ghost.classList.add('copy'); return; }
  ghost.classList.remove('copy');
  if (!tg) { line.hidden = true; return; }
  line.hidden = false;
  if (PL.mode === 'grid') { line.className = 'drop-line v'; line.style.transform = `translate(${tg.gx}px, ${tg.gy}px)`; line.style.height = PL.th + 'px'; }
  else { line.className = 'drop-line'; line.style.transform = `translateY(${tg.y - 1}px)`; line.style.height = ''; }
}
function endDrag() {
  cancelAnimationFrame(autoRaf); autoRaf = 0; lastMove = null;
  document.body.classList.remove('pl-dragging');
  ghost && ghost.remove(); line && line.remove(); ghost = line = null;
  document.querySelectorAll('.pl-item.drop-hl').forEach((x) => x.classList.remove('drop-hl'));
}
addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.on) { if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return; startDrag(); }
  moveDrag(e);
});
addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.on) return;
  endDrag();
  dragJustEnded = true; setTimeout(() => { dragJustEnded = false; }, 0);
  const tg = d.target;
  if (!tg) return;
  if (tg.guid) addSelectionTo(tg.guid, tg.name);
  else moveSelectionTo(tg.pos);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag && drag.on) { drag = null; endDrag(); } }, true);
// the window lost the mouse or the focus mid-drag (input-guard.js): drop the drag, change nothing
addEventListener('gatefold:input-reset', () => { if (drag) { const on = drag.on; drag = null; if (on) endDrag(); } });

/* keys while the playlist is on screen */
document.addEventListener('keydown', (e) => {
  if (router.current !== 'playlist' || (e.target.closest && e.target.closest('input, textarea, select'))) return;
  const k = e.key.toLowerCase();
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (k === 'delete') { stop(); removeSelected(); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'a' || k === 'ф')) { stop(); PL.selSet = new Set(Array.from({ length: PL.total }, (_, i) => i)); PL.anchor = 0; selChanged(); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'я')) { stop(); plUndo(e.shiftKey); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'н')) { stop(); plUndo(true); }
  else if (e.altKey && (k === 'arrowup' || k === 'arrowdown')) { stop(); moveBy(k === 'arrowup' ? -1 : 1); }
  else if (k === 'enter' && PL.sel >= 0) { stop(); call('playlist.playTrack', { playlistGuid: PL.guid, index: PL.sel }); }
  else if (k === 'escape' && PL.selSet.size) { stop(); clearPlaylistSelection(); }
}, true);
$('plJump').addEventListener('click', () => jumpToPlaying(true));

export function jumpToPlaying(force) {
  if (PL.index !== shared.playing.playlist || shared.playing.index < 0 || !PL.kind) return;
  scrollToTrack(shared.playing.index, force, !force);
}
/** Open the playlist that is playing and bring the playing track into view, highlighted. */
export async function revealPlaying() {
  const r = await call('playback.getCurrentTrackIndex');
  const pi = ok(r) && r.found !== false ? r : null;
  let guid = '';
  if (pi) {
    shared.playing = { playlist: pi.playlist, index: pi.index };
    if (pi.playlistGuid) guid = pi.playlistGuid;
    else { const all = await call('playlist.getAll'); const p = ok(all) && (all.playlists || []).find((x) => x.index === pi.playlist); guid = p ? p.guid : ''; }
  }
  if (!guid) { router.go('playlist'); return; }
  if (router.current === 'playlist' && PL.guid === guid) { flashPlaying(); return; }
  router.go('playlist', guid);
  setTimeout(flashPlaying, 700);
}
function flashPlaying() {
  if (shared.playing.index < 0) return;
  selectOnly(shared.playing.index); scrollToTrack(shared.playing.index, true); schedulePl(); updateSelBar();
  setTimeout(() => plList.querySelector('.vrow.playing, .vtile.playing')?.classList.add('flash'), 450);
  setTimeout(() => plList.querySelector('.flash')?.classList.remove('flash'), 1900);
}
export function refreshPlayingRow() { schedulePl(); }

const reloadPl = debounce((d) => { if (router.current === 'playlist' && (!d || d.playlist === PL.index || d.playlistGuid === PL.guid || d.playlist === undefined)) openPlaylist(PL.guid); }, 250);
['playlist:itemsAdded', 'playlist:itemsRemoved', 'playlist:itemsReordered', 'playlist:itemsReplaced'].forEach((ev) => on(ev, reloadPl));
let plStale = false;
const refreshPlRows = () => { plStale = false; PL.pages.clear(); PL.nodes.forEach((el) => { el.dataset.filled = ''; el.dataset.ok = ''; }); schedulePl(); };
on('metadb:changed', debounce(() => { if (ownRg()) return; if (router.current === 'playlist') refreshPlRows(); else plStale = true; }, 1200));
onRoute((v) => { if (v === 'playlist' && plStale) refreshPlRows(); });

// ============================================================ library grid
const LIB = { hue: null, albums: [], view: [], loaded: false, loading: false, stale: true, cols: 1, tileW: 180, rowH: 240, nodes: new Map() };
const libScroller = $('libScroller'), libGrid = $('libGrid');
const GAP = 8, PAD = 20;

/* Instant start: the album list is kept on disk (IndexedDB). The first time a view
   needs it in a session it is shown from that snapshot at once, and the real list
   is read from foobar a moment later in the background — the grid is redrawn only
   if something actually changed. */
const SNAP = 'library.snapshot.v4';   // v4: albums merged only within one-release folders or by a shared artist (see mergeAlbums)
export const libEvents = new EventTarget();
const fnv = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + ':' + str.length; };
async function fromSnapshot() {
  if (LIB.loaded || LIB.triedSnap) return false;
  LIB.triedSnap = true;
  const snap = await IDB.kvGet(SNAP);
  if (LIB.loaded || !snap || !Array.isArray(snap.albums) || !snap.albums.length) return false;
  LIB.albums = snap.albums; LIB.index = indexFrom(snap.albums); LIB.sig = snap.sig; LIB.loaded = true; LIB.stale = true; LIB.fromSnap = true;
  showCounts();
  await sortLib();
  if (router.current === 'library') { libGrid.innerHTML = ''; LIB.nodes.clear(); applyFilter(); }
  setTimeout(() => idle(3000).then(() => loadLibrary(true, true)), 1500);
  return true;
}
const emptyLib = () => { libGrid.innerHTML = `<div class="empty"><b>${$t('Медиатека пуста')}</b>${emptyActions()}</div>`; libGrid.style.height = ''; };
function ensureTiles() {
  if (router.current !== 'library' || !LIB.loaded) return layoutLib();
  if (!LIB.albums.length) return emptyLib();
  if (!LIB.nodes.size) { if (libGrid.querySelector('.empty')) libGrid.innerHTML = ''; applyFilter(); } else layoutLib();
}
function showCounts() {
  const n = LIB.albums.length;
  $('libCount').textContent = n || '';
  $('libSub').textContent = n ? `${n} ${plural(n, 'альбом', 'альбома', 'альбомов')}` : '';
}

/* ---------------------------------------------------------------- one release = one album
   foo_ui_webview2 files a track under (album, first ALBUM ARTIST value — or first ARTIST
   value when the tag is missing). A guest track ("YUJU, JUNNY", "X feat. Y") or a
   compilation without an album-artist tag is therefore split into several "albums"
   with the same title. They are put back together here:
     - same title (case/width/spacing-insensitive) and the same release folder
       (CD1/Disc 2 sub-folders count as their parent), or
     - same title, same year and a shared artist name when there is no usable folder.
   The merged row keeps every part, so its tracks are fetched from all of them. */
const DISC_DIR = /^(cd|disc|disk|диск|диск\s*№?)\s*\d+\b|^(cd|disc)\d+$/i;
const normTitle = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');
function releaseDir(p) {
  let d = dirOf(p); if (!d) return '';
  const last = d.split(/[\\/]/).pop();
  if (DISC_DIR.test(last.trim())) d = dirOf(d);
  return d.toLowerCase();
}
const SPLIT = /\s*(?:,|;|\/|&|\+|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?|\bx\b|\bи\b)\s*/i;
const artistTokens = (a) => new Set([a.albumArtist, a.artist].flatMap((x) => String(x || '').toLowerCase().split(SPLIT)).map((x) => x.trim()).filter(Boolean));
export function mergeAlbums(rows) {
  // a folder is trusted as «one release» only when every album row in it has the same title;
  // a flat folder holding many albums (or two different «Eternity») must not glue them together
  const titlesIn = new Map();
  for (const a of rows) { const d = releaseDir(a.firstTrackAbsolutePath); if (!d) continue; let s = titlesIn.get(d); if (!s) titlesIn.set(d, s = new Set()); s.add(normTitle(a.name)); }
  const groups = new Map();
  for (const a of rows) {
    const t = normTitle(a.name), d = releaseDir(a.firstTrackAbsolutePath);
    const k = t + '\u0001' + (d || ('~' + (String(a.year || '').match(/\d{4}/) || [''])[0]));
    let g = groups.get(k); if (!g) groups.set(k, g = []);
    g.push(a);
  }
  const out = [], index = new Map();
  for (const g0 of groups.values()) {
    // rows that share an artist name belong together (YUJU + «YUJU, JUNNY»)
    let clusters = [];
    for (const a of g0) {
      const tk = artistTokens(a);
      const c = clusters.find((cl) => [...tk].some((x) => cl.tokens.has(x)));
      if (c) { c.push(a); tk.forEach((x) => c.tokens.add(x)); } else { const n = [a]; n.tokens = tk; clusters.push(n); }
    }
    // in a folder that holds only this title, the leftovers without a shared name are guest tracks or a
    // soundtrack's per-track artists: fragments of at most two tracks join the main part. Two whole
    // albums by unrelated artists never join, wherever they lie.
    const dir = releaseDir(g0[0].firstTrackAbsolutePath);
    if (clusters.length > 1 && dir && titlesIn.get(dir) && titlesIn.get(dir).size === 1) {
      const size = (c) => c.reduce((n, x) => n + (x.trackCount || 0), 0);
      const whole = clusters.filter((c) => size(c) >= 3);
      if (whole.length <= 1) clusters = [clusters.flat()];
      else { const main = whole.sort((a, b) => size(b) - size(a))[0]; for (const c of clusters) if (size(c) < 3) main.push(...c); clusters = whole; }
    }
    for (const g of clusters) {
      if (g.length === 1) { out.push(g[0]); index.set(albumKeyOf(g[0].albumArtist, g[0].name), g[0]); continue; }
      g.sort((x, y) => (y.trackCount || 0) - (x.trackCount || 0));
      const base = g[0];
      // display artist: the name every part shares ("YUJU" for YUJU / "YUJU, JUNNY"), else «Разные исполнители»
      const sets = g.map(artistTokens);
      const common = [...sets[0]].filter((x) => sets.every((s) => s.has(x)));
      let artist = $t('Разные исполнители');
      if (common.length) {
        const cand = g.flatMap((x) => [x.albumArtist, x.artist]).filter(Boolean).find((nm) => { const tk = String(nm).toLowerCase().split(SPLIT).map((x) => x.trim()).filter(Boolean); return tk.length && tk.every((x) => common.includes(x)); });
        artist = cand || base.albumArtist || base.artist;
      }
      const m = { ...base, artist, albumArtist: artist,
        trackCount: g.reduce((n, x) => n + (x.trackCount || 0), 0), duration: g.reduce((n, x) => n + (x.duration || 0), 0),
        year: base.year || g.find((x) => x.year)?.year || '', genre: base.genre || g.find((x) => x.genre)?.genre || '',
        parts: g.map((x) => ({ name: x.name, albumArtist: x.albumArtist })) };
      out.push(m);
      for (const x of g) index.set(albumKeyOf(x.albumArtist, x.name), m);
      index.set(albumKeyOf(m.albumArtist, m.name), m);
    }
  }
  LIB.index = index;
  return out;
}
/** The (possibly merged) album a raw library row belongs to. */
/** the album row a track belongs to (its edition when the album has several), for the album's actions */
export function albumOfTrack(t) {
  const ed = editionOfPath(t.handle) || editionOfPath(t.path);
  return ed || mergedFor({ name: t.album, albumArtist: t.albumArtist || t.artist, artist: t.artist, firstTrackAbsolutePath: t.path, year: t.year });
}
/** the edition a track path belongs to (null when its album has one edition) */
let edMap = null, edFor = null;
export function editionOfPath(p) {
  if (!p || !LIB.albums) return null;
  if (edFor !== LIB.albums) {
    edMap = new Map(); edFor = LIB.albums;
    for (const a of LIB.albums) for (const x of a.edPaths || []) { const k = String(x).toLowerCase(); edMap.set(k, a); edMap.set(k.split('|subsong:')[0], a); }
  }
  if (!edMap.size) return null;
  const k = String(p).toLowerCase();
  return edMap.get(k) || edMap.get(k.split('|subsong:')[0]) || null;
}
export function mergedFor(row) {
  if (!row || row.parts || row.edKey) return row;
  return (LIB.index && LIB.index.get(albumKeyOf(row.albumArtist, row.name))) || row;
}
const indexFrom = (albums) => { const ix = new Map(); for (const a of albums) { if (a.edKey) { ix.set(a.edKey, a); if (ix.has(albumKeyOf(a.albumArtist, a.name))) continue; } ix.set(albumKeyOf(a.albumArtist, a.name), a); for (const p of a.parts || []) ix.set(albumKeyOf(p.albumArtist, p.name), a); } return ix; };

/* ============================================================ editions
   One title by one artist can be two releases: Everybody Wants (2014) and its 2016 reissue with other
   tracks and remixes. foobar2000's album list (and the component's) groups by title + album artist,
   so both played as one album with every song twice. Here an album is split into editions when its
   tracks lie in different release folders (CD1/CD2 sub-folders belong together) or, in one folder,
   carry different years — unless the parts are only the discs of one release (no song in common,
   each its own disc numbers, one year) or share one MusicBrainz release id.
   Each edition is an album of its own: its tracks, its cover, its colours; it is named by its edition
   tag (%edition%, %version%, %releasecomment%), else by what its folder name adds, else by its year. */
const yearOf4 = (d) => (String(d || '').match(/\d{4}/) || [''])[0];
const songOf = (t) => String(t || '').toLowerCase().replace(/[([][^)\]]*[)\]]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const tileKey = (a) => a.name + '\u0001' + a.albumArtist + (a.edKey ? '\u0002' + a.edKey : '');
/** every track of the library, once per load: editions and the artists of each album come from it */
async function enrichAlbums(rows) {
  if (!rows.length) return rows;
  const tracks = await TS.all();                     // shared with Folders and Tracks (trackstore.js)
  if (!tracks.length) return rows.map(withNames);
  const index = indexFrom(rows);
  const byRow = new Map(), seen = new Set();
  for (const t of tracks) {
    for (const v of t.artists || []) seen.add(v);
    for (const v of t.albumArtists || []) seen.add(v);
    if (!t.album) continue;
    // the album's identity is the first value of «album artist» (else of «artist»), as foobar2000 groups it
    const by = (t.albumArtists && t.albumArtists[0]) || (t.artists && t.artists[0]) || t.albumArtist || t.artist || '';
    const row = index.get(albumKeyOf(by, t.album)); if (!row) continue;
    let l = byRow.get(row); if (!l) byRow.set(row, (l = [])); l.push(t);
  }
  const out = []; let split = false;
  for (const row0 of rows) {
    const list = byRow.get(row0);
    const row = withNames(row0, list);
    const eds = settings.splitEditions !== false && list && list.length >= 4 ? editionsOf(row, list) : null;
    if (!eds) { out.push(row); continue; }
    // the edition tags, for the names (only these few albums are asked)
    const tf = await bgCall('titleformat.evalFieldsBatch', { paths: eds.map((e) => e.tracks[0].absolutePath), fields: { ed: '[$if2(%edition%,$if2(%version%,%releasecomment%))]', mb: '[%musicbrainz_albumid%]' } }, 'normal');
    const tags = ok(tf) ? tf.results || [] : [];
    const mbs = new Set(tags.map((x) => String((x && x.mb) || '').trim()).filter(Boolean));
    if (mbs.size === 1 && tags.every((x) => x && x.mb)) { out.push(row); continue; }      // one release, by its id
    const years = new Set(eds.map((e) => e.year));
    const base = (s) => normTitle(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const drop = new Set([...base(row.name).split(' '), ...base(row.albumArtist || row.artist).split(' ')]);
    const label = (e, i) => {
      const tag = String((tags[i] && tags[i].ed) || '').trim();
      const extra = base(e.folder).split(' ').filter((w) => w && !drop.has(w) && !/^\d{4}$/.test(w)).join(' ');
      const words = tag || (extra && extra.length <= 40 ? extra.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : '');
      return [years.size > 1 ? e.year : '', words].filter(Boolean).join(' · ') || e.folder || e.year || String(i + 1);
    };
    const keys = eds.map((e) => albumKeyOf(row.albumArtist || row.artist, row.name) + '\u0002' + e.id);
    eds.forEach((e, i) => {
      const t0 = e.tracks.slice().sort((x, y) => (x.discNumber || 1) - (y.discNumber || 1) || String(x.absolutePath).localeCompare(String(y.absolutePath)))[0];
      out.push({ ...row, edition: label(e, i), edKey: keys[i], edSiblings: keys, edPaths: e.tracks.map(trackHandle),
        trackCount: e.tracks.length, duration: e.tracks.reduce((n, t) => n + (t.duration || 0), 0), year: e.year || row.year, firstTrackAbsolutePath: t0.absolutePath });
    });
    split = true;
  }
  if (split) LIB.index = indexFrom(out);
  LIB.names = [...seen];
  return out;
}
/** the artists an album is listed under: every value of its «album artist» tag (a value most of its
    tracks carry), each split by the separators in use — «A; B» is listed under A and under B */
function withNames(row, tracks) {
  let vals = [];
  if (tracks && tracks.length) {
    const n = new Map();
    for (const t of tracks) for (const v of new Set(t.albumArtists || [])) n.set(v, (n.get(v) || 0) + 1);
    vals = [...n.entries()].filter(([, c]) => c >= tracks.length / 2).map(([v]) => v);
  }
  if (!vals.length || row.parts) vals = [row.albumArtist || row.artist].filter(Boolean);
  const names = Names.splitAll(vals);
  if (names.length < 2) return row;
  // a multi-value tag shows all its names, not only the first one foobar2000 groups by
  const shown = vals.length > 1 && row.artist === vals[0] ? vals.join(', ') : row.artist;
  return { ...row, artists: names, artist: shown };
}
/** the editions of one album's tracks, or null when it is one release */
function editionsOf(row, list) {
  const groups = new Map();
  for (const t of list) { const d = releaseDir(t.absolutePath); let g = groups.get(d); if (!g) groups.set(d, (g = [])); g.push(t); }
  let parts = [...groups.entries()].map(([dir, tracks]) => ({ id: 'd:' + dir, dir, tracks }));
  if (parts.length < 2) {
    // one folder: the years tell the releases apart
    const ys = new Map();
    for (const t of list) { const y = yearOf4(t.date); let g = ys.get(y); if (!g) ys.set(y, (g = [])); g.push(t); }
    parts = [...ys.entries()].filter(([y]) => y).map(([y, tracks]) => ({ id: 'y:' + y, dir: [...groups.keys()][0], tracks }));
    if (parts.length < 2 || parts.some((p) => p.tracks.length < 3) || parts.reduce((n, p) => n + p.tracks.length, 0) < list.length * 0.9) return null;
  }
  if (parts.some((p) => p.tracks.length < 2)) return null;
  // only the discs of one release (no song twice, each part its own discs, one year): one album
  const songs = parts.map((p) => new Set(p.tracks.map((t) => songOf(t.title)).filter(Boolean)));
  const shared = songs.slice(1).some((s, i) => [...s].some((x) => songs.slice(0, i + 1).some((o) => o.has(x))));
  const discs = parts.map((p) => new Set(p.tracks.map((t) => t.discNumber || 1)));
  const disjointDiscs = discs.every((d, i) => discs.every((o, j) => i === j || ![...d].some((x) => o.has(x))));
  const years = new Set(parts.map((p) => yearOf4(p.tracks.find((t) => yearOf4(t.date))?.date)).filter(Boolean));
  if (!shared && years.size <= 1 && (disjointDiscs || parts[0].id.startsWith('d:'))) return null;
  return parts.map((p) => ({ ...p, year: yearOf4((p.tracks.find((t) => yearOf4(t.date)) || {}).date), folder: String(p.dir).split(/[\\/]/).pop() || '' }))
    .sort((a, b) => (a.year || '9999').localeCompare(b.year || '9999') || a.folder.localeCompare(b.folder));
}

/** All album rows of the media library (loads once, shared with Artists). */
export async function getAllAlbums() {
  while (LIB.loading) await sleep(80);
  if (!LIB.loaded && await fromSnapshot()) return LIB.albums;
  if (!LIB.loaded || (LIB.stale && !LIB.fromSnap)) await loadLibrary(true);
  while (LIB.loading) await sleep(80);
  return LIB.albums;
}

/** read the library again and rebuild its rows (after a change of how they are formed) */
export async function rebuildLibrary() { while (LIB.loading) await sleep(80); LIB.sig = ''; LIB.stale = true; LIB.fromSnap = false; await loadLibrary(true); }
/** every artist name the library holds (album artists, track artists), for the separators preview */
export const artistNamesSeen = () => [...new Set([...(LIB.names || []), ...LIB.albums.flatMap((a) => [a.albumArtist, a.artist])].filter(Boolean))];
export async function loadLibrary(force, background = false) {
  if (!LIB.loaded && !background && await fromSnapshot()) { ensureTiles(); return; }
  if (LIB.loading || (LIB.loaded && !force && (!LIB.stale || LIB.fromSnap))) { ensureTiles(); return; }
  LIB.loading = true;
  if (!LIB.albums.length) libGrid.innerHTML = `<div class="empty"><div class="spinner"></div><b>${$t('Читаю медиатеку…')}</b></div>`;
  $('libSort').value = settings.librarySort;
  const out = [];
  for (let off = 0; off < 200000; off += 1000) {
    const q = { offset: off, limit: 1000, sort: 'name' }; // ordering is done in sorting.js
    const r = background ? await bgCall('library.getAlbums', q, 'normal') : await call('library.getAlbums', q);
    if (!ok(r)) break;
    out.push(...(r.albums || []));
    if (!r.hasMore) break;
  }
  // Playback Statistics rewrites play counts after every song → library:itemsModified.
  // If nothing that the grid shows changed, keep the DOM (and the same array, which
  // tells Artists not to rebuild either).
  if (!out.length && LIB.loaded && LIB.albums.length) { LIB.loading = false; return; } // host hiccup: keep what we show
  // the settings that shape the rows (editions, artist separators) are part of the signature
  const shape = JSON.stringify(['e1', settings.splitEditions !== false, settings.artistSplit || [';'], settings.artistKeep || []]);
  const sig = fnv(shape + out.length + '\u0002' + out.map((a) => `${a.name}\u0001${a.albumArtist || a.artist}\u0001${a.year || ''}\u0001${a.trackCount || 0}\u0001${a.firstTrackAbsolutePath}\u0001${a.genre || ''}`).sort().join('\u0003'));
  LIB.fromSnap = false;
  if (LIB.loaded && sig === LIB.sig) { LIB.stale = false; LIB.loading = false; layoutLib(); return; }
  const wasLoaded = LIB.loaded;
  LIB.sig = sig;
  const plain = mergeAlbums(out);
  // editions and artist names are extras: a failure there must not leave the library unread
  const merged = await enrichAlbums(plain).catch((e) => { log('library: editions/artists skipped', e && e.message); return plain; });
  LIB.albums = merged; LIB.loaded = true; LIB.stale = false; LIB.loading = false;
  IDB.kvSet(SNAP, { albums: merged, sig, t: Date.now() });
  showCounts();
  if (wasLoaded) libEvents.dispatchEvent(new Event('changed'));
  libGrid.innerHTML = ''; LIB.nodes.clear();
  if (!out.length) { emptyLib(); return; }
  await sortLib();
  applyFilter();
}

let warnedNoStats = false;
async function sortLib() {
  const by = settings.librarySort;
  if (by === 'added' || by === 'played') {
    const has = await SORT.ensure(by, LIB.albums);
    if (!has && !warnedNoStats) { warnedNoStats = true; toast($t('Нужен foo_playcount'), { ms: 7000 }); }
  }
  if (by === 'color') { await Colors.ensure([]); Colors.ensure(LIB.albums); }
  LIB.sorted = SORT.sortAlbums(LIB.albums, by);
  LIB.needResort = false;
  ribbon();
}
/* «By cover colour»: twelve named colours above the grid; a click keeps only that colour */
const COLOR_NAMES = () => ({ red: $t('Красный'), orange: $t('Оранжевый'), yellow: $t('Жёлтый'), green: $t('Зелёный'), teal: $t('Бирюзовый'), blue: $t('Синий'),
  purple: $t('Фиолетовый'), pink: $t('Розовый'), brown: $t('Коричневый'), white: $t('Белый'), grey: $t('Серый'), black: $t('Чёрный') });
function ribbon() {
  const el = $('libRibbon');
  const on = settings.librarySort === 'color';
  el.hidden = !on;
  if (!on) { if (LIB.hue != null) { LIB.hue = null; } return; }
  if (!el.dataset.built) {
    el.dataset.built = '1';
    const names = COLOR_NAMES();
    el.innerHTML = `<div class="cr-sw">${Colors.CATS.map((c) => `<button class="cr-b" data-c="${c.id}" title="${$t('Только этот цвет')}"><i style="--c:${c.sw}"></i><span>${names[c.id]}</span><small></small></button>`).join('')}</div><span class="cr-info"></span>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('.cr-b'); if (!b) return;
      LIB.hue = LIB.hue === b.dataset.c ? null : b.dataset.c;
      libScroller.scrollTop = 0; applyFilter(); ribbonInfo();
    });
  }
  ribbonInfo();
}
function ribbonInfo() {
  const el = $('libRibbon'); if (el.hidden) return;
  const n = Colors.counts(LIB.albums);
  el.querySelectorAll('.cr-b').forEach((b, i) => { b.classList.toggle('on', LIB.hue === b.dataset.c); b.querySelector('small').textContent = n[i] ? n[i] : ''; b.classList.toggle('empty', !n[i]); });
  el.classList.toggle('picked', LIB.hue != null);
  const st = Colors.state;
  el.querySelector('.cr-info').innerHTML = st.running
    ? `<span class="spinner"></span>${$t('Разбираю цвета обложек: {0} из {1}', st.done, st.total)}`
    : LIB.hue != null ? `${LIB.view.length} ${plural(LIB.view.length, 'альбом', 'альбома', 'альбомов')}` : '';
}
let lastColorSort = 0;
Colors.events.addEventListener('progress', () => {
  if (settings.librarySort !== 'color' || !LIB.loaded) return;
  ribbonInfo();
  const now = performance.now();
  if (Colors.state.running && now - lastColorSort < 2500) return;
  lastColorSort = now;
  LIB.sorted = SORT.sortAlbums(LIB.albums, 'color');
  if (router.current === 'library') { applyFilter(); ribbonInfo(); }
});
/* "Recently played": the album that just started moves to the front — re-ordered when
   the grid is scrolled to the top or the next time it is opened, never under the cursor. */
SORT.events.addEventListener('played', () => {
  if (settings.librarySort !== 'played' || !LIB.loaded) return;
  LIB.needResort = true;
  if (router.current === 'library' && libScroller.scrollTop < 40) idle(2000).then(() => { if (LIB.needResort) { sortLib().then(applyFilter); } });
});
onRoute((v) => { if (v === 'library' && LIB.needResort && LIB.loaded && !LIB.loading) sortLib().then(applyFilter); });

function applyFilter() {
  const q = $('libFilter').value.trim().toLowerCase();
  const base = LIB.sorted || LIB.albums;
  let view = q ? base.filter((a) => (a.name + ' ' + a.artist + ' ' + (a.year || '') + ' ' + (a.genre || '')).toLowerCase().includes(q)) : base;
  if (LIB.hue != null && settings.librarySort === 'color') {
    // the covers of which it is the main colour first, then those where it is a strong second one
    const main = [], second = [];
    for (const a of view) { const m = Colors.matches(a, LIB.hue); if (m === 2) main.push(a); else if (m === 1) second.push(a); }
    view = main.concat(second);
  }
  LIB.view = view;
  libGrid.querySelectorAll('.tile').forEach((t) => t.remove()); LIB.nodes.clear();
  layoutLib();
  if (settings.librarySort === 'color') ribbonInfo();
}

function layoutLib() {
  if (!LIB.view.length && LIB.loaded) { libGrid.style.height = '200px'; return; }
  const W = libScroller.clientWidth - PAD * 2;
  const min = 168 + (settings.baseSize - 14) * 8;
  LIB.cols = Math.max(2, Math.floor((W + GAP) / (min + GAP)));
  LIB.tileW = (W - GAP * (LIB.cols - 1)) / LIB.cols;
  LIB.rowH = LIB.tileW - 20 + tileMeta();
  libGrid.style.height = Math.ceil(LIB.view.length / LIB.cols) * LIB.rowH + 40 + 'px';
  scheduleLib(true);
}

let libRaf = 0, relayout = false;
function scheduleLib(re) { relayout = relayout || re; if (!libRaf) libRaf = requestAnimationFrame(() => { libRaf = 0; renderLib(relayout); relayout = false; }); }
libScroller.addEventListener('scroll', () => scheduleLib(false), { passive: true });
new ResizeObserver(() => { if (router.current === 'library' && !Folders.active() && !Tracks.active()) layoutLib(); }).observe(libScroller);

function renderLib(re) {
  if (router.current !== 'library' || !LIB.view.length) return;
  const st = libScroller.scrollTop, vh = libScroller.clientHeight;
  const r0 = Math.max(0, Math.floor((st - 400) / LIB.rowH)), r1 = Math.ceil((st + vh + 400) / LIB.rowH);
  const keep = new Set(), want = [];
  for (let r = r0; r <= r1; r++) for (let c = 0; c < LIB.cols; c++) {
    const i = r * LIB.cols + c; if (i >= LIB.view.length) break;
    const a = LIB.view[i]; const key = tileKey(a);
    keep.add(key);
    let el = LIB.nodes.get(key);
    if (!el) {
      const ph = placeholder(a.name, a.albumArtist);
      el = h(`<div class="tile"><div class="cov"><div class="ph" style="background:${ph.bg}">${esc(ph.ini)}</div><img alt=""><button class="play" title="${$t('Слушать')}">${icon('play', 18)}</button></div><div class="tt"></div><div class="ta"></div></div>`);
      el.querySelector('.tt').textContent = a.name;
      el.querySelector('.ta').textContent = [a.artist, a.edition || (String(a.year || '').match(/\d{4}/) || [''])[0]].filter(Boolean).join(' · ');
      el.querySelector('.play').addEventListener('click', (e) => { e.stopPropagation(); playAlbumRow(a); });
      el.addEventListener('click', () => router.go('album', a));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); albumMenu(a, e.clientX, e.clientY); });
      libGrid.appendChild(el); LIB.nodes.set(key, el); re = true;
      if (a.firstTrackAbsolutePath) want.push([el, a.firstTrackAbsolutePath, a]);
    }
    if (re) { el.style.cssText = `width:${LIB.tileW}px;transform:translate(${PAD + c * (LIB.tileW + GAP)}px,${r * LIB.rowH + 4}px)`; }
  }
  for (const [k, el] of LIB.nodes) if (!keep.has(k)) { el.remove(); LIB.nodes.delete(k); }
  if (want.length) {
    const size = Math.min(600, Math.round(LIB.tileW * dpr() / 50) * 50);
    coversFor(want.map((x) => x[1]), size).then((get) => {
      for (const [el, p, a] of want) { const u = get(p); const img = el.querySelector('img'); img.addEventListener('load', () => { if (img.naturalWidth > 1) el.querySelector('.ph')?.remove(); }, { once: true }); setImg(img, u, () => coverMissing(a)); }
    });
  }
}

$('libFilter').addEventListener('input', debounce(() => { if (Folders.active()) Folders.filter($('libFilter').value); else if (Tracks.active()) Tracks.filter($('libFilter').value); else applyFilter(); }, 120));
$('libSort').addEventListener('change', async (e) => {
  setSetting('librarySort', e.target.value);
  if (!LIB.loaded) return loadLibrary(true);
  await sortLib(); applyFilter(); libScroller.scrollTop = 0;
});
['library:itemsAdded', 'library:itemsRemoved', 'library:itemsModified'].forEach((ev) => on(ev, settle(() => { if (ev === 'library:itemsModified' && ownRg()) return; LIB.stale = true; if (router.current === 'library') idle(4000).then(() => loadLibrary(true)); }, ev === 'library:itemsModified' ? 6000 : 3000, 30000)));
CF.events.addEventListener('saved', (e) => {
  const p = e.detail.job.path; forgetCover(p);
  for (const a of LIB.albums) if (a.firstTrackAbsolutePath === p) {
    const el = LIB.nodes.get(tileKey(a));
    if (el) { el.querySelector('.fetching')?.remove(); const img = el.querySelector('img'); img.style.display = ''; img.onload = () => { img.classList.add('on'); el.querySelector('.ph')?.remove(); }; img.src = e.detail.url; }
  }
});

async function albumMenu(a, x, y) {
  const id = await popupMenu([
    { id: 'play', label: $t('Слушать альбом') },
    { id: 'queue', label: $t('Добавить в очередь') },
    ...(shared.radioFor ? [{ id: 'radio', label: $t('Радио «Похожее на это»') }] : []),
    { type: 'sep' },
    { id: 'cover', label: $t('Обложка…') },
    { id: 'colors', label: $t('Цвета…') },
    { id: 'folder', label: $t('Показать папку в медиатеке') },
    { id: 'explorer', label: $t('Показать в проводнике') },
  ], x, y);
  if (id === 'folder' && a.firstTrackAbsolutePath) Folders.reveal(a.firstTrackAbsolutePath);
  if (id === 'colors') AC.open(a);
  if (id === 'play') playAlbumRow(a);
  if (id === 'queue') queueAlbum(a);
  if (id === 'radio') shared.radioFor(a.albumArtist || a.artist);
  if (id === 'cover') CoverPick.open(a);
  if (id === 'explorer' && a.firstTrackAbsolutePath) call('shell.showInExplorer', { path: a.firstTrackAbsolutePath });
}

/** Tracks of an album, from every part of a merged one, in disc/track order. */
export async function albumTracks(a) {
  const parts = a.parts || [{ name: a.name, albumArtist: a.albumArtist }];
  const lists = await Promise.all(parts.map((p) => call('library.getAlbumTracks', { album: p.name, albumArtist: p.albumArtist })));
  let all = lists.flatMap((r) => (ok(r) ? (r.tracks || r.items || []) : []));
  if (a.edPaths) { const mine = new Set(a.edPaths.map((x) => String(x).toLowerCase())); all = all.filter((t) => mine.has(String(trackHandle(t)).toLowerCase())); }
  if (parts.length > 1) all.sort((x, y) => ((x.discNumber || 1) - (y.discNumber || 1)) || ((x.trackNumber || 0) - (y.trackNumber || 0)) || String(x.absolutePath || '').localeCompare(String(y.absolutePath || '')));
  return all;
}
export async function playAlbumRow(a, start = 0) {
  const tracks = await albumTracks(a);
  if (!tracks.length) { toast($t('Не удалось получить треки альбома')); return; }
  await playPaths(tracks.map((t) => t.handle || t.absolutePath), start, a.name);
}
async function queueAlbum(a) {
  const tracks = await albumTracks(a);
  const r = await call('queue.addPaths', { paths: tracks.map((t) => t.handle || t.absolutePath) });
  toast(ok(r) ? $t('«{0}» добавлен в очередь', esc(a.name)) : $t('Очередь недоступна: ') + esc(r.error || ''));
}

/** Plays a list of paths according to settings.albumTarget. */
/** the playlist an album or a list is played in: the active one, or Gatefold's own (Settings → Behaviour) */
export async function playTarget() {
  let guid = '';
  if (settings.albumTarget === 'active') {
    const a = await call('playlist.getActive'); guid = ok(a) && a.found !== false ? a.guid : '';
  }
  if (!guid) {
    const all = await call('playlist.getAll');
    const ex = ok(all) && ((all.playlists || []).find((p) => p.name === 'Gatefold') || (all.playlists || []).find((p) => p.name === 'Aurora'));
    if (ex) guid = ex.guid;
    else { const c = await call('playlist.create', { name: 'Gatefold' }); guid = ok(c) ? c.guid : ''; }
  }
  return guid;
}
export async function playPaths(paths, start = 0, label = '') {
  shared.playGen = (shared.playGen || 0) + 1;            // a list still being filled in the background (tracks.js) stops
  const guid = await playTarget();
  if (!guid) { toast($t('Не удалось подготовить плейлист')); return; }
  await call('playlist.clear', { playlistGuid: guid });
  const add = await call('library.addToPlaylist', { paths, playlistGuid: guid });
  if (!ok(add)) { const alt = await call('playlist.addPathsSequential', { paths, playlistGuid: guid }); if (!ok(alt)) { toast($t('Ошибка добавления: ') + esc(add.error || '')); return; } }
  await call('playlist.setActive', { playlistGuid: guid });
  await call('playlist.playTrack', { playlistGuid: guid, index: start });
  if (shared.onPlayAlbum) shared.onPlayAlbum(label);
}

// ============================================================ album page
const albumView = $('view-album');
let albumToken = 0;
/** «Другие издания: 2014 · 2016 Deluxe» under the title of an album that has several */
function editionsHtml(a) {
  const others = (a.edSiblings || []).filter((k) => k !== a.edKey).map((k) => LIB.index && LIB.index.get(k)).filter(Boolean);
  if (!others.length) return '';
  return `<div class="al-eds">${$t('Другие издания:')} ${others.map((o) => `<button class="link" data-ed="${esc(o.edKey)}">${esc(o.edition)}</button>`).join('<span class="dot">·</span>')}</div>`;
}
export async function openAlbum(a) {
  if (!a) return;
  a = mergedFor(a);
  const token = ++albumToken;
  const year = (String(a.year || '').match(/\d{4}/) || [''])[0];
  const ph = placeholder(a.name, a.albumArtist);
  $('albumHero').innerHTML = `
    <div class="album-cover" style="background:${ph.bg}"><img alt="" style="display:none"></div>
    <div style="min-width:0">
      <div class="kicker">${$t('Альбом')}${year ? ' · ' + year : ''}${a.genre ? ' · ' + esc(a.genre) : ''}</div>
      <h1>${esc(a.name)}${a.edition ? ` <span class="al-ed">${esc(a.edition)}</span>` : ''}</h1>
      ${editionsHtml(a)}
      <div class="album-meta"><b id="albumArtistLink">${(a.artists && a.artists.length > 1 ? a.artists : [a.artist || a.albumArtist || '']).map((n) => `<span class="link" data-ar="${esc(n)}">${esc(n)}</span>`).join(', ')}</b> · <span class="more-link" id="albumMore" role="button" tabindex="0" title="${$t('Подробнее об альбоме (I)')}">${a.trackCount || 0} ${plural(a.trackCount || 0, 'трек', 'трека', 'треков')} · ${fmtDuration(a.duration || 0)}</span>${a.label ? ' · ' + esc(a.label) : ''}</div>
      <div class="album-actions">
        <button class="btn primary" id="alPlay">${icon('play')}${$t('Слушать')}</button>
        <button class="btn" id="alQueue">${icon('queue')}${$t('В очередь')}</button>
        <button class="btn" id="alCover">${icon('image')}${$t('Обложка…')}</button>
        <button class="btn" id="alColors" title="${$t('Свои цвета альбома')}">${icon('palette')}${$t('Цвета…')}</button>
        <button class="btn" id="alFolder">${icon('folder')}${$t('Папка')}</button>
        <button class="btn toggle-btn" id="alDetails" aria-pressed="false" title="${$t('Подробнее об альбоме (I)')}">${icon('info')}${$t('Подробнее\u0004album')}</button>
      </div>
    </div>
    <div class="album-facts" id="albumFacts" aria-live="polite"></div>`;
  $('albumHero').prepend(backButton('library'));
  $('alPlay').onclick = () => playAlbumRow(a);
  $('alQueue').onclick = () => queueAlbum(a);
  $('alCover').onclick = () => CoverPick.open(a);
  $('alColors').onclick = () => AC.open(a);
  $('alFolder').onclick = () => call('shell.showInExplorer', { path: a.firstTrackAbsolutePath });
  $('albumArtistLink').onclick = (e) => { const l = e.target.closest('[data-ar]'); if (l) router.go('artist', a.artists && a.artists.length > 1 ? l.dataset.ar : a.albumArtist || a.artist); };
  $('alDetails').onclick = toggleAlbumDetails;
  $('albumHero').querySelectorAll('.al-eds [data-ed]').forEach((b) => { b.onclick = () => { const o = LIB.index && LIB.index.get(b.dataset.ed); if (o) router.go('album', o); }; });
  $('albumMore').onclick = toggleAlbumDetails;
  $('albumMore').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAlbumDetails(); } };
  ALB.a = a; ALB.tracks = null; ALB.ext = null; ALB.token = token; ALB.loading = null; ALB.plainOnce = false; ALB.cx = null; ALB.cxv = null;
  paintDetailsState();
  if (a.firstTrackAbsolutePath) {
    const get = await coversFor([a.firstTrackAbsolutePath], Math.round(220 * dpr()));
    const u = get(a.firstTrackAbsolutePath);
    if (u && token === albumToken) setImg(albumView.querySelector('.album-cover img'), u);
  }
  // scoped palette: the album page previews this album's colours without re-theming the app
  paintAlbumColors(a, token);
  const tracks = await albumTracks(a);
  if (token !== albumToken) return;
  const list = $('albumList');
  ALB.tracks = tracks;
  renderAlbumRows();
  list.onclick = (e) => { const lk = e.target.closest('.lnk[data-go=artist]'); if (lk && !e.shiftKey && !e.ctrlKey) { router.go('artist', lk.textContent); return; } heartClick(e, (r) => tracks[+r.dataset.i]); };
  list.ondblclick = (e) => { if (e.target.closest('.row-like')) return; const r = e.target.closest('.vrow'); if (r) playPaths(tracks.map((t) => t.handle || t.absolutePath), +r.dataset.i, a.name); };
  list.oncontextmenu = (e) => { const r = e.target.closest('.vrow'); if (!r) return; e.preventDefault(); const t = tracks[+r.dataset.i]; call('menu.showNativePopup', { mode: 'handles', handles: [trackHandle(t)] }); };
  $('albumScroller').scrollTop = 0;
  renderSimilar(a, token);
}

/** the album page previews this album's colours (yours, or the cover's) without re-theming the app */
function paintAlbumColors(a, token = albumToken) {
  paletteForAlbum(a.albumArtist, a.name, a.firstTrackAbsolutePath, a.edKey || '').then((p) => {
    if (token !== albumToken) return;
    albumView.style.setProperty('--a-accent', p.accent.css);
    albumView.style.setProperty('--a-glow', p.glow.css);
    $('alColors')?.classList.toggle('on', AC.has(a));
  });
}
AC.events.addEventListener('change', (e) => { if (ALB.a && AC.keyOf(ALB.a) === e.detail.key) paintAlbumColors(ALB.a); });
// a track's edition, for the colours (each edition has its own cover and may have its own colours)
setEditionKeyResolver((t) => (editionOfPath(t.handle) || editionOfPath(t.path) || editionOfPath(t.absolutePath))?.edKey || '');

/* ---------------------------------------------------------------- album details (album-details.js)
   Off by default; «Details», a click on the track count, or I. The choice is remembered. */
const ALB = { a: null, tracks: null, ext: null, token: 0, loading: null, plainOnce: false, cx: null, cxv: null, focus: '' };
/** open the album page with this track marked (a song link in a playlist) */
export function focusNextAlbumTrack(handle) { ALB.focus = String(handle || '').toLowerCase(); }
const albumHeadEl = albumView.querySelector('.list-head');
albumHeadEl.addEventListener('contextmenu', (e) => { e.preventDefault(); Cx.headerMenu('al', e.clientX, e.clientY); });
albumHeadEl.addEventListener('click', (e) => { const b = e.target.closest('.lh-cfg'); if (b) { const r = b.getBoundingClientRect(); Cx.headerMenu('al', r.right - 220, r.bottom + 4); } });
const albumHead = albumView.querySelector('.list-head');
const CFG_BTN = () => `<button class="lh-cfg icon-btn" title="${$t('Колонки')}" aria-label="${$t('Колонки')}">${icon('more')}</button>`;
const HEAD0 = (cx = []) => `<div>#</div><div>${$t('Название')}</div><div>${$t('Исполнитель')}</div><div class="h-album">${$t('Формат')}</div>${cx.length ? Cx.headHtml(cx) + '<div class="h-gap"></div>' : ''}<div>${$t('Время')}</div>${CFG_BTN()}`;
export function toggleAlbumDetails() {
  setSetting('albumDetails', !settings.albumDetails);
  paintDetailsState();
  renderAlbumRows();
}
function paintDetailsState() {
  const on = !!settings.albumDetails;
  albumView.classList.toggle('details', on);
  const b = $('alDetails'); if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  const box = $('albumFacts'); if (!box) return;
  if (!on) { box.innerHTML = ''; return; }
  if (ALB.ext && ALB.tracks) {
    box.innerHTML = AD.factsHtml(AD.facts(ALB.a, ALB.tracks, ALB.ext));
    box.querySelectorAll('[data-act=folder]').forEach((el) => { el.onclick = () => $('alFolder').click(); el.onkeydown = (e) => { if (e.key === 'Enter') el.click(); }; });
    // a single line of facts (narrow window) scrolls sideways with the wheel too
    box.onwheel = (e) => { if (box.scrollWidth > box.clientWidth + 2 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); box.scrollLeft += e.deltaY; } };
  } else box.innerHTML = '<div class="f sk"><div class="k skeleton"></div><div class="v skeleton"></div></div>'.repeat(6);
}
function renderAlbumRows() {
  const tracks = ALB.tracks, list = $('albumList');
  if (!tracks) return;
  const on = !!settings.albumDetails;
  if (on && !ALB.ext) {
    // the values usually arrive within a few frames: wait for them rather than draw the plain
    // columns and swap them a moment later (a slow answer still gets the plain list after 600 ms)
    const token = ALB.token;
    if (!ALB.loading) {
      ALB.loading = AD.load(tracks).then((ext) => { ALB.loading = null; if (token !== albumToken || ALB.tracks !== tracks) return; ALB.ext = ext; paintDetailsState(); if (settings.albumDetails) renderAlbumRows(); });
      setTimeout(() => { if (token === albumToken && ALB.tracks === tracks && !ALB.ext && !list.children.length) { ALB.plainOnce = true; renderAlbumRows(); } }, 600);
    }
    if (!ALB.plainOnce) { if (!list.querySelector('.vrow') || list.dataset.album !== String(ALB.token)) { list.innerHTML = ''; list.style.height = tracks.length * ROW + 24 + 'px'; } return; }
  }
  ALB.plainOnce = false;
  const detailed = on && ALB.ext;
  // your own columns (columns.js): drawn at once, their values filled in when foobar2000 has them
  const cx = Cx.forView('al');
  if (JSON.stringify(cx) !== JSON.stringify(ALB.cx)) {
    ALB.cx = cx; ALB.cxv = null;
    if (cx.length) { const token = ALB.token; Cx.values(tracks.map((t) => trackHandle(t)), cx).then((v) => { if (token !== ALB.token || ALB.cx !== cx) return; ALB.cxv = v; list.querySelectorAll('.vrow').forEach((r) => Cx.fill(r, v[+r.dataset.i])); }); }
  }
  const cxCells = (i) => (cx.length ? Cx.cellsHtml(cx, ALB.cxv && ALB.cxv[i]) : '');
  const artistCell = (t) => artistLinks(t.artist || '');
  list.style.height = tracks.length * ROW + 24 + 'px';
  let disc = -1;
  const multiDisc = new Set(tracks.map((t) => t.discNumber || 0)).size > 1;
  const discChip = (t) => (multiDisc && t.discNumber !== disc ? (disc = t.discNumber, `<span class="chip" style="margin-left:6px">CD${t.discNumber}</span>`) : '');
  if (detailed) {
    const C = AD.columns(ALB.a, tracks, ALB.ext, cx.map((c, j) => ({ w: Cx.gridOf([c]), head: c.name || c.tf, title: c.tf, cls: Cx.cellClass(c), attr: ` data-cx="${j}"`, cell: (t, x, i) => esc((ALB.cxv && ALB.cxv[i] && ALB.cxv[i][j]) || '') })));
    albumHead.innerHTML = C.head + CFG_BTN(); albumHead.classList.add('cols'); albumHead.style.setProperty('--cols', C.cols);
    list.classList.add('cols'); list.style.setProperty('--cols', C.cols);
    list.innerHTML = tracks.map((t, i) => {
      const x = ALB.ext[i];
      const cells = C.cells.map((c) => `<div class="${c.cls}"${c.attr || ''}>${c.cls === 'c-title' ? c.cell(t, x, i) + discChip(t) : c.cls === 'c-artist' ? artistCell(t) : c.cell(t, x, i)}</div>`).join('');
      return `<div class="vrow" data-i="${i}"${likeAttr(t)} style="transform:translateY(${i * ROW}px)">${cells}${LIKE_BTN}</div>`;
    }).join('');
  } else {
    const grid = cx.length ? `44px minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) ${Cx.gridOf(cx)} 30px 64px` : '';
    albumHead.innerHTML = HEAD0(cx);
    for (const el of [albumHead, list]) { el.classList.toggle('cols', !!grid); if (grid) el.style.setProperty('--cols', grid); else el.style.removeProperty('--cols'); }
    list.innerHTML = tracks.map((t, i) => `<div class="vrow" data-i="${i}"${likeAttr(t)} style="transform:translateY(${i * ROW}px)"><div class="c-n num">${t.trackNumber || i + 1}</div><div class="c-title">${esc(t.title)}${discChip(t)}</div><div class="c-artist">${artistCell(t)}</div><div class="c-album">${esc([t.codec, t.sampleRate ? (t.sampleRate / 1000).toFixed(1).replace('.0', '') + $t(' кГц') : ''].filter(Boolean).join(' · '))}</div>${cx.length ? cxCells(i) + '<div class="c-gap"></div>' : ''}<div class="c-dur num">${fmtTime(t.duration)}</div>${LIKE_BTN}</div>`).join('');
  }
  list.dataset.album = String(ALB.token);
  list.querySelectorAll('.vrow').forEach(likeRow);
  if (ALB.focus) {
    // a song link: its row, marked and in view
    const i = tracks.findIndex((t) => String(trackHandle(t)).toLowerCase() === ALB.focus);
    ALB.focus = '';
    const row = i >= 0 && list.querySelector(`.vrow[data-i="${i}"]`);
    if (row) {
      const sc = $('albumScroller');
      requestAnimationFrame(() => { sc.scrollTop = Math.max(0, list.offsetTop + i * ROW - sc.clientHeight / 3); row.classList.add('sel', 'flash'); setTimeout(() => row.classList.remove('flash'), 1600); });
    }
  }
}

/* «Sounds like»: albums of other artists in the library that sound closest (ml/sound-ui.js) */
async function renderSimilar(a, token) {
  const box = $('albumSimilar');
  box.innerHTML = '';
  if (!settings.soundAI) {
    box.innerHTML = `<div class="sim-head"><b>${$t('Похоже по звучанию')}</b><span>${$t('Включите анализ звука — и здесь появятся альбомы из вашей медиатеки, которые звучат похоже.')}</span><button class="btn sm" id="simOn">${$t('Анализ звука…')}</button></div>`;
    $('simOn').onclick = () => SoundUI.openSettings();
    return;
  }
  // the analysis may still be loading its records (models, database): show the row once it is ready
  if (!Sound.ready()) {
    const later = () => { if (token !== albumToken) { Sound.events.removeEventListener('change', later); return; } if (Sound.ready()) { Sound.events.removeEventListener('change', later); renderSimilar(a, token); } };
    Sound.events.addEventListener('change', later);
    return;
  }
  await idle(1500);
  if (token !== albumToken) return;
  const sim = SoundUI.similarAlbums(a, 8);
  if (!sim.length) return;
  const find = (x) => LIB.albums.find((b) => b.name === x.name && (b.albumArtist === x.albumArtist || b.artist === x.albumArtist));
  box.innerHTML = `<div class="sim-head"><b>${$t('Похоже по звучанию')}</b><span>${$t('Альбомы других исполнителей из вашей медиатеки')}</span></div><div class="sim-row"></div>`;
  const row = box.querySelector('.sim-row');
  const items = sim.map((x) => { const full = find(x); return { x, full, path: (full && full.firstTrackAbsolutePath) || x.path }; });
  for (const it of items) {
    const ph = placeholder(it.x.name, it.x.albumArtist);
    const el = h(`<button class="sim-tile"><div class="cov"><div class="ph" style="background:${ph.bg}">${esc(ph.ini)}</div><img alt=""></div><div class="tt"></div><div class="ta"></div></button>`);
    el.querySelector('.tt').textContent = it.x.name; el.querySelector('.ta').textContent = it.x.albumArtist;
    el.title = `${it.x.albumArtist} — ${it.x.name}`;
    el.onclick = () => router.go('album', it.full || { name: it.x.name, albumArtist: it.x.albumArtist, artist: it.x.albumArtist, firstTrackAbsolutePath: it.path });
    row.append(el);
  }
  const get = await coversFor(items.map((it) => it.path), Math.round(150 * dpr()));
  if (token !== albumToken) return;
  row.querySelectorAll('.sim-tile').forEach((el, i) => { const u = get(items[i].path); if (u) setImg(el.querySelector('img'), u); });
}

// ============================================================ search
let searchToken = 0;
export async function openSearch(text) {
  const q = String(text || '').trim();
  if (!q) return;
  if (router.current !== 'search') { router.go('search', q); const sb = $('searchBack'); if (sb) sb.replaceChildren(backButton('library')); }
  const token = ++searchToken;
  $('searchTitle').textContent = `«${q}»`;
  $('searchSub').textContent = $t('Ищу…');
  const words = q.toLowerCase().replace(/"/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
  const query = words.map((w) => `(%artist% HAS "${w}" OR %album% HAS "${w}" OR %title% HAS "${w}" OR %album artist% HAS "${w}")`).join(' AND ');
  const r = await call('library.search', { query, limit: 500, fields: ['title', 'artist', 'album', 'albumArtist', 'albumArtists', 'artists', 'duration', 'date', 'absolutePath', 'subsong', 'handle', 'trackNumber'] });
  if (token !== searchToken) return;
  const body = $('searchBody');
  if (!ok(r)) { body.innerHTML = `<div class="empty"><b>${$t('Поиск недоступен')}</b><span>${esc(r.error || '')}</span></div>`; $('searchSub').textContent = ''; return; }
  const tracks = r.tracks || [];
  $('searchSub').textContent = `${r.total ?? tracks.length} ${plural(r.total ?? tracks.length, 'совпадение', 'совпадения', 'совпадений')}`;
  if (!tracks.length) { body.innerHTML = `<div class="empty"><b>${$t('Ничего не найдено')}</b><span>${$t('Попробуйте другое написание')}</span></div>`; return; }
  // albums from hits
  const albums = new Map();
  for (const t of tracks) {
    if (!t.album) continue;
    const aa = (t.albumArtists && t.albumArtists[0]) || (t.artists && t.artists[0]) || t.artist || '';
    const k = t.album + '\u0001' + aa;
    if (!albums.has(k)) albums.set(k, { name: t.album, albumArtist: aa, artist: aa, year: t.date, firstTrackAbsolutePath: t.absolutePath, trackCount: 0, duration: 0 });
    const a = albums.get(k); a.trackCount++; a.duration += t.duration || 0;
  }
  // hits from parts of one release collapse into the merged album
  const seen = new Set(), alist = [];
  for (const raw of albums.values()) { const m = mergedFor(raw); const k = albumKeyOf(m.albumArtist, m.name); if (seen.has(k)) continue; seen.add(k); alist.push(m === raw ? raw : { ...m }); if (alist.length >= 18) break; }
  body.innerHTML = `
    ${alist.length ? `<div class="nav-label" style="padding:0 30px 6px">${$t('Альбомы')}</div><div class="vlist" id="searchAlbums" style="height:0"></div>` : ''}
    <div class="nav-label" style="padding:14px 30px 6px">${$t('Треки')}</div>
    <div class="list-surface" style="position:relative;height:${Math.min(tracks.length, 300) * ROW + 10}px" id="searchTracks"></div>`;
  const sa = $('searchAlbums');
  if (sa) {
    const W = $('searchScroller').clientWidth - PAD * 2, cols = Math.max(2, Math.floor((W + GAP) / 176)), tw = (W - GAP * (cols - 1)) / cols, rh = tw - 20 + tileMeta();
    sa.style.height = Math.ceil(alist.length / cols) * rh + 'px';
    alist.forEach((a, i) => {
      const ph = placeholder(a.name, a.albumArtist);
      const el = h(`<div class="tile" style="width:${tw}px;transform:translate(${PAD + (i % cols) * (tw + GAP)}px,${Math.floor(i / cols) * rh}px)"><div class="cov"><div class="ph" style="background:${ph.bg}">${esc(ph.ini)}</div><img alt=""><button class="play">${icon('play', 18)}</button></div><div class="tt"></div><div class="ta"></div></div>`);
      el.querySelector('.tt').textContent = a.name; el.querySelector('.ta').textContent = a.albumArtist;
      el.onclick = async () => {
        const full = await call('library.getAlbums', { query: a.name, limit: 50 });
        const row = ok(full) && (full.albums || []).find((x) => x.name === a.name && x.albumArtist === a.albumArtist);
        router.go('album', row || a);
      };
      el.querySelector('.play').onclick = (e) => { e.stopPropagation(); playAlbumRow(a); };
      sa.appendChild(el);
    });
    coversFor(alist.map((a) => a.firstTrackAbsolutePath), Math.min(500, Math.round(tw * dpr()))).then((get) => {
      sa.querySelectorAll('.tile').forEach((el, i) => { const u = get(alist[i].firstTrackAbsolutePath); if (u) { const img = el.querySelector('img'); setImg(img, u); img.addEventListener('load', () => el.querySelector('.ph')?.remove(), { once: true }); } });
    });
  }
  const st = $('searchTracks');
  st.innerHTML = tracks.slice(0, 300).map((t, i) => `<div class="vrow" data-i="${i}"${likeAttr(t)} style="transform:translateY(${i * ROW}px)"><div class="c-n num">${i + 1}</div><div class="c-title">${esc(t.title)}</div><div class="c-artist">${esc(t.artist)}</div><div class="c-album">${esc(t.album)}</div><div class="c-dur num">${fmtTime(t.duration)}</div>${LIKE_BTN}</div>`).join('');
  st.querySelectorAll('.vrow').forEach(likeRow);
  st.onclick = (e) => heartClick(e, (r) => tracks[+r.dataset.i]);
  st.ondblclick = (e) => { if (e.target.closest('.row-like')) return; const row = e.target.closest('.vrow'); if (row) playPaths(tracks.slice(0, 300).map((t) => t.handle || t.absolutePath), +row.dataset.i, $t('Поиск')); };
  st.oncontextmenu = (e) => { const row = e.target.closest('.vrow'); if (!row) return; e.preventDefault(); const t = tracks[+row.dataset.i]; call('menu.showNativePopup', { mode: 'handles', handles: [trackHandle(t)] }); };
}

// ============================================================ queue
export async function renderQueue() {
  const r = await call('queue.get');
  const raw = ok(r) ? (r.items || r.tracks || r.queue || []) : [];
  const items = raw.map((x) => normTrack(x) || {}).filter((t) => t.title || t.path);
  $('queueCount').textContent = items.length || '';
  if (router.current !== 'queue') return;
  $('queueSub').textContent = items.length ? `${items.length} ${plural(items.length, 'трек', 'трека', 'треков')} · ${fmtDuration(items.reduce((s, t) => s + (t.duration || 0), 0))}` : '';
  const body = $('queueBody');
  if (!items.length) { body.innerHTML = `<div class="empty"><b>${$t('Очередь пуста')}</b></div>`; body.style.height = ''; return; }
  body.style.position = 'relative'; body.style.height = items.length * ROW + 10 + 'px';
  body.innerHTML = items.map((t, i) => `<div class="vrow" style="transform:translateY(${i * ROW}px)"><div class="c-n num">${i + 1}</div><div class="c-title">${esc(t.title)}</div><div class="c-artist">${esc(t.artist)}</div><div class="c-album">${esc(t.album)}</div><div class="c-dur num">${fmtTime(t.duration)}</div></div>`).join('');
}
$('queueClear').addEventListener('click', async () => { await call('queue.clear'); renderQueue(); });
on('playback:queueChanged', debounce(renderQueue, 200));

// ============================================================ sidebar playlists
export async function renderPlaylists() {
  const r = await call('playlist.getAll');
  const list = (ok(r) && r.playlists) || [];
  const box = $('playlists');
  box.innerHTML = '';
  // «Понравившиеся» is pinned first, with a heart; shown even before the first like
  const li = list.findIndex((p) => Likes.isLikedName(p.name));
  const liked = li >= 0 ? list.splice(li, 1)[0] : null;
  {
    const el = h(`<button class="nav-item pl-item pl-liked" title="${$t('Понравившиеся')}">${icon('heart-f')}<span class="name">${$t('Понравившиеся')}</span>${liked && liked.isPlaying ? '<span class="eq"><i></i><i></i><i></i></span>' : `<b class="badge">${liked ? liked.trackCount : ''}</b>`}</button>`);
    if (liked) el.dataset.guid = liked.guid;
    if (router.current === 'playlist' && liked && PL.guid === liked.guid) el.classList.add('active');
    el.onclick = async () => {
      const g = liked ? liked.guid : await Likes.ensure();
      if (!g) return;
      call('playlist.setActive', { playlistGuid: g }); router.go('playlist', g);
    };
    if (liked) el.oncontextmenu = async (e) => { e.preventDefault(); const id = await popupMenu([{ id: 'play', label: $t('Воспроизвести') }, { id: 'shuffle', label: $t('Перемешать и играть') }], e.clientX, e.clientY); if (id === 'play') call('playlist.playTrack', { playlistGuid: liked.guid, index: 0 }); if (id === 'shuffle') shufflePlay(liked.guid, liked.trackCount); };
    box.appendChild(el);
  }
  for (const p of list) {
    const el = h(`<button class="nav-item pl-item" title="${esc(p.name)} · ${p.trackCount}">${icon(p.isAutoplaylist ? 'sparkle' : 'list')}<span class="name"></span>${p.isPlaying ? '<span class="eq"><i></i><i></i><i></i></span>' : `<b class="badge">${p.trackCount}</b>`}</button>`);
    el.querySelector('.name').textContent = p.name;
    el.dataset.guid = p.guid;
    if (router.current === 'playlist' && PL.guid === p.guid) el.classList.add('active');
    el.onclick = () => { call('playlist.setActive', { playlistGuid: p.guid }); router.go('playlist', p.guid); };
    sideDraggable(el, p.guid);
    el.oncontextmenu = async (e) => {
      e.preventDefault();
      const id = await popupMenu([{ id: 'play', label: $t('Воспроизвести') }, { id: 'rename', label: $t('Переименовать…') }, { id: 'dup', label: $t('Дублировать') }, { type: 'sep' }, { id: 'del', label: $t('Удалить') }], e.clientX, e.clientY);
      if (id === 'play') call('playlist.playTrack', { playlistGuid: p.guid, index: 0 });
      if (id === 'dup') call('playlist.duplicate', { playlistGuid: p.guid });
      if (id === 'del' && confirm($t('Удалить плейлист «{0}»?', p.name))) call('playlist.remove', { playlistGuid: p.guid });
      if (id === 'rename') inlineRename(el, p);
    };
    box.appendChild(el);
  }
}
/* drag a playlist up or down the sidebar to reorder foobar2000's playlist list */
addEventListener('gatefold:input-reset', () => { if (!sideDrag) return; sideDrag = null; document.body.classList.remove('side-dragging'); $('playlists').querySelectorAll('.pl-moving, .drop-above, .drop-below').forEach((x) => x.classList.remove('pl-moving', 'drop-above', 'drop-below')); });
let sideDrag = null;
function sideDraggable(el, guid) {
  el.addEventListener('pointerdown', (e) => { if (e.button === 0 && !e.target.closest('input')) sideDrag = { el, guid, y: e.clientY, on: false }; });
}
addEventListener('pointermove', (e) => {
  if (!sideDrag) return;
  if (!sideDrag.on) { if (Math.abs(e.clientY - sideDrag.y) < 6) return; sideDrag.on = true; sideDrag.el.classList.add('pl-moving'); document.body.classList.add('side-dragging'); }
  const items = [...$('playlists').querySelectorAll('.pl-item[data-guid]:not(.pl-liked)')];
  let before = null;
  for (const it of items) { const r = it.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { before = it; break; } }
  items.forEach((it) => it.classList.toggle('drop-above', it === before && it !== sideDrag.el));
  const last = items[items.length - 1];
  if (last) last.classList.toggle('drop-below', !before && last !== sideDrag.el);
  sideDrag.before = before ? before.dataset.guid : '';
});
addEventListener('pointerup', async () => {
  const d = sideDrag; sideDrag = null;
  if (!d || !d.on) return;
  document.body.classList.remove('side-dragging');
  $('playlists').querySelectorAll('.pl-moving, .drop-above, .drop-below').forEach((x) => x.classList.remove('pl-moving', 'drop-above', 'drop-below'));
  const swallow = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };
  d.el.addEventListener('click', swallow, true); setTimeout(() => d.el.removeEventListener('click', swallow, true), 0);
  const all = await call('playlist.getAll');
  const guids = ((ok(all) && all.playlists) || []).map((p) => p.guid);
  const from = guids.indexOf(d.guid); if (from < 0) return;
  guids.splice(from, 1);
  const to = d.before ? guids.indexOf(d.before) : guids.length;
  guids.splice(to < 0 ? guids.length : to, 0, d.guid);
  const r = await call('playlist.reorderPlaylists', { newOrderGuids: guids });
  if (!ok(r)) toast($t('foobar2000 не выполнил действие: {0}', esc(r.error || r.code || '?')));
  renderPlaylists();
});

function inlineRename(el, p) {
  const span = el.querySelector('.name');
  const inp = h(`<input class="filter" style="height:26px;width:100%" value="${esc(p.name)}">`);
  span.replaceWith(inp); inp.focus(); inp.select();
  const done = (save) => { if (save && inp.value.trim()) call('playlist.rename', { playlistGuid: p.guid, name: inp.value.trim() }); renderPlaylists(); };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  inp.onblur = () => done(true);
  inp.onclick = (e) => e.stopPropagation();
}
$('btnNewPl').addEventListener('click', async (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const id = await popupMenu([{ id: 'plain', label: $t('Новый плейлист') }, { id: 'smart', label: $t('Умный плейлист…') }], r.left, r.bottom + 4);
  if (id === 'smart') return SmartPL.open();
  if (id !== 'plain') return;
  const c = await call('playlist.create', { name: $t('Новый плейлист') });
  if (ok(c)) { await renderPlaylists(); const el = [...$('playlists').children].pop(); if (el) inlineRename(el, { guid: c.guid, name: $t('Новый плейлист') }); }
});
['playlist:created', 'playlist:removed', 'playlist:renamed', 'playlist:activated', 'playlist:reordered', 'playlist:itemsAdded', 'playlist:itemsRemoved'].forEach((ev) => on(ev, debounce(renderPlaylists, 300)));

// ============================================================ routes
router.on('playlist', (guid) => { openPlaylist(guid || PL.guid || '').then(() => setTimeout(() => jumpToPlaying(false), 50)); renderPlaylists(); });
router.on('library', (arg) => {
  // Library has two modes: albums (the grid) and folders (folders.js); a folder is a screen of its own
  if (arg && arg.folder !== undefined) { Folders.show(arg.folder, arg.focus || ''); return; }
  if ((arg && arg.tracks) || (!(arg && arg.albums) && settings.libMode === 'tracks')) { Tracks.show(arg && arg.focus); return; }
  if (!(arg && arg.albums) && settings.libMode === 'folders') { Folders.show(); return; }
  Folders.setMode(false);
  loadLibrary(false);
  if (LIB.loaded) requestAnimationFrame(layoutLib);
});
document.querySelectorAll('#view-library .lib-mode button').forEach((b) => {
  b.onclick = () => { if (b.classList.contains('on')) return; router.go('library', b.dataset.m === 'folders' ? { folder: settings.libFolder || '' } : b.dataset.m === 'tracks' ? { tracks: true } : { albums: true }); };
});
libEvents.addEventListener('changed', () => Folders.invalidate());
router.on('album', (a) => openAlbum(a));
router.on('search', () => {});
router.on('queue', () => renderQueue());
