/*
 * Gatefold · library.js — playlist (virtualised, grouped by album), library grid
 * (virtualised, lazy covers), album page (scoped palette), search, queue.
 *
 * Virtualisation keeps the DOM at ~40–80 nodes regardless of list size, so a
 * 50 000-track playlist scrolls exactly like a 50-track one.
 */
import { call, on, ok, normTrack, esc, fmtTime, fmtDuration, plural, debounce, log, sleep, artUrl, albumKeyOf } from './bridge.js';
import { settings, setSetting } from './settings.js';
import { router, onRoute, $, h, icon, toast, placeholder, popupMenu, backButton } from './ui.js';
import { idle, slot, spent } from './sched.js';
import { paletteForAlbum } from './theme.js';
import * as CF from './coverfetch.js';
import * as TC from './thumbcache.js';
import * as SORT from './sorting.js';
import * as IDB from './idb.js';
import * as Likes from './likes.js';
import { bgCall } from './sched.js';

import { $t } from './i18n.js';
import { emptyActions } from './welcome.js';
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
/** A track as the host's context-menu/handle APIs want it: path, or path|subsong:N. */
const trackHandle = (t) => t.handle || ((t.subsong ? `${t.absolutePath || t.path}|subsong:${t.subsong}` : (t.absolutePath || t.path)));
/* ---- hearts on track rows */
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
export const shared = { playing: { playlist: -1, index: -1 }, isPlaying: false, onPlayAlbum: null };

