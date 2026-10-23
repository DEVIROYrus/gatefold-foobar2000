/*
 * Gatefold · folders.js — the library by its folders (Library → Folders).
 *
 * Many collections are organised on disk more carefully than in their tags: bootlegs, compilations,
 * classical, soundtracks. Here the library is shown the way it lies in your folders:
 *   · the tree is built from the paths of the library's own tracks (one query, no disk access), so it is
 *     instant even for a large library; chains of single folders at the top are joined («D:\Music»);
 *   · a folder shows its subfolders as tiles (the cover of their first album) and its own tracks as a list
 *     with links, likes and foobar2000's context menu; the bar on top plays, shuffles, queues or sends the
 *     whole folder (with everything below it) to a playlist, or opens it in Explorer;
 *   · the filter searches the folder and everything below it — folder names, titles, artists, albums;
 *   · optionally, files of the folder that are not in the library yet are listed too (read from the disk
 *     when the folder is opened), so a download can be played before it is added;
 *   · every step is a screen of its own: Backspace, Alt+← and the mouse's back button go back, Alt+↑ goes up;
 *     the last folder is remembered, and an album or a track can be shown in its folder.
 * Gatefold never copies, moves, renames or deletes files here — that is what Explorer is for.
 */
import { call, ok, esc, fmtTime, fmtDuration, plural, log } from './bridge.js';
import { router, $, h, icon, toast, placeholder, popupMenu } from './ui.js';
import { settings, setSetting } from './settings.js';
import { bgCall } from './sched.js';
import { $t } from './i18n.js';
import * as Lib from './library.js';

const FIELDS = ['handle', 'title', 'artist', 'album', 'albumArtist', 'absolutePath', 'subsong', 'trackNumber', 'discNumber', 'duration', 'codec', 'sampleRate', 'date'];
const AUDIO = /\.(flac|mp3|m4a|m4b|mp4|aac|ogg|oga|opus|wav|wv|ape|aiff?|dsf|dff|mpc|tak|tta|wma|mka|alac|caf|spx|ofr|ofs)$/i;
const SEP = /[\\/]+/;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const lc = (s) => String(s || '').toLowerCase();
const yearOf = (d) => (String(d || '').match(/\d{4}/) || [''])[0];
const kHz = (r) => (r ? (r / 1000).toFixed(1).replace('.0', '') + $t(' кГц') : '');

const view = $('view-library');
const F = {
  tree: null, loading: null, stale: true,
  node: null,          // the folder shown
  rows: [],            // its tracks (library ones, then the ones not in the library)
  dirs: [],            // its subfolders as shown
  sel: new Set(), anchor: -1, focus: '', token: 0, q: '',
};

