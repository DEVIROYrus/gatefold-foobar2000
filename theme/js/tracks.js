/*
 * Gatefold · tracks.js — every song of the library in one list (Library → Tracks).
 *
 *   · one list for the whole library, however big: rows are drawn only where you look (and reused while
 *     you scroll), covers come per album from the thumbnail cache, the data is the library's one shared
 *     list (trackstore.js) — kept on disk, so the screen is there at once after a restart;
 *   · sorted by artist (then year, album, disc, track), title, album, year, genre, length, or what you
 *     played lately, played most or added last (foobar2000's play statistics) — from the menu on top or a
 *     click on a column's name (again: the other way round);
 *   · the filter of Library's header narrows it as you type: every word has to appear in the title,
 *     artist, album, genre or year;
 *   · a letter index on the right while the list is sorted by a name: a click (or a drag along it) jumps;
 *   · double click (or Enter) plays the list as it is shown, from that song: it goes into the playlist
 *     Gatefold plays in. A big list is sent in parts — first the songs from the one you chose, so music
 *     starts at once; the rest is added around it in the background, without making foobar2000 wait;
 *   · Shift/Ctrl select, Ctrl+A, arrows; the selection plays, queues, goes to a playlist (also by dragging
 *     it onto one in the sidebar), and has foobar2000's own actions one level down.
 */
import { call, ok, esc, fmtTime, fmtDuration, plural, log, on } from './bridge.js';
import { router, $, h, icon, toast, placeholder, popupMenu } from './ui.js';
import { settings, setSetting } from './settings.js';
import { bgCall } from './sched.js';
import { $t } from './i18n.js';
import * as Lib from './library.js';
import * as TS from './trackstore.js';
import * as Folders from './folders.js';

const view = $('view-library');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const lc = (s) => String(s || '').toLowerCase();
const yearOf = (d) => +(String(d || '').match(/\d{4}/) || [0])[0];
const handleOf = (t) => t.handle || (t.subsong ? `${t.absolutePath}|subsong:${t.subsong}` : t.absolutePath);
const artistOf = (t) => t.albumArtist || t.artist || '';
/** when a list is long enough to be sent to the playlist in parts (tests make it small) */
export const CFG = { chunk: 3000, first: 1000, step: 2500 };

const T = {
  all: [], gen: -1,
  keys: null,            // per track: what the sorts and the filter compare (built once per list)
  order: new Map(),      // sort id → indices of `all` in that order
  rows: [],              // indices of `all` shown, in order
  sort: 'artist', dir: 1, q: '',
  sel: new Set(), anchor: -1, cursor: -1,
  nodes: new Map(), token: 0, built: false, loading: false,
  covers: new Map(),     // cover path → url ('' = none)
  stats: { added: null, played: null, plays: null },
};

/* ---------------------------------------------------------------- the screen */
let root = null, bar, headEl, sc, list, rail, bubble, selBar;
function build() {
  if (root) return;
  root = h(`<div class="tr" id="trackView">
    <div class="tr-bar"></div>
    <div class="list-head tr-head"></div>
    <div class="scroller list-surface tr-scroller"><div class="vlist tr-list" role="listbox" aria-multiselectable="true" tabindex="0"></div></div>
    <div class="tr-rail" hidden></div><div class="tr-bubble" hidden></div>
  </div>`);
  view.append(root);
  bar = root.querySelector('.tr-bar'); headEl = root.querySelector('.tr-head'); sc = root.querySelector('.tr-scroller');
  list = root.querySelector('.tr-list'); rail = root.querySelector('.tr-rail'); bubble = root.querySelector('.tr-bubble');
  wire();
}
export const active = () => router.current === 'library' && view.classList.contains('tracks');
const rowH = () => Lib.rowMetrics().rowc - 4;

/** Library → Tracks (`focus`: a track's handle to show and mark) */
export async function show(focus = '') {
  build();
  Folders.setLibMode('tracks');
  T.sort = SORTS.some((s) => s.id === settings.tracksSort) ? settings.tracksSort : 'artist';
  T.dir = settings.tracksDir === -1 ? -1 : 1;
  T.q = $('libFilter').value.trim();
  const tk = ++T.token;
  if (!T.all.length) {
    const snap = await TS.peek();                    // the last list, from disk: the screen is there at once
    if (tk !== T.token) return;
    if (snap && snap.length) setData(snap);
    else paintLoading();
  }
  if (T.all.length) refresh();
  // the albums are known now: each row takes its album's cover (in place — a redrawn row would swallow a double click)
  Lib.getAllAlbums().then(() => { if (!active()) return; T.coverPath = null; for (const el of T.nodes.values()) setCover(el); if (wantCovers.size) loadCovers(); }).catch(() => {});
  if (!TS.fresh()) {
    T.loading = true; paintBar();
    const data = await TS.all();
    T.loading = false;
    if (tk !== T.token || !active()) return;
    setData(data); refresh(true);
  } else if (TS.generation() !== T.gen) { setData(await TS.all()); refresh(true); }
  TS.keep();
  if (focus) reveal(focus);
}
/** the shared list changed (the library did): a quiet refresh when this screen is open */
TS.events.addEventListener('change', () => { if (active() && TS.generation() !== T.gen) TS.all().then((d) => { setData(d); refresh(true); }); });