// ============================================================ cover URLs: disk thumbnail cache → fb2k:// URLs
const coverCache = new Map(); // `${path}@${size}` → fb2k url | ''
const pendingCapture = new Map(); // fb2k url → [[path, size], …]  (stored into the disk cache once it has loaded)
function takeCapture(url) { const l = pendingCapture.get(url); if (!l) return; pendingCapture.delete(url); for (const [p, S] of l) TC.capture(p, S, url); }
export async function coversFor(paths, size) {
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
export function forgetCover(path) { for (const k of coverCache.keys()) if (k.startsWith(path + '@')) coverCache.delete(k); TC.forget(path); }

function setImg(img, url, onFail) {
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
  const el = LIB.nodes.get(a.name + '\u0001' + a.albumArtist);
  const cov = el && el.querySelector('.cov');
  if (cov && !cov.querySelector('.fetching')) { const sp = h(`<span class="fetching" title="${$t('Ищу обложку')}"><span class="spinner"></span></span>`); sp.dataset.key = key; cov.appendChild(sp); }
}
CF.events.addEventListener('change', debounce(() => {
  const active = new Set([CF.state.busy && CF.state.busy.key, ...CF.state.queue.map((j) => j.key)]);
  document.querySelectorAll('.cov .fetching').forEach((sp) => { if (!active.has(sp.dataset.key)) sp.remove(); });
}, 400));

// ============================================================ playlist view
const PL = { guid: '', index: -1, name: '', total: 0, pages: new Map(), loading: new Set(), runs: [], allRuns: [], kind: null, ref: null, top: null, n: 0, height: 0, nodes: new Map(), sel: -1, token: 0, mode: 'albums', rowH: 36, cols: 1, tw: 160, th: 220 };
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
  const m = new Map(LIB.view.map((a) => [a.name + '\u0001' + a.albumArtist, a]));
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
  Object.assign(PL, { guid: pl.guid, index: pl.index, name: pl.name, total: pl.trackCount, pages: new Map(), loading: new Set(), nodes: new Map(), sel: -1 });
  plList.innerHTML = '';
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
  plScroller.scrollTop = 0;
  renderPlaylist();
  if (!pl.trackCount) {
    plList.style.height = '';
    plList.innerHTML = isLiked
      ? `<div class="empty"><b>${$t('Пока нет лайков')}</b><span>${$t('Нажмите ♡ рядом с треком в панели плеера или клавишу L')}</span></div>`
      : `<div class="empty"><b>${$t('Плейлист пуст')}</b><span>${$t('Добавьте сюда папку или файлы — или перетащите их в окно')}</span>${emptyActions({ library: false, guid: pl.guid })}</div>`;
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

async function loadPage(p) {
  if (PL.pages.has(p) || PL.loading.has(p)) return;
  PL.loading.add(p);
  const token = PL.token;
  const r = await call('playlist.getTracks', { playlistGuid: PL.guid, start: p * PAGE, count: PAGE, fields: FIELDS });
  PL.loading.delete(p);
  if (token !== PL.token || !ok(r)) return;
  PL.pages.set(p, r.tracks || []);
  schedulePl();
}
const trackAt = (t) => { const pg = PL.pages.get(Math.floor(t / PAGE)); return pg ? pg[t % PAGE] : null; };

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
        el.querySelector('.h-album').textContent = alb || first.album || $t('Без альбома');
        el.querySelector('.h-meta').textContent = [art || first.albumArtist || first.artist, (String(first.date || '').match(/\d{4}/) || [''])[0], `${run.count} ${plural(run.count, 'трек', 'трека', 'треков')}`].filter(Boolean).join(' · ');
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
          tile.querySelector('.tt').textContent = tr.title || (tr.absolutePath || '').split('\\').pop();
          tile.querySelector('.ta').textContent = tr.artist || '';
          tile.title = [tr.title, tr.artist, tr.album].filter(Boolean).join(' — ');
          tile.dataset.h = String(trackHandle(tr) || '').toLowerCase(); likeRow(tile);
          if (tr.absolutePath) coverJobs.push([tile, tr.absolutePath, Math.min(600, Math.round(PL.tw * dpr() / 50) * 50)]);
        } else if (!tr && !tile.dataset.filled) tile.querySelector('.tt').innerHTML = '<div class="skeleton" style="width:70%"></div>';
        const playing = PL.index === shared.playing.playlist && t === shared.playing.index;
        tile.classList.toggle('playing', playing);
        tile.classList.toggle('sel', t === PL.sel);
      }
    } else {
      const t = PL.ref[i];
      const tr = trackAt(t);
      const cv = PL.mode === 'covers';
      if (!tr) loadPage(Math.floor(t / PAGE));
      if (!el) {
        el = cv
          ? h('<div class="vrow wc"><div class="c-n num"></div><div class="c-title"><div class="c-cov"><img alt=""></div><div class="c-tt"><b></b><span></span></div></div><div class="c-album"></div><div class="c-dur num"></div>' + LIKE_BTN + '</div>')
          : h('<div class="vrow"><div class="c-n num"></div><div class="c-title"></div><div class="c-artist"></div><div class="c-album"></div><div class="c-dur num"></div>' + LIKE_BTN + '</div>');
        el.dataset.t = t;
        plList.appendChild(el); PL.nodes.set(key, el);
      }
      el.style.transform = `translateY(${PL.top[i]}px)`;
      if (tr && el.dataset.filled !== '1') {
        el.dataset.filled = '1';
        const c = el.children;
        const title = tr.title || (tr.absolutePath || '').split('\\').pop();
        if (cv) {
          const ph = placeholder(tr.album || title, tr.albumArtist || tr.artist);
          const box = el.querySelector('.c-cov'); box.style.background = ph.bg; box.dataset.ini = ph.ini;
          el.querySelector('.c-tt b').textContent = title;
          el.querySelector('.c-tt span').textContent = tr.artist || '';
          c[2].textContent = tr.album || '';
          c[3].textContent = tr.duration ? fmtTime(tr.duration) : '';
          if (tr.absolutePath) coverJobs.push([el, tr.absolutePath, Math.round(44 * dpr())]);
        } else {
          c[1].textContent = title;
          c[2].textContent = tr.artist;
          c[3].textContent = tr.album;
          c[4].textContent = tr.duration ? fmtTime(tr.duration) : '';
        }
        el.dataset.h = String(trackHandle(tr) || '').toLowerCase(); likeRow(el);
      } else if (!tr) { (cv ? el.querySelector('.c-tt b') : el.children[1]).innerHTML = '<div class="skeleton" style="width:60%"></div>'; }
      const playing = PL.index === shared.playing.playlist && t === shared.playing.index;
      el.classList.toggle('playing', playing);
      el.classList.toggle('sel', t === PL.sel);
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

plList.addEventListener('click', (e) => {
  if (heartClick(e, (r) => trackAt(+r.dataset.t))) return;
  const pb = e.target.closest('.vtile .play'); if (pb) { e.stopPropagation(); call('playlist.playTrack', { playlistGuid: PL.guid, index: +pb.closest('.vtile').dataset.t }); return; }
  const row = e.target.closest('.vrow, .vtile'); if (!row) return;
  PL.sel = +row.dataset.t; schedulePl();
  call('playlist.focusTrack', { playlistGuid: PL.guid, index: PL.sel });
});
plList.addEventListener('dblclick', (e) => {
  if (e.target.closest('.row-like, .play')) return;
  const row = e.target.closest('.vrow, .vtile'); if (!row) return;
  call('playlist.playTrack', { playlistGuid: PL.guid, index: +row.dataset.t });
});
plList.addEventListener('contextmenu', async (e) => {
  const row = e.target.closest('.vrow, .vtile'); if (!row) return;
  e.preventDefault();
  const t = +row.dataset.t, tr = trackAt(t);
  PL.sel = t; schedulePl();
  await call('playlist.focusTrack', { playlistGuid: PL.guid, index: t });
  // native foobar2000 context menu: Masstagger, Online Tagger, File Operations, ReplayGain, DR Meter…
  if (tr) call('menu.showNativePopup', { mode: 'handles', handles: [trackHandle(tr)] });
});
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
  PL.sel = shared.playing.index; scrollToTrack(shared.playing.index, true); schedulePl();
  setTimeout(() => plList.querySelector('.vrow.playing, .vtile.playing')?.classList.add('flash'), 450);
  setTimeout(() => plList.querySelector('.flash')?.classList.remove('flash'), 1900);
}
export function refreshPlayingRow() { schedulePl(); }