/* ---------------------------------------------------------------- the tree */
const mk = (name, path, parent) => ({ name, path, parent, kids: new Map(), files: [], n: 0, dur: 0, first: -1, dirsN: 0 });
/** the folder segments of a path: «D:\Music\A\x.flac» → ['D:', 'Music', 'A']; «\\server\share\…» keeps «\\server» */
function segs(path) {
  const p = String(path || '');
  if (!p || /^[a-z][a-z0-9+.-]+:\/\//i.test(p)) return null;          // a stream, not a file
  const unc = p.startsWith('\\\\') ? '\\\\' : '';
  const parts = p.slice(unc.length).split(SEP).filter(Boolean);
  parts.pop();                                                          // the file name
  if (unc && parts.length) parts[0] = unc + parts[0];
  return parts;
}
const join = (a, b) => (a ? (a.endsWith('\\') ? a + b : a + '\\' + b) : b);
async function load() {
  if (F.tree && !F.stale) return F.tree;
  if (F.loading) return F.loading;
  F.loading = (async () => {
    const r = await bgCall('library.query', { query: 'ALL', limit: 1000000, fields: FIELDS }, 'normal');
    const tracks = ok(r) ? r.tracks || [] : [];
    const root = mk('', '', null);
    tracks.forEach((t, i) => {
      const parts = segs(t.absolutePath); if (!parts) return;
      let n = root;
      for (const s of parts) {
        const k = lc(s);
        let c = n.kids.get(k);
        if (!c) { c = mk(s, join(n.path, s), n); n.kids.set(k, c); }
        n = c;
      }
      n.files.push(i);
    });
    // counts, durations and the first track (for the cover), from the leaves up
    const sum = (n) => {
      n.files.sort((a, b) => collator.compare(tracks[a].absolutePath, tracks[b].absolutePath) || (tracks[a].subsong || 0) - (tracks[b].subsong || 0));
      n.n = n.files.length; n.dur = n.files.reduce((s, i) => s + (tracks[i].duration || 0), 0); n.first = n.files[0] ?? -1;
      for (const c of sorted(n)) { sum(c); n.n += c.n; n.dur += c.dur; n.dirsN += 1 + c.dirsN; if (n.first < 0) n.first = c.first; }
    };
    sum(root);
    const index = new Map();
    const walk = (n) => { index.set(lc(n.path), n); for (const c of n.kids.values()) walk(c); };
    walk(root);
    F.tree = { root, tracks, index, top: topOf(root) };
    F.stale = false;
    log('folders:', index.size - 1, 'folders,', tracks.length, 'tracks');
    return F.tree;
  })().finally(() => { F.loading = null; });
  return F.loading;
}
const sorted = (n) => [...n.kids.values()].sort((a, b) => collator.compare(a.name, b.name));
/** the folder the browser starts in: down the chain of single folders from the root («D:\Music») */
function topOf(root) {
  let n = root;
  while (n.kids.size === 1 && !n.files.length) n = [...n.kids.values()][0];
  return n;
}
/** a folder's subfolders, each joined with its own chain of single folders at the virtual root («D:\Music») */
function children(n) {
  return sorted(n).map((c) => {
    let d = c, label = c.name;
    if (n === F.tree.root) while (d.kids.size === 1 && !d.files.length) { d = [...d.kids.values()][0]; label = d.path; }
    return { node: d, label, path: d.path };
  });
}
/** every track below a folder, in folder order */
function allBelow(n) { const out = []; const go = (x) => { out.push(...x.files); for (const c of sorted(x)) go(c); }; go(n); return out; }

/* the tags of a folder's own tracks: «Artist · 2014» when they are one album */
function albumLine(n) {
  if (!n.files.length || n.kids.size) return '';
  const T = F.tree.tracks, a = new Set(), al = new Set(), y = new Set();
  for (const i of n.files) { a.add(T[i].albumArtist || T[i].artist || ''); al.add(T[i].album || ''); y.add(yearOf(T[i].date)); }
  if (al.size !== 1) return '';
  return [a.size === 1 ? [...a][0] : $t('Разные исполнители'), y.size === 1 ? [...y][0] : ''].filter(Boolean).join(' · ');
}
const countLine = (n) => (n.kids.size
  ? `${n.dirsN} ${plural(n.dirsN, 'папка', 'папки', 'папок')} · ${n.n} ${plural(n.n, 'трек', 'трека', 'треков')}`
  : `${n.n} ${plural(n.n, 'трек', 'трека', 'треков')} · ${fmtDuration(n.dur)}`);

/* ---------------------------------------------------------------- the screen */
const bar = $('fdBar'), dirsEl = $('fdDirs'), list = $('fdList'), head = $('fdHead'), sc = $('fdScroller');
export const active = () => router.current === 'library' && view.classList.contains('folders');

/** Library → Folders, at this folder ('' = where the tree starts); `focus` marks a track of it */
export async function show(path = settings.libFolder || '', focus = '') {
  setMode(true);
  const tk = ++F.token;
  if (!F.tree || F.stale) {
    dirsEl.innerHTML = ''; list.innerHTML = ''; list.style.height = '0px'; head.hidden = true;
    bar.innerHTML = `<div class="fd-loading"><span class="spinner"></span>${$t('Читаю папки…')}</div>`;
  }
  const T = await load();
  if (tk !== F.token) return;
  let n = path ? T.index.get(lc(path)) : null;
  if (!n && path && settings.folderExtras) n = await diskNode(path);          // a folder outside the library
  if (!n) n = T.top;
  if (tk !== F.token) return;
  F.node = n; F.sel = new Set(); F.anchor = -1; F.focus = lc(focus);
  setSetting('libFolder', n === T.top ? '' : n.path);
  const q = $('libFilter').value.trim();
  F.q = q;
  await render(tk);
}
/** the folder of an album or a track, from anywhere */
export function reveal(path) {
  const parts = segs(path); if (!parts) return;
  router.go('library', { folder: parts.reduce(join, '') || '', focus: path });
}
export function setMode(on) {
  view.classList.toggle('folders', on);
  view.querySelectorAll('.lib-mode button').forEach((b) => { const m = b.dataset.m === (on ? 'folders' : 'albums'); b.classList.toggle('on', m); b.setAttribute('aria-pressed', String(m)); });
  view.querySelector('.view-head h2').textContent = on ? $t('Папки') : $t('Альбомы');
  if (settings.libMode !== (on ? 'folders' : 'albums')) setSetting('libMode', on ? 'folders' : 'albums');
}
export function invalidate() { F.stale = true; if (active()) show(F.node ? F.node.path : '', ''); }

/* files of the folder that the library does not have, read from the disk (optional) */
async function extrasOf(n) {
  if (!settings.folderExtras || !n.path) return { files: [], dirs: [] };
  const r = await call('file.list', { path: n.path });
  if (!ok(r)) return { files: [], dirs: [] };
  const have = new Set(n.files.map((i) => lc(F.tree.tracks[i].absolutePath).split(SEP).pop()));
  const kids = new Set([...n.kids.keys()]);
  return {
    files: (r.files || []).filter((f) => AUDIO.test(f) && !have.has(lc(f))).sort(collator.compare).map((f) => ({ extra: true, title: f.replace(/\.[^.]+$/, ''), absolutePath: join(n.path, f), handle: join(n.path, f), codec: (f.match(/\.([^.]+)$/) || ['', ''])[1].toUpperCase() })),
    dirs: (r.directories || []).filter((d) => !kids.has(lc(d))).sort(collator.compare).map((d) => ({ extra: true, label: d, path: join(n.path, d) })),
  };
}
/** a folder that is not in the library: what the disk has (only with «files not in the library» on) */
async function diskNode(path) {
  const r = await call('file.list', { path });
  if (!ok(r)) return null;
  const parts = segs(path + '\\x'); const n = mk(parts[parts.length - 1] || path, path, null);
  n.disk = true;
  let p = parts.slice(0, -1).reduce(join, '');
  n.parent = F.tree.index.get(lc(p)) || (p ? { path: p, name: p.split(SEP).pop(), disk: true, parent: null } : F.tree.top);
  return n;
}

async function render(tk) {
  const n = F.node, T = F.tree;
  const ex = await extrasOf(n);
  if (tk !== F.token) return;
  const q = lc(F.q);
  if (q) {
    // the filter: everything below this folder whose name, title, artist or album matches
    const dirs = [], files = [];
    const go = (x, rel) => {
      for (const c of sorted(x)) { const r2 = rel ? rel + '\\' + c.name : c.name; if (lc(c.name).includes(q) && dirs.length < 200) dirs.push({ node: c, label: c.name, sub: r2, path: c.path }); go(c, r2); }
      for (const i of x.files) { if (files.length >= 2000) break; const t = T.tracks[i]; if (lc(`${t.title} ${t.artist} ${t.album} ${t.absolutePath.split(SEP).pop()}`).includes(q)) files.push(i); }
    };
    go(n, '');
    F.dirs = dirs; F.rows = files.map((i) => T.tracks[i]);
  } else {
    F.dirs = [...children(n), ...ex.dirs];
    F.rows = [...n.files.map((i) => T.tracks[i]), ...ex.files];
  }
  paintBar(n);
  paintDirs();
  paintList();
  const sub = $('libSub');
  if (sub) sub.textContent = q ? `${F.dirs.length} ${plural(F.dirs.length, 'папка', 'папки', 'папок')} · ${F.rows.length} ${plural(F.rows.length, 'трек', 'трека', 'треков')}` : (n.n ? countLine(n) : '');
  if (F.focus) {
    const i = F.rows.findIndex((t) => lc(t.handle || t.absolutePath) === F.focus || lc(t.absolutePath) === F.focus);
    F.focus = '';
    if (i >= 0) { F.sel = new Set([i]); F.anchor = i; requestAnimationFrame(() => { sc.scrollTop = Math.max(0, list.offsetTop + i * rowH() - sc.clientHeight / 3); paintRows(true); const r = list.querySelector(`.vrow[data-i="${i}"]`); if (r) { r.classList.add('flash'); setTimeout(() => r.classList.remove('flash'), 1600); } }); return; }
  }
  sc.scrollTop = 0;
}

/* the bar: where you are (each step a link) and what can be done with the whole folder */
function paintBar(n) {
  const T = F.tree, chain = [];
  for (let x = n; x && x !== T.root; x = x.parent) { chain.unshift(x); if (x === T.top) break; }
  const topIsRoot = T.top === T.root;
  const crumbs = [`<button class="fd-crumb${n === T.top ? ' cur' : ''}" data-path="">${icon('folder', 15)}<span>${esc(topIsRoot ? $t('Все папки') : T.top.path)}</span></button>`];
  for (const x of chain) if (x !== T.top) crumbs.push(`<span class="fd-sep">${icon('chev', 12)}</span><button class="fd-crumb${x === n ? ' cur' : ''}" data-path="${esc(x.path)}">${esc(x.name)}</button>`);
  const has = n.n > 0 || F.rows.length > 0;
  bar.innerHTML = `
    <nav class="fd-crumbs" aria-label="${$t('Путь')}">${crumbs.join('')}</nav>
    <div class="fd-acts">
      ${n !== T.top ? `<button class="icon-btn" data-act="up" title="${$t('На уровень выше (Alt+↑)')}">${icon('chev-up', 16)}</button>` : ''}
      <button class="btn primary sm" data-act="play"${has ? '' : ' disabled'}>${icon('play', 14)}${$t('Слушать')}</button>
      <button class="btn sm" data-act="shuffle"${has ? '' : ' disabled'}>${icon('shuffle', 14)}${$t('Вперемешку')}</button>
      <button class="icon-btn" data-act="more" title="${$t('Ещё')}" aria-haspopup="menu">${icon('more', 16)}</button>
    </div>`;
  const cr = bar.querySelector('.fd-crumbs'); requestAnimationFrame(() => { cr.scrollLeft = cr.scrollWidth; });
  bar.querySelectorAll('.fd-crumb').forEach((b) => { b.onclick = () => { if (!b.classList.contains('cur')) open(b.dataset.path); }; });
  bar.querySelector('[data-act=up]')?.addEventListener('click', up);
  bar.querySelector('[data-act=play]').onclick = () => playFolder(n, false);
  bar.querySelector('[data-act=shuffle]').onclick = () => playFolder(n, true);
  bar.querySelector('[data-act=more]').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); folderMenu(n, r.right - 240, r.bottom + 4); };
}
const open = (path) => router.go('library', { folder: path });
export function up() {
  const T = F.tree, n = F.node; if (!n || !T || n === T.top) return;
  const p = n.parent;
  // a folder of a joined chain at the top («D:\Music») has nothing above it but the start
  const chain = (x) => { for (; x && x !== T.root; x = x.parent) if (!x.kids || x.kids.size !== 1 || x.files.length) return false; return true; };
  open(!p || p === T.top || p === T.root || (T.top === T.root && chain(p)) ? '' : p.path);
}