function setData(data) {
  const keepSel = new Set([...T.sel].map((i) => lc(handleOf(T.all[i]))));
  T.all = data; T.gen = TS.generation(); T.keys = null; T.order.clear(); T.coverPath = null; T.stats = { added: null, played: null, plays: null };
  T.sel = new Set();
  if (keepSel.size) data.forEach((t, i) => { if (keepSel.has(lc(handleOf(t)))) T.sel.add(i); });
}
/* what sorting and filtering compare, built once per list: 30 000 songs in a few milliseconds */
function keys() {
  if (T.keys) return T.keys;
  const n = T.all.length, K = { art: new Array(n), alb: new Array(n), tit: new Array(n), gen: new Array(n), year: new Int32Array(n), disc: new Int32Array(n), trk: new Int32Array(n), dur: new Float64Array(n), find: new Array(n) };
  T.all.forEach((t, i) => {
    K.art[i] = artistOf(t); K.alb[i] = t.album || ''; K.tit[i] = t.title || String(t.absolutePath || '').split('\\').pop(); K.gen[i] = t.genre || '';
    K.year[i] = yearOf(t.date); K.disc[i] = t.discNumber || 1; K.trk[i] = t.trackNumber || 0; K.dur[i] = t.duration || 0;
    K.find[i] = null;                                  // the filter's text, made when first needed
  });
  return (T.keys = K);
}
const findText = (i) => { const K = keys(); return K.find[i] ??= lc(`${K.tit[i]} ${T.all[i].artist || ''} ${K.art[i]} ${K.alb[i]} ${K.gen[i]} ${K.year[i] || ''}`); };

/* ---------------------------------------------------------------- sorting */
const SORTS = [
  { id: 'artist', label: () => $t('По исполнителю') }, { id: 'title', label: () => $t('По названию') }, { id: 'album', label: () => $t('По альбому') },
  { id: 'year', label: () => $t('По году') }, { id: 'genre', label: () => $t('По жанру') }, { id: 'duration', label: () => $t('По длительности') },
  { id: 'added', label: () => $t('Недавно добавленные'), stat: '%added%' }, { id: 'played', label: () => $t('Недавно проигранные'), stat: '%last_played%' },
  { id: 'plays', label: () => $t('Часто слушаемые'), stat: '%play_count%' },
];
const TEXT = { artist: 'art', title: 'tit', album: 'alb', genre: 'gen' };
/* foobar2000's play statistics (foo_playcount): the order comes from foobar2000 itself, one query */
let warnedStats = false;
async function statOrder(id) {
  if (T.stats[id]) return T.stats[id];
  // only the songs that have the statistic, oldest (least) first; the newest (most) gets rank 0
  const [query, sort] = { added: ['%added% PRESENT', '%added%'], played: ['%last_played% PRESENT', '%last_played%'], plays: ['%play_count% GREATER 0', '$num(%play_count%,9)'] }[id];
  const r = await bgCall('library.query', { query, sort, limit: 1000000, fields: ['handle'] }, 'normal');
  const rank = new Map(), L = (ok(r) && r.tracks) || [];
  L.forEach((t, i) => rank.set(lc(t.handle), L.length - 1 - i));
  if (!rank.size && !warnedStats) { warnedStats = true; toast($t('Нужен foo_playcount'), { ms: 7000 }); }
  return (T.stats[id] = rank);
}
async function orderFor(id, dir) {
  const key = id + ':' + dir;
  if (T.order.has(key)) return T.order.get(key);
  const K = keys(), n = T.all.length;
  const idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
  const album = (a, b) => K.year[a] - K.year[b] || collator.compare(K.alb[a], K.alb[b]) || K.disc[a] - K.disc[b] || K.trk[a] - K.trk[b] || collator.compare(K.tit[a], K.tit[b]);
  let cmp;
  if (id === 'artist') cmp = (a, b) => collator.compare(K.art[a], K.art[b]) * dir || album(a, b);
  else if (id === 'title') cmp = (a, b) => collator.compare(K.tit[a], K.tit[b]) * dir || collator.compare(K.art[a], K.art[b]);
  else if (id === 'album') cmp = (a, b) => collator.compare(K.alb[a], K.alb[b]) * dir || collator.compare(K.art[a], K.art[b]) || K.disc[a] - K.disc[b] || K.trk[a] - K.trk[b];
  else if (id === 'genre') cmp = (a, b) => (!K.gen[a] - !K.gen[b]) || collator.compare(K.gen[a], K.gen[b]) * dir || collator.compare(K.art[a], K.art[b]) || album(a, b);
  else if (id === 'year') cmp = (a, b) => (!K.year[a] - !K.year[b]) || (K.year[b] - K.year[a]) * dir || collator.compare(K.art[a], K.art[b]) || album(a, b);
  else if (id === 'duration') cmp = (a, b) => (K.dur[b] - K.dur[a]) * dir || collator.compare(K.tit[a], K.tit[b]);
  else {
    const rank = await statOrder(id), R = new Float64Array(n);
    for (let i = 0; i < n; i++) { const v = rank.get(lc(handleOf(T.all[i]))); R[i] = v === undefined ? Infinity : v; }
    cmp = (a, b) => (R[a] - R[b]) * dir || collator.compare(K.art[a], K.art[b]) || album(a, b);
    if (dir < 0) cmp = (a, b) => (R[a] === Infinity) - (R[b] === Infinity) || (R[b] - R[a]) || collator.compare(K.art[a], K.art[b]) || album(a, b);
  }
  const t0 = performance.now();
  const out = Array.from(idx).sort(cmp);
  if (performance.now() - t0 > 60) log('tracks: sorted', n, 'by', id, 'in', Math.round(performance.now() - t0), 'ms');
  T.order.set(key, out);
  return out;
}
async function refresh(keepScroll = false) {
  const tk = ++T.token;
  const order = await orderFor(T.sort, T.dir);
  if (tk !== T.token) return;
  const words = lc(T.q).split(/\s+/).filter(Boolean);
  T.rows = words.length ? order.filter((i) => { const s = findText(i); return words.every((w) => s.includes(w)); }) : order;
  T.built = true;
  const top = keepScroll ? sc.scrollTop : 0;
  paintBar(); paintHead(); paintList(); paintRail();
  sc.scrollTop = top;
  paintRows(true);
  updateSelBar();
}
export function filter(q) { T.q = q.trim(); if (T.all.length) { T.cursor = -1; refresh(); } }
async function sortBy(id, dir) {
  if (id === T.sort && dir === T.dir) return;
  T.sort = id; T.dir = dir;
  setSetting('tracksSort', id); setSetting('tracksDir', dir);
  if (SORTS.find((s) => s.id === id)?.stat && !T.stats[id]) { headEl.classList.add('busy'); }
  await refresh();
  headEl.classList.remove('busy');
}