const reloadPl = debounce((d) => { if (router.current === 'playlist' && (!d || d.playlist === PL.index || d.playlistGuid === PL.guid || d.playlist === undefined)) openPlaylist(PL.guid); }, 250);
['playlist:itemsAdded', 'playlist:itemsRemoved', 'playlist:itemsReordered', 'playlist:itemsReplaced'].forEach((ev) => on(ev, reloadPl));
let plStale = false;
const refreshPlRows = () => { plStale = false; PL.pages.clear(); PL.nodes.forEach((el) => { el.dataset.filled = ''; el.dataset.ok = ''; }); schedulePl(); };
on('metadb:changed', debounce(() => { if (router.current === 'playlist') refreshPlRows(); else plStale = true; }, 1200));
onRoute((v) => { if (v === 'playlist' && plStale) refreshPlRows(); });

// ============================================================ library grid
const LIB = { albums: [], view: [], loaded: false, loading: false, stale: true, cols: 1, tileW: 180, rowH: 240, nodes: new Map() };
const libScroller = $('libScroller'), libGrid = $('libGrid');
const GAP = 8, PAD = 20;

/* Instant start: the album list is kept on disk (IndexedDB). The first time a view
   needs it in a session it is shown from that snapshot at once, and the real list
   is read from foobar a moment later in the background — the grid is redrawn only
   if something actually changed. */