/* subfolders: tiles with the cover of their first track */
let io = null;
function paintDirs() {
  dirsEl.innerHTML = '';
  if (io) io.disconnect();
  if (!F.dirs.length) { dirsEl.hidden = true; return; }
  dirsEl.hidden = false;
  const T = F.tree;
  const want = [];
  io = new IntersectionObserver((es) => {
    const vis = es.filter((e) => e.isIntersecting).map((e) => e.target);
    for (const el of vis) io.unobserve(el);
    const paths = vis.map((el) => el.dataset.cover).filter(Boolean);
    if (!paths.length) return;
    Lib.coversFor(paths, Math.round(200 * (devicePixelRatio || 1))).then((get) => {
      for (const el of vis) { const u = get(el.dataset.cover); const img = el.querySelector('img'); if (u && img) { img.onload = () => { img.classList.add('on'); el.querySelector('.ph')?.remove(); }; img.src = u; } }
    });
  }, { root: sc, rootMargin: '300px' });
  const frag = document.createDocumentFragment();
  F.dirs.forEach((d, i) => {
    const n = d.node, cover = n && n.first >= 0 ? T.tracks[n.first].absolutePath : '';
    const ph = placeholder(d.label, '');
    const sub = d.extra ? $t('не в медиатеке') : d.sub && d.sub !== d.label ? d.sub : albumLine(n) || countLine(n);
    const el = h(`<div class="tile static fd-tile${d.extra ? ' extra' : ''}${n && n.kids.size ? ' stack' : ''}" data-i="${i}" tabindex="0" role="button">
      <div class="cov">${cover ? `<div class="ph" style="background:${ph.bg}">${icon('folder', 34)}</div><img alt="">` : `<div class="ph fd-ph">${icon('folder', 40)}</div>`}${d.extra ? '' : `<button class="play" title="${$t('Слушать')}" tabindex="-1">${icon('play', 18)}</button>`}</div>
      <div class="tt"></div><div class="ta"></div></div>`);
    el.querySelector('.tt').textContent = d.label; el.querySelector('.tt').title = d.path;
    el.querySelector('.ta').textContent = sub;
    if (cover) { el.dataset.cover = cover; want.push(el); }
    frag.append(el);
  });
  dirsEl.append(frag);
  for (const el of want) io.observe(el);
}
dirsEl.addEventListener('click', (e) => {
  const el = e.target.closest('.fd-tile'); if (!el) return;
  const d = F.dirs[+el.dataset.i]; if (!d) return;
  if (e.target.closest('.play')) { e.stopPropagation(); if (d.node) playFolder(d.node, false); return; }
  open(d.path);
});
dirsEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('.fd-tile')) { e.preventDefault(); e.target.click(); } });
dirsEl.addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.fd-tile'); if (!el) return; e.preventDefault();
  const d = F.dirs[+el.dataset.i]; if (d && d.node) folderMenu(d.node, e.clientX, e.clientY); else if (d) folderMenu({ path: d.path, n: 0, extra: true }, e.clientX, e.clientY);
});