/* ---------------------------------------------------------------- the bar, the header */
function paintLoading() {
  bar.innerHTML = `<div class="fd-loading"><span class="spinner"></span>${$t('Читаю медиатеку…')}</div>`;
  headEl.innerHTML = ''; list.innerHTML = ''; list.style.height = '0px'; rail.hidden = true;
  for (let i = 0; i < 9; i++) list.insertAdjacentHTML('beforeend', `<div class="vrow wc tr-row skel" style="transform:translateY(${i * rowH()}px);opacity:${(1 - i / 10).toFixed(2)}"><div></div><div class="c-title"><div class="c-cov"></div><div class="c-tt"><div class="skeleton" style="width:${40 + (i * 13) % 35}%"></div><div class="skeleton" style="width:${20 + (i * 7) % 25}%"></div></div></div></div>`);
  $('libSub').textContent = '';
}
function paintBar() {
  if (!bar) return;
  const n = T.rows.length;
  const dur = T.rows.length < 200000 ? T.rows.reduce((s, i) => s + (T.all[i].duration || 0), 0) : 0;
  $('libSub').textContent = T.built ? `${n.toLocaleString()} ${plural(n, 'трек', 'трека', 'треков')}${dur ? ' · ' + fmtDuration(dur) : ''}${T.q && n !== T.all.length ? ' ' + $t('из {0}', T.all.length.toLocaleString()) : ''}` : '';
  bar.innerHTML = `
    <button class="btn primary sm" data-act="play"${n ? '' : ' disabled'}>${icon('play', 14)}${$t('Слушать')}</button>
    <button class="btn sm" data-act="shuffle"${n ? '' : ' disabled'}>${icon('shuffle', 14)}${$t('Вперемешку')}</button>
    <span class="tr-gap"></span>
    ${T.loading ? `<span class="tr-sync" title="${$t('Обновляю список…')}"><span class="spinner"></span></span>` : ''}
    <select class="select tr-sort" aria-label="${$t('Сортировка')}">${SORTS.map((s) => `<option value="${s.id}"${s.id === T.sort ? ' selected' : ''}>${s.label()}</option>`).join('')}</select>
    <button class="icon-btn tr-dir" data-act="dir" title="${T.dir > 0 ? $t('Обратный порядок') : $t('Прямой порядок')}" aria-label="${$t('Обратный порядок')}">${icon(T.dir > 0 ? 'sort-down' : 'sort-up', 16)}</button>
    <button class="icon-btn" data-act="more" title="${$t('Ещё')}" aria-haspopup="menu">${icon('more', 16)}</button>`;
  bar.querySelector('[data-act=play]').onclick = () => playRows(0);
  bar.querySelector('[data-act=shuffle]').onclick = () => playRows(0, true);
  bar.querySelector('[data-act=dir]').onclick = () => sortBy(T.sort, -T.dir);
  bar.querySelector('.tr-sort').onchange = (e) => sortBy(e.target.value, 1);
  bar.querySelector('[data-act=more]').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); listMenu(r.right - 240, r.bottom + 4); };
}
const COLS = [
  { id: 'n', label: '#' }, { id: 'title', label: () => $t('Название'), sort: 'title' }, { id: 'album', label: () => $t('Альбом'), sort: 'album' },
  { id: 'year', label: () => $t('Год'), sort: 'year' }, { id: 'genre', label: () => $t('Жанр'), sort: 'genre' }, { id: 'gap' }, { id: 'dur', label: () => $t('Время'), sort: 'duration' },
];
function paintHead() {
  headEl.innerHTML = COLS.map((c) => {
    if (!c.label) return `<div class="h-${c.id}"></div>`;
    const lab = typeof c.label === 'function' ? c.label() : c.label;
    if (!c.sort) return `<div class="h-${c.id}">${lab}</div>`;
    const on = T.sort === c.sort;
    return `<button class="h-${c.id} tr-hs${on ? ' on' : ''}" data-sort="${c.sort}" title="${$t('Сортировать')}">${lab}${on ? icon(T.dir > 0 ? 'sort-down' : 'sort-up', 12) : ''}</button>`;
  }).join('');
}