const SNAP = 'library.snapshot.v3';   // v3: albums merged (see mergeAlbums)
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
const emptyLib = () => { libGrid.innerHTML = `<div class="empty"><b>${$t('Медиатека пуста')}</b><span>${$t('Подключите папку с музыкой — foobar2000 будет следить за ней сам')}</span>${emptyActions()}</div>`; libGrid.style.height = ''; };
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
  const groups = new Map();
  for (const a of rows) {
    const t = normTitle(a.name), d = releaseDir(a.firstTrackAbsolutePath);
    const k = t + '\u0001' + (d || ('~' + (String(a.year || '').match(/\d{4}/) || [''])[0]));
    let g = groups.get(k); if (!g) groups.set(k, g = []);
    g.push(a);
  }
  const out = [], index = new Map();
  for (const g0 of groups.values()) {
    // without a folder, only rows sharing an artist name belong together
    const clusters = [];
    if (releaseDir(g0[0].firstTrackAbsolutePath)) clusters.push(g0);
    else for (const a of g0) {
      const tk = artistTokens(a);
      const c = clusters.find((cl) => cl.tokens && [...tk].some((x) => cl.tokens.has(x)));
      if (c) { c.push(a); tk.forEach((x) => c.tokens.add(x)); } else { const n = [a]; n.tokens = tk; clusters.push(n); }
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
export function mergedFor(row) {
  if (!row || row.parts) return row;
  return (LIB.index && LIB.index.get(albumKeyOf(row.albumArtist, row.name))) || row;
}
const indexFrom = (albums) => { const ix = new Map(); for (const a of albums) { ix.set(albumKeyOf(a.albumArtist, a.name), a); for (const p of a.parts || []) ix.set(albumKeyOf(p.albumArtist, p.name), a); } return ix; };

/** All album rows of the media library (loads once, shared with Artists). */
export async function getAllAlbums() {
  while (LIB.loading) await sleep(80);
  if (!LIB.loaded && await fromSnapshot()) return LIB.albums;
  if (!LIB.loaded || (LIB.stale && !LIB.fromSnap)) await loadLibrary(true);
  while (LIB.loading) await sleep(80);
  return LIB.albums;
}

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
  const sig = fnv(out.length + '\u0002' + out.map((a) => `${a.name}\u0001${a.albumArtist || a.artist}\u0001${a.year || ''}\u0001${a.trackCount || 0}\u0001${a.firstTrackAbsolutePath}\u0001${a.genre || ''}`).sort().join('\u0003'));
  LIB.fromSnap = false;
  if (LIB.loaded && sig === LIB.sig) { LIB.stale = false; LIB.loading = false; layoutLib(); return; }
  const wasLoaded = LIB.loaded;
  LIB.sig = sig;
  const merged = mergeAlbums(out);
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
    if (!has && !warnedNoStats) { warnedNoStats = true; toast($t('Нет данных о добавлении/прослушивании: нужен компонент Playback Statistics (foo_playcount). Альбомы упорядочены по исполнителю.'), { ms: 7000 }); }
  }
  LIB.sorted = SORT.sortAlbums(LIB.albums, by);
  LIB.needResort = false;
}
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
  LIB.view = q ? base.filter((a) => (a.name + ' ' + a.artist + ' ' + (a.year || '') + ' ' + (a.genre || '')).toLowerCase().includes(q)) : base;
  libGrid.querySelectorAll('.tile').forEach((t) => t.remove()); LIB.nodes.clear();
  layoutLib();
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
new ResizeObserver(() => { if (router.current === 'library') layoutLib(); }).observe(libScroller);