/* the folder's own tracks: a virtual list like a playlist's */
const rowH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 36;
const GRID = '44px minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, .8fr) 64px';
function paintList() {
  if (!F.rows.length) { head.hidden = true; list.innerHTML = ''; list.style.height = '0px'; paintEmpty(); return; }
  head.hidden = false;
  head.innerHTML = `<div>#</div><div>${$t('Название')}</div><div>${$t('Исполнитель')}</div><div>${$t('Альбом')}</div><div class="h-album">${$t('Формат')}</div><div>${$t('Время')}</div>`;
  list.innerHTML = ''; list.dataset.n = '';
  list.style.height = F.rows.length * rowH() + 16 + 'px';
  paintRows(true);
}
function paintEmpty() {
  const n = F.node;
  if (F.dirs.length) return;
  list.innerHTML = `<div class="empty fd-empty">${F.q ? `<b>${$t('Ничего не нашлось')}</b>` : `<b>${$t('Папка пуста')}</b><span>${n && n.disk ? $t('В этой папке нет музыки') : $t('В медиатеке нет треков из этой папки')}</span>`}</div>`;
  list.style.height = '';
}
let rowRaf = 0;
function paintRows(force) {
  if (!F.rows.length) return;
  const H = rowH(), top = sc.scrollTop - list.offsetTop, vh = sc.clientHeight;
  const a = Math.max(0, Math.floor((top - 300) / H)), b = Math.min(F.rows.length, Math.ceil((top + vh + 300) / H));
  const key = a + ':' + b;
  if (!force && list.dataset.n === key) return;
  list.dataset.n = key;
  const now = lc(Lib.shared.nowHandle || '');
  let html = '';
  for (let i = a; i < b; i++) {
    const t = F.rows[i];
    const hdl = lc(t.handle || t.absolutePath);
    const cls = ['vrow', F.sel.has(i) ? 'sel' : '', hdl === now ? 'playing' : '', t.extra ? 'extra' : ''].filter(Boolean).join(' ');
    const fmt = [t.codec, kHz(t.sampleRate)].filter(Boolean).join(' · ');
    html += `<div class="${cls}" data-i="${i}"${t.extra ? '' : Lib.rowKit.likeAttr(t)} style="transform:translateY(${i * H}px)">`
      + `<div class="c-n num">${t.extra ? '' : t.trackNumber || ''}</div>`
      + `<div class="c-title">${esc(t.title || t.absolutePath.split(SEP).pop())}${t.extra ? ` <span class="chip fd-new">${$t('не в медиатеке')}</span>` : ''}</div>`
      + `<div class="c-artist">${t.artist ? Lib.artistLinks(t.artist) : ''}</div>`
      + `<div class="c-album">${t.album ? `<span class="lnk" data-go="album">${esc(t.album)}</span>` : ''}</div>`
      + `<div class="c-fmt">${esc(fmt)}</div>`
      + `<div class="c-dur num">${t.duration ? fmtTime(t.duration) : ''}</div>${t.extra ? '' : Lib.rowKit.LIKE_BTN}</div>`;
  }
  list.innerHTML = html;
  list.querySelectorAll('.vrow[data-h]').forEach(Lib.rowKit.likeRow);
}
sc.addEventListener('scroll', () => { if (!rowRaf && active()) rowRaf = requestAnimationFrame(() => { rowRaf = 0; paintRows(false); }); }, { passive: true });
new ResizeObserver(() => { if (active()) paintRows(true); }).observe(sc);