/* ---------------------------------------------------------------- the rows */
function paintList() {
  for (const el of T.nodes.values()) el.remove();
  T.nodes.clear(); list.innerHTML = '';
  if (!T.rows.length) {
    list.style.height = '';
    list.innerHTML = `<div class="empty tr-empty">${T.all.length ? `<b>${$t('Ничего не нашлось')}</b><span>${$t('Каждое слово ищется в названии, исполнителе, альбоме, жанре и годе')}</span>` : `<b>${$t('Медиатека пуста')}</b>`}</div>`;
    return;
  }
  list.style.height = T.rows.length * rowH() + 24 + 'px';
}
/* the album cover a row shows: its album's (one thumbnail for all its songs) */
function coverPathOf(i) {
  if (!T.coverPath) T.coverPath = new Array(T.all.length);
  let p = T.coverPath[i];
  if (p !== undefined) return p;
  const t = T.all[i];
  const a = Lib.albumOfTrack({ handle: t.handle, path: t.absolutePath, album: t.album, albumArtist: artistOf(t), artist: t.artist });
  p = (a && a.firstTrackAbsolutePath) || t.absolutePath || '';
  T.coverPath[i] = p;
  return p;
}
let rowRaf = 0, coverT = 0, goT = 0;
const wantCovers = new Set();
function rowHtml(r, i, H) {
  const t = T.all[i], K = keys();
  const ph = placeholder(K.alb[i] || K.tit[i], K.art[i]);
  const words = lc(T.q).split(/\s+/).filter((w) => w.length > 1);
  const mark = (s) => { let x = esc(s); if (!words.length) return x; for (const w of words) x = x.replace(new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>'); return x; };
  return `<div class="vrow wc tr-row" role="option" data-r="${r}" data-i="${i}"${Lib.rowKit.likeAttr(t)} style="transform:translateY(${r * H}px)">`
    + `<div class="c-n num"></div>`
    + `<div class="c-title"><div class="c-cov" style="background:${ph.bg}" data-ini="${esc(ph.ini)}"><img alt=""></div><div class="c-tt"><b>${mark(K.tit[i])}</b><span>${t.artist ? Lib.artistLinks(t.artist) : ''}</span></div></div>`
    + `<div class="c-album">${t.album ? `<span class="lnk" data-go="album">${mark(t.album)}</span>` : ''}</div>`
    + `<div class="c-year num">${K.year[i] || ''}</div>`
    + `<div class="c-genre">${t.genre ? `<span class="lnk" data-go="genre">${mark(t.genre)}</span>` : ''}</div>`
    + `<div class="c-gap"></div><div class="c-dur num">${t.duration ? fmtTime(t.duration) : ''}</div>${Lib.rowKit.LIKE_BTN}</div>`;
}
function paintRows(force) {
  if (!T.rows.length || !list) return;
  const H = rowH(), top = sc.scrollTop, vh = sc.clientHeight || 800;
  const a = Math.max(0, Math.floor((top - 400) / H)), b = Math.min(T.rows.length, Math.ceil((top + vh + 400) / H));
  if (force) { for (const el of T.nodes.values()) el.remove(); T.nodes.clear(); }
  for (const [r, el] of T.nodes) if (r < a || r >= b) { el.remove(); T.nodes.delete(r); }
  const now = lc(Lib.shared.nowHandle || '');
  let html = '';
  const fresh = [];
  for (let r = a; r < b; r++) if (!T.nodes.has(r)) { html += rowHtml(r, T.rows[r], H); fresh.push(r); }
  if (html) {
    const tpl = document.createElement('template'); tpl.innerHTML = html;
    for (const el of [...tpl.content.children]) { const r = +el.dataset.r; T.nodes.set(r, el); list.append(el); Lib.rowKit.likeRow(el); setCover(el); }
  }
  for (const [r, el] of T.nodes) {
    const i = T.rows[r];
    const playing = now && lc(handleOf(T.all[i])) === now;
    el.classList.toggle('playing', !!playing);
    el.classList.toggle('sel', T.sel.has(i));
    el.classList.toggle('cur', r === T.cursor);
    el.setAttribute('aria-selected', String(T.sel.has(i)));
    const n = el.firstElementChild;
    const want = playing ? 'eq' : String(r + 1);
    if (n.dataset.v !== want) { n.dataset.v = want; n.innerHTML = playing ? '<span class="eq"><i></i><i></i><i></i></span>' : String(r + 1); }
  }
  if (wantCovers.size) { clearTimeout(coverT); coverT = setTimeout(loadCovers, 40); }
}
function setCover(el) {
  const p = coverPathOf(+el.dataset.i);
  if (el.dataset.cp === p && el.querySelector('.c-cov img.on')) return;
  el.dataset.cp = p;
  if (!p) return;
  const u = T.covers.get(p);
  if (u === undefined) { wantCovers.add(p); return; }
  if (u) showImg(el, u);
}
function showImg(el, u) {
  const img = el.querySelector('.c-cov img');
  if (!img || img.getAttribute('src') === u) return;
  img.onload = () => { if (img.naturalWidth > 1) { img.classList.add('on'); Lib.coverLoaded(u); } };
  img.src = u;
}
async function loadCovers() {
  const paths = [...wantCovers]; wantCovers.clear();
  if (!paths.length) return;
  const get = await Lib.coversFor(paths, Math.round(48 * Math.min(2, devicePixelRatio || 1)));
  for (const p of paths) T.covers.set(p, get(p) || '');
  for (const el of T.nodes.values()) { const u = T.covers.get(el.dataset.cp); if (u) showImg(el, u); }
}

/* ---------------------------------------------------------------- the letter index */
function letterOf(s) {
  const c = String(s || '').trim().replace(/^(the|a)\s+/i, '').charAt(0).toUpperCase();
  return /\p{L}/u.test(c) ? c : '#';
}
let marks = [];
function paintRail() {
  const field = TEXT[T.sort];
  marks = [];
  if (field && T.rows.length > 40) {
    const K = keys();
    let last = null;
    T.rows.forEach((i, r) => { const L = letterOf(K[field][i]); if (L !== last) { marks.push([L, r]); last = L; } });
  }
  if (marks.length < 4) { rail.hidden = true; root.classList.remove('with-rail'); return; }
  // a long alphabet (Latin and Cyrillic) is thinned out to fit; every letter stays reachable by dragging
  const max = Math.max(8, Math.floor((sc.clientHeight - 24) / 15));
  const step = Math.ceil(marks.length / max);
  rail.innerHTML = marks.filter((_, k) => k % step === 0 || k === marks.length - 1).map(([L, r]) => `<button data-r="${r}" tabindex="-1">${esc(L)}</button>`).join('');
  rail.hidden = false; root.classList.add('with-rail');
}
function letterAt(r) { let L = ''; for (const [x, at] of marks) { if (at > r) break; L = x; } return L; }
function jumpRail(e) {
  const rr = rail.getBoundingClientRect();
  const k = Math.max(0, Math.min(marks.length - 1, Math.floor(((e.clientY - rr.top) / rr.height) * marks.length)));
  const [L, r] = marks[k];
  sc.scrollTop = r * rowH();
  flashBubble(L);
}
let bubT = 0;
function flashBubble(L) {
  if (!L) return;
  bubble.textContent = L; bubble.hidden = false; bubble.classList.add('on');
  clearTimeout(bubT); bubT = setTimeout(() => { bubble.classList.remove('on'); }, 650);
}

/* ---------------------------------------------------------------- selection and actions */
const rowsSel = () => T.rows.filter((i) => T.sel.has(i));
function select(r, e) {
  const i = T.rows[r];
  if (e && e.shiftKey && T.anchor >= 0) {
    const a0 = T.rows.indexOf(T.anchor); const x = Math.min(a0 < 0 ? r : a0, r), y = Math.max(a0 < 0 ? r : a0, r);
    if (!e.ctrlKey) T.sel = new Set();
    for (let k = x; k <= y; k++) T.sel.add(T.rows[k]);
  } else if (e && (e.ctrlKey || e.metaKey)) { if (T.sel.has(i)) T.sel.delete(i); else T.sel.add(i); T.anchor = i; }
  else { T.sel = new Set([i]); T.anchor = i; }
  T.cursor = r;
  paintRows(false); updateSelBar();
}
function updateSelBar() {
  const n = T.sel.size;
  if (!selBar) {
    selBar = h(`<div class="pl-selbar tr-selbar" hidden><span class="n"></span><span class="gap"></span>
      <button class="btn sm" data-sb="play">${icon('play')}${$t('Слушать')}</button>
      <button class="btn sm" data-sb="queue">${icon('queue')}${$t('В очередь')}</button>
      <button class="btn sm" data-sb="to">${icon('plus')}${$t('В плейлист')}</button>
      <button class="icon-btn" data-sb="x" title="${$t('Снять выделение (Esc)')}">${icon('x', 16)}</button></div>`);
    root.append(selBar);
    selBar.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-sb]'); if (!b) return;
      const act = b.dataset.sb;
      if (act === 'play') playSelection();
      if (act === 'queue') queueSel();
      if (act === 'to') { const r = b.getBoundingClientRect(); toPlaylistMenu(r.left, r.top - 8, true); }
      if (act === 'x') clearSel();
    });
  }
  selBar.hidden = n < 2;
  selBar.querySelector('.n').textContent = $t('Выбрано: {0}', n.toLocaleString());
}
function clearSel() { if (!T.sel.size) return false; T.sel = new Set(); T.anchor = -1; paintRows(false); updateSelBar(); return true; }
const handlesOf = (idx) => idx.map((i) => handleOf(T.all[i]));
async function queueSel(idx = rowsSel()) {
  const paths = handlesOf(idx); if (!paths.length) return;
  const r = await call('queue.addPaths', { paths });
  toast(ok(r) ? $t('В очереди: {0}', `${paths.length} ${plural(paths.length, 'трек', 'трека', 'треков')}`) : $t('Очередь недоступна: ') + esc(r.error || ''));
}
async function addTo(guid, name, idx) {
  const handles = handlesOf(idx); if (!handles.length) return;
  if (!guid) { const c = await call('playlist.create', { name: name || $t('Новый плейлист') }); if (!ok(c)) { toast(esc(c.error || '')); return; } guid = c.guid; name = name || $t('Новый плейлист'); }
  let r = null;
  for (let k = 0; k < handles.length; k += 5000) { r = await call('playlist.addHandles', { playlistGuid: guid, handles: handles.slice(k, k + 5000) }); if (!ok(r)) break; }
  toast(r && ok(r) ? $t('Добавлено в «{0}»: {1} {2}', esc(name), handles.length.toLocaleString(), plural(handles.length, 'трек', 'трека', 'треков')) : $t('Ошибка добавления: ') + esc((r && r.error) || ''));
}
async function toPlaylistMenu(x, y, sel) {
  const id = await popupMenu(await Lib.playlistTargets(), x, y);
  if (!id) return;
  const idx = sel ? rowsSel() : T.rows;
  if (id === 'new') return addTo('', T.q ? T.q : $t('Новый плейлист'), idx);
  const [guid, name] = id.slice(3).split('\u0001');
  addTo(guid, name, idx);
}
async function listMenu(x, y) {
  const n = T.rows.length;
  const id = await popupMenu([
    { id: 'queue', label: $t('Всё в очередь ({0})', n.toLocaleString()), disabled: !n },
    { id: 'to', label: $t('Всё в плейлист'), children: await Lib.playlistTargets(), disabled: !n },
  ], x, y);
  if (id === 'queue') queueSel(T.rows);
  else if (id && (id === 'new' || id.startsWith('pl:'))) { if (id === 'new') addTo('', T.q || $t('Треки'), T.rows); else { const [g, nm] = id.slice(3).split('\u0001'); addTo(g, nm, T.rows); } }
}
async function rowMenu(r, x, y) {
  const i = T.rows[r];
  if (!T.sel.has(i)) { T.sel = new Set([i]); T.anchor = i; T.cursor = r; paintRows(false); updateSelBar(); }
  const n = T.sel.size, t = T.all[i];
  const id = await popupMenu([
    { id: 'play', label: n > 1 ? $t('Слушать выбранные ({0})', n) : $t('Воспроизвести') },
    { id: 'queue', label: n > 1 ? $t('Добавить в очередь ({0})', n) : $t('Добавить в очередь') },
    { id: 'to', label: $t('Добавить в плейлист'), children: await Lib.playlistTargets() },
    { type: 'sep' },
    { id: 'album', label: $t('Открыть альбом'), disabled: !t.album },
    { id: 'artist', label: $t('Исполнитель: {0}', artistOf(t)), disabled: !artistOf(t) },
    { id: 'folder', label: $t('Показать в папке') },
    { type: 'sep' },
    { id: 'native', label: $t('Действия foobar2000…') },
  ], x, y);
  if (!id) return;
  if (id === 'play') { if (n > 1) playSelection(); else playRows(r); }
  else if (id === 'queue') queueSel();
  else if (id === 'new' || id.startsWith('pl:')) { if (id === 'new') addTo('', $t('Новый плейлист'), rowsSel()); else { const [g, nm] = id.slice(3).split('\u0001'); addTo(g, nm, rowsSel()); } }
  else if (id === 'album') openAlbum(i);
  else if (id === 'artist') router.go('artist', artistOf(t));
  else if (id === 'folder') Folders.reveal(t.absolutePath);
  else if (id === 'native') call('menu.showNativePopup', { mode: 'handles', handles: handlesOf(rowsSel()) });
}
function openAlbum(i) {
  const t = T.all[i];
  const a = Lib.albumOfTrack({ handle: t.handle, path: t.absolutePath, album: t.album, albumArtist: artistOf(t), artist: t.artist });
  if (!a || !a.name) return;
  Lib.focusNextAlbumTrack(handleOf(t));
  router.go('album', a);
}