function renderLib(re) {
  if (router.current !== 'library' || !LIB.view.length) return;
  const st = libScroller.scrollTop, vh = libScroller.clientHeight;
  const r0 = Math.max(0, Math.floor((st - 400) / LIB.rowH)), r1 = Math.ceil((st + vh + 400) / LIB.rowH);
  const keep = new Set(), want = [];
  for (let r = r0; r <= r1; r++) for (let c = 0; c < LIB.cols; c++) {
    const i = r * LIB.cols + c; if (i >= LIB.view.length) break;
    const a = LIB.view[i]; const key = a.name + '\u0001' + a.albumArtist;
    keep.add(key);
    let el = LIB.nodes.get(key);
    if (!el) {
      const ph = placeholder(a.name, a.albumArtist);
      el = h(`<div class="tile"><div class="cov"><div class="ph" style="background:${ph.bg}">${esc(ph.ini)}</div><img alt=""><button class="play" title="${$t('Слушать')}">${icon('play', 18)}</button></div><div class="tt"></div><div class="ta"></div></div>`);
      el.querySelector('.tt').textContent = a.name;
      el.querySelector('.ta').textContent = [a.artist, (String(a.year || '').match(/\d{4}/) || [''])[0]].filter(Boolean).join(' · ');
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

$('libFilter').addEventListener('input', debounce(applyFilter, 160));
$('libSort').addEventListener('change', async (e) => {
  setSetting('librarySort', e.target.value);
  if (!LIB.loaded) return loadLibrary(true);
  await sortLib(); applyFilter(); libScroller.scrollTop = 0;
});
['library:itemsAdded', 'library:itemsRemoved', 'library:itemsModified'].forEach((ev) => on(ev, debounce(() => { LIB.stale = true; if (router.current === 'library') idle(4000).then(() => loadLibrary(true)); }, ev === 'library:itemsModified' ? 6000 : 2000)));
CF.events.addEventListener('saved', (e) => {
  const p = e.detail.job.path; forgetCover(p);
  for (const a of LIB.albums) if (a.firstTrackAbsolutePath === p) {
    const el = LIB.nodes.get(a.name + '\u0001' + a.albumArtist);
    if (el) { el.querySelector('.fetching')?.remove(); const img = el.querySelector('img'); img.style.display = ''; img.onload = () => { img.classList.add('on'); el.querySelector('.ph')?.remove(); }; img.src = e.detail.url; }
  }
});

async function albumMenu(a, x, y) {
  const id = await popupMenu([
    { id: 'play', label: $t('Слушать альбом') },
    { id: 'queue', label: $t('Добавить в очередь') },
    { type: 'sep' },
    { id: 'cover', label: $t('Найти обложку…') },
    { id: 'explorer', label: $t('Показать в проводнике') },
  ], x, y);
  if (id === 'play') playAlbumRow(a);
  if (id === 'queue') queueAlbum(a);
  if (id === 'cover') router.go('covers', { manual: CF.jobFromAlbum(a) });
  if (id === 'explorer' && a.firstTrackAbsolutePath) call('shell.showInExplorer', { path: a.firstTrackAbsolutePath });
}

/** Tracks of an album, from every part of a merged one, in disc/track order. */
export async function albumTracks(a) {
  const parts = a.parts || [{ name: a.name, albumArtist: a.albumArtist }];
  const lists = await Promise.all(parts.map((p) => call('library.getAlbumTracks', { album: p.name, albumArtist: p.albumArtist })));
  const all = lists.flatMap((r) => (ok(r) ? (r.tracks || r.items || []) : []));
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
export async function playPaths(paths, start = 0, label = '') {
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
      <h1>${esc(a.name)}</h1>
      <div class="album-meta"><b class="link" id="albumArtistLink">${esc(a.artist || a.albumArtist || '')}</b> · ${a.trackCount || 0} ${plural(a.trackCount || 0, 'трек', 'трека', 'треков')} · ${fmtDuration(a.duration || 0)}${a.label ? ' · ' + esc(a.label) : ''}</div>
      <div class="album-actions">
        <button class="btn primary" id="alPlay">${icon('play')}${$t('Слушать')}</button>
        <button class="btn" id="alQueue">${icon('queue')}${$t('В очередь')}</button>
        <button class="btn" id="alCover">${icon('image')}${$t('Обложка…')}</button>
        <button class="btn" id="alFolder">${icon('folder')}${$t('Папка')}</button>
      </div>
    </div>`;
  $('albumHero').prepend(backButton('library'));
  $('alPlay').onclick = () => playAlbumRow(a);
  $('alQueue').onclick = () => queueAlbum(a);
  $('alCover').onclick = () => router.go('covers', { manual: CF.jobFromAlbum(a) });
  $('alFolder').onclick = () => call('shell.showInExplorer', { path: a.firstTrackAbsolutePath });
  $('albumArtistLink').onclick = () => router.go('artist', a.albumArtist || a.artist);
  if (a.firstTrackAbsolutePath) {
    const get = await coversFor([a.firstTrackAbsolutePath], Math.round(220 * dpr()));
    const u = get(a.firstTrackAbsolutePath);
    if (u && token === albumToken) setImg(albumView.querySelector('.album-cover img'), u);
  }
  // scoped palette: the album page previews this album's colours without re-theming the app
  paletteForAlbum(a.albumArtist, a.name, a.firstTrackAbsolutePath).then((p) => {
    if (token !== albumToken) return;
    albumView.style.setProperty('--a-accent', p.accent.css);
    albumView.style.setProperty('--a-glow', p.glow.css);
  });
  const tracks = await albumTracks(a);
  if (token !== albumToken) return;
  const list = $('albumList');
  list.style.height = tracks.length * ROW + 24 + 'px';
  let disc = -1;
  const multiDisc = new Set(tracks.map((t) => t.discNumber || 0)).size > 1;
  list.innerHTML = tracks.map((t, i) => {
    const d = multiDisc && t.discNumber !== disc ? (disc = t.discNumber, `<span class="chip" style="margin-left:6px">CD${t.discNumber}</span>`) : '';
    return `<div class="vrow" data-i="${i}"${likeAttr(t)} style="transform:translateY(${i * ROW}px)"><div class="c-n num">${t.trackNumber || i + 1}</div><div class="c-title">${esc(t.title)}${d}</div><div class="c-artist">${esc(t.artist)}</div><div class="c-album">${esc([t.codec, t.sampleRate ? (t.sampleRate / 1000).toFixed(1).replace('.0', '') + $t(' кГц') : ''].filter(Boolean).join(' · '))}</div><div class="c-dur num">${fmtTime(t.duration)}</div>${LIKE_BTN}</div>`;
  }).join('');
  list.querySelectorAll('.vrow').forEach(likeRow);
  list.onclick = (e) => heartClick(e, (r) => tracks[+r.dataset.i]);
  list.ondblclick = (e) => { if (e.target.closest('.row-like')) return; const r = e.target.closest('.vrow'); if (r) playPaths(tracks.map((t) => t.handle || t.absolutePath), +r.dataset.i, a.name); };
  list.oncontextmenu = (e) => { const r = e.target.closest('.vrow'); if (!r) return; e.preventDefault(); const t = tracks[+r.dataset.i]; call('menu.showNativePopup', { mode: 'handles', handles: [trackHandle(t)] }); };
  $('albumScroller').scrollTop = 0;
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
  if (!items.length) { body.innerHTML = `<div class="empty"><b>${$t('Очередь пуста')}</b><span>${$t('Правый клик по альбому → «Добавить в очередь»')}</span></div>`; body.style.height = ''; return; }
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
function inlineRename(el, p) {
  const span = el.querySelector('.name');
  const inp = h(`<input class="filter" style="height:26px;width:100%" value="${esc(p.name)}">`);
  span.replaceWith(inp); inp.focus(); inp.select();
  const done = (save) => { if (save && inp.value.trim()) call('playlist.rename', { playlistGuid: p.guid, name: inp.value.trim() }); renderPlaylists(); };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  inp.onblur = () => done(true);
  inp.onclick = (e) => e.stopPropagation();
}
$('btnNewPl').addEventListener('click', async () => {
  const c = await call('playlist.create', { name: $t('Новый плейлист') });
  if (ok(c)) { await renderPlaylists(); const el = [...$('playlists').children].pop(); if (el) inlineRename(el, { guid: c.guid, name: $t('Новый плейлист') }); }
});
['playlist:created', 'playlist:removed', 'playlist:renamed', 'playlist:activated', 'playlist:reordered', 'playlist:itemsAdded', 'playlist:itemsRemoved'].forEach((ev) => on(ev, debounce(renderPlaylists, 300)));

// ============================================================ routes
router.on('playlist', (guid) => { openPlaylist(guid || PL.guid || '').then(() => setTimeout(() => jumpToPlaying(false), 50)); renderPlaylists(); });
router.on('library', () => loadLibrary(false));
router.on('album', (a) => openAlbum(a));
router.on('search', () => {});
router.on('queue', () => renderQueue());