const handleOf = (t) => t.handle || (t.subsong ? `${t.absolutePath}|subsong:${t.subsong}` : t.absolutePath);
list.addEventListener('click', (e) => {
  const r = e.target.closest('.vrow'); if (!r) return;
  const i = +r.dataset.i, t = F.rows[i];
  if (Lib.rowKit.heartClick(e, () => t)) return;
  const lk = e.target.closest('.lnk');
  if (lk && !e.shiftKey && !e.ctrlKey && e.detail < 2) {
    if (lk.dataset.go === 'artist') router.go('artist', lk.textContent);
    if (lk.dataset.go === 'album') { const a = Lib.albumOfTrack({ ...t, path: handleOf(t) }); if (a && a.name) router.go('album', a); }
    return;
  }
  if (e.shiftKey && F.anchor >= 0) { F.sel = new Set(); const [x, y] = [Math.min(F.anchor, i), Math.max(F.anchor, i)]; for (let k = x; k <= y; k++) F.sel.add(k); }
  else if (e.ctrlKey) { if (F.sel.has(i)) F.sel.delete(i); else F.sel.add(i); F.anchor = i; }
  else { F.sel = new Set([i]); F.anchor = i; }
  markSel();                                              // in place: a redrawn row would swallow the double click
});
const markSel = () => list.querySelectorAll('.vrow').forEach((r) => r.classList.toggle('sel', F.sel.has(+r.dataset.i)));
list.addEventListener('dblclick', (e) => {
  const r = e.target.closest('.vrow'); if (!r || e.target.closest('.row-like')) return;
  playRows(F.rows, +r.dataset.i);
});
list.addEventListener('contextmenu', (e) => {
  const r = e.target.closest('.vrow'); if (!r) return; e.preventDefault();
  const i = +r.dataset.i;
  if (!F.sel.has(i)) { F.sel = new Set([i]); F.anchor = i; markSel(); }
  const handles = [...F.sel].sort((a, b) => a - b).map((k) => handleOf(F.rows[k]));
  call('menu.showNativePopup', { mode: 'handles', handles });
});