/* ---------------------------------------------------------------- playing: the list as shown, from a song */
const label = () => (T.q ? `«${T.q}»` : $t('Треки'));
function playSelection() { const idx = rowsSel(); if (idx.length) playList(handlesOf(idx), 0); }
function playRows(r, shuffle = false) {
  let paths = handlesOf(T.rows);
  if (!paths.length) return;
  if (shuffle) { paths = paths.slice(); for (let k = paths.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [paths[k], paths[j]] = [paths[j], paths[k]]; } r = 0; }
  playList(paths, r);
}
async function playList(paths, start) {
  if (paths.length <= CFG.chunk) return Lib.playPaths(paths, start, label());
  // a big list: the songs from the chosen one go first and music starts at once; the rest is added
  // around them in parts, in the background (each part is a short task for foobar2000, never a long one)
  await Lib.playPaths(paths.slice(start, start + CFG.first), 0, label());
  const gen = Lib.shared.playGen, guid = await Lib.playTarget();
  const still = () => Lib.shared.playGen === gen;
  for (let k = start + CFG.first; k < paths.length && still(); k += CFG.step) {
    const r = await bgCall('library.addToPlaylist', { paths: paths.slice(k, k + CFG.step), playlistGuid: guid }, 'normal');
    if (!ok(r)) return log('tracks: adding the rest failed', r.error);
  }
  for (let end = start; end > 0 && still(); end -= CFG.step) {
    const r = await bgCall('playlist.insertTracks', { playlistGuid: guid, position: 0, handles: paths.slice(Math.max(0, end - CFG.step), end) }, 'normal');
    if (!ok(r)) return log('tracks: adding the beginning failed', r.error);
  }
}