/* ---------------------------------------------------------------- what can be done with a folder */
const label = (n) => (n.name || n.path || $t('Папки'));
function pathsOf(n) { return n.extra ? [] : allBelow(n).map((i) => handleOf(F.tree.tracks[i])); }
async function playRows(rows, start = 0) {
  const paths = rows.map(handleOf);
  if (!paths.length) return;
  await Lib.playPaths(paths, start, F.node ? label(F.node) : '');
}
async function playFolder(n, shuffle) {
  let paths = n === F.node && F.q ? F.rows.map(handleOf) : [...pathsOf(n), ...(n === F.node && !F.q ? F.rows.filter((t) => t.extra).map(handleOf) : [])];
  if (!paths.length) { toast($t('В этой папке нет треков')); return; }
  if (shuffle) { paths = paths.slice(); for (let i = paths.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [paths[i], paths[j]] = [paths[j], paths[i]]; } }
  await Lib.playPaths(paths, 0, label(n));
}
async function folderMenu(n, x, y) {
  const has = !n.extra && n.n > 0;
  const items = [
    ...(has ? [{ id: 'play', label: $t('Слушать') }, { id: 'shuffle', label: $t('Вперемешку') }, { id: 'queue', label: $t('В очередь') }, { id: 'playlist', label: $t('В плейлист…'), children: true }, { type: 'sep' }] : []),
    { id: 'explorer', label: $t('Показать в проводнике'), disabled: !n.path },
    ...(n === F.node ? [{ type: 'sep' }, { id: 'extras', label: $t('Показывать файлы не из медиатеки'), checked: !!settings.folderExtras }] : []),
  ];
  const id = await popupMenu(items, x, y);
  if (id === 'play') playFolder(n, false);
  if (id === 'shuffle') playFolder(n, true);
  if (id === 'queue') {
    const paths = pathsOf(n);
    const r = await call('queue.addPaths', { paths });
    toast(ok(r) ? $t('В очереди: {0}', `${paths.length} ${plural(paths.length, 'трек', 'трека', 'треков')}`) : $t('Очередь недоступна: ') + esc(r.error || ''));
  }
  if (id === 'playlist') toPlaylist(n, x, y);
  if (id === 'explorer' && n.path) {
    const first = !n.extra && n.first >= 0 ? F.tree.tracks[n.first].absolutePath : '';
    call('shell.showInExplorer', { path: first && first.toLowerCase().startsWith(lc(n.path) + '\\') && n.files && n.files.length ? first : n.path });
  }
  if (id === 'extras') { setSetting('folderExtras', !settings.folderExtras); show(F.node.path || ''); }
}
async function toPlaylist(n, x, y) {
  const r = await call('playlist.getAll');
  const pls = ok(r) ? (r.playlists || []).filter((p) => !p.isAutoplaylist && !p.locked) : [];
  const id = await popupMenu([{ id: '+new', label: $t('Новый плейлист «{0}»', label(n)) }, ...(pls.length ? [{ type: 'sep' }] : []), ...pls.map((p) => ({ id: p.guid, label: p.name }))], x, y);
  if (!id) return;
  let guid = id, name = '';
  if (id === '+new') { const c = await call('playlist.create', { name: label(n) }); if (!ok(c)) { toast(esc(c.error || '')); return; } guid = c.guid; name = label(n); } else name = (pls.find((p) => p.guid === id) || {}).name || '';
  const paths = pathsOf(n);
  const a = await call('library.addToPlaylist', { paths, playlistGuid: guid });
  toast(ok(a) ? $t('Добавлено в «{0}»: {1}', esc(name), `${paths.length} ${plural(paths.length, 'трек', 'трека', 'треков')}`) : $t('Ошибка добавления: ') + esc(a.error || ''));
}

/* keys: Alt+↑ — up a level; Enter — play the selected track */
addEventListener('keydown', (e) => {
  if (!active() || (e.target.closest && e.target.closest('input, textarea, select'))) return;
  if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); up(); }
  else if (e.key === 'Enter' && F.sel.size && !e.target.closest?.('.fd-tile, button')) { e.preventDefault(); playRows(F.rows, Math.min(...F.sel)); }
}, true);
/** the filter of the Library header, in Folders */
export function filter(q) { F.q = q.trim(); if (F.node) render(++F.token); }
/** the playing track changed: mark its row */
export function nowPlaying() { if (active()) paintRows(true); }