/* ---------------------------------------------------------------- input */
function wire() {
  sc.addEventListener('scroll', () => {
    if (!rowRaf) rowRaf = requestAnimationFrame(() => { rowRaf = 0; paintRows(false); });
    if (marks.length >= 4 && !rail.hidden) flashBubble(letterAt(Math.floor((sc.scrollTop + sc.clientHeight / 3) / rowH())));
  }, { passive: true });
  new ResizeObserver(() => { if (active() && T.built) { paintRows(false); paintRail(); } }).observe(sc);
  headEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]'); if (!b) return;
    const id = b.dataset.sort;
    sortBy(id, id === T.sort ? -T.dir : 1);
  });
  rail.addEventListener('pointerdown', (e) => { e.preventDefault(); rail.setPointerCapture(e.pointerId); rail.classList.add('drag'); jumpRail(e); });
  rail.addEventListener('pointermove', (e) => { if (rail.hasPointerCapture(e.pointerId)) jumpRail(e); });
  rail.addEventListener('pointerup', (e) => { rail.classList.remove('drag'); try { rail.releasePointerCapture(e.pointerId); } catch {} });
  list.addEventListener('click', (e) => {
    const el = e.target.closest('.vrow'); if (!el || drag.ended) return;
    const r = +el.dataset.r, i = +el.dataset.i, t = T.all[i];
    if (Lib.rowKit.heartClick(e, () => t)) return;
    clearTimeout(goT);
    if (e.detail === 2 && !e.shiftKey && !e.ctrlKey) { playRows(r); return; }      // a double click plays (even on a link)
    const lk = e.target.closest('.lnk');
    if (lk && !e.shiftKey && !e.ctrlKey && e.detail === 1) {
      // a link waits a moment: the first click of a double click lands on it too
      const go = lk.dataset.go, text = lk.textContent;
      goT = setTimeout(() => {
        if (go === 'artist') router.go('artist', text);
        else if (go === 'album') openAlbum(i);
        else if (go === 'genre') { $('libFilter').value = t.genre; filter(t.genre); }
      }, 280);
    }
    select(r, e);
  });
  list.addEventListener('contextmenu', (e) => { const el = e.target.closest('.vrow'); if (!el) return; e.preventDefault(); rowMenu(+el.dataset.r, e.clientX, e.clientY); });
  // drag the selection onto a playlist in the sidebar
  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.lnk, .row-like')) return;
    const el = e.target.closest('.vrow'); if (!el) return;
    drag.start = { x: e.clientX, y: e.clientY, r: +el.dataset.r };
  });
}
const drag = { start: null, on: false, ghost: null, hl: null, ended: false };
addEventListener('pointermove', (e) => {
  const d = drag.start; if (!d) return;
  if (!drag.on) {
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 7) return;
    const i = T.rows[d.r]; if (!T.sel.has(i)) { T.sel = new Set([i]); T.anchor = i; paintRows(false); updateSelBar(); }
    drag.on = true; document.body.classList.add('pl-dragging');
    const n = T.sel.size;
    drag.ghost = h(`<div class="drag-ghost">${icon('music', 14)}<span></span></div>`);
    drag.ghost.querySelector('span').textContent = n > 1 ? `${n.toLocaleString()} ${plural(n, 'трек', 'трека', 'треков')}` : keys().tit[i];
    document.body.append(drag.ghost);
  }
  drag.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`;
  const side = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pl-item[data-guid]');
  if (drag.hl && drag.hl !== side) drag.hl.classList.remove('drop-hl');
  drag.hl = side || null; if (side) side.classList.add('drop-hl');
  drag.ghost.classList.toggle('copy', !!side);
});
addEventListener('pointerup', () => {
  const was = drag.on, tg = drag.hl;
  drag.start = null;
  if (!was) return;
  drag.on = false; drag.ghost?.remove(); drag.ghost = null; drag.hl?.classList.remove('drop-hl'); drag.hl = null;
  document.body.classList.remove('pl-dragging');
  drag.ended = true; setTimeout(() => { drag.ended = false; }, 0);
  if (tg) addTo(tg.dataset.guid, tg.querySelector('.name')?.textContent || '', rowsSel());
});
addEventListener('gatefold:input-reset', () => { if (drag.on) { drag.on = false; drag.ghost?.remove(); drag.hl?.classList.remove('drop-hl'); document.body.classList.remove('pl-dragging'); } drag.start = null; });

/* keys while the list is on screen: arrows (Shift extends), Home/End, Enter plays, Ctrl+A, Esc */
document.addEventListener('keydown', (e) => {
  if (!active() || !T.rows.length || (e.target.closest && e.target.closest('input, textarea, select, .menu'))) return;
  const k = e.key, H = rowH(), page = Math.max(1, Math.floor(sc.clientHeight / H) - 1);
  const move = (to) => {
    to = Math.max(0, Math.min(T.rows.length - 1, to));
    if (e.shiftKey) { const i = T.rows[to]; if (T.anchor < 0) T.anchor = T.rows[Math.max(0, T.cursor)]; select(to, { shiftKey: true }); T.sel.add(i); }
    else select(to, null);
    const y = to * H;
    if (y < sc.scrollTop) sc.scrollTop = y; else if (y + H > sc.scrollTop + sc.clientHeight) sc.scrollTop = y + H - sc.clientHeight;
  };
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (k === 'ArrowDown') { stop(); move(T.cursor + 1); }
  else if (k === 'ArrowUp') { stop(); move(T.cursor < 0 ? 0 : T.cursor - 1); }
  else if (k === 'PageDown') { stop(); move(T.cursor + page); }
  else if (k === 'PageUp') { stop(); move(T.cursor - page); }
  else if (k === 'Home' && !e.altKey) { stop(); move(0); }
  else if (k === 'End' && !e.altKey) { stop(); move(T.rows.length - 1); }
  else if (k === 'Enter' && T.cursor >= 0) { stop(); if (T.sel.size > 1) playSelection(); else playRows(T.cursor); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'a' || k === 'A' || k === 'ф' || k === 'Ф')) { stop(); T.sel = new Set(T.rows); paintRows(false); updateSelBar(); }
  else if (k === 'Escape' && clearSel()) stop();
}, true);

/** a song from elsewhere, shown and marked in the list (e.g. «Show in Tracks») */
function reveal(handle) {
  const h0 = lc(handle);
  const r = T.rows.findIndex((i) => lc(handleOf(T.all[i])) === h0);
  if (r < 0) return;
  T.sel = new Set([T.rows[r]]); T.anchor = T.rows[r]; T.cursor = r;
  sc.scrollTop = Math.max(0, r * rowH() - sc.clientHeight / 3);
  paintRows(true);
  const el = T.nodes.get(r); if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
}
/** the playing track changed: mark its row */
export function nowPlaying() { if (active() && T.built) paintRows(false); }
on('playback:stateChanged', () => nowPlaying());
