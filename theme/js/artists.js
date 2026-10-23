/* Gatefold · artists.js — Artists grid → artist page → albums */
import * as SORT from './sorting.js';
import { call, ok, on, esc, plural, fmtDuration, debounce } from './bridge.js';
import { settings, setSetting } from './settings.js';
import { router, $, h, icon, toast, placeholder, popupMenu, backButton } from './ui.js';
import * as Lib from './library.js';
import * as AA from './artistart.js';
import { paletteForAlbum } from './theme.js';
import { isVarious } from './match.js';

import { $t } from './i18n.js';
import { emptyActions } from './welcome.js';
import * as Loud from './loudness.js';
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
const AR = { list: [], view: [], byKey: new Map(), nodes: new Map(), cols: 1, tw: 160, rh: 210, loaded: false, loading: false };
const scroller = $('artScroller'), grid = $('artGrid');
const GAP = 8, PAD = 20;
const jobOf = (x) => ({ name: x.name, albums: x.albums.map((a) => a.name) });
const yearOf = (a) => parseInt((String(a.year || '').match(/\d{4}/) || ['0'])[0], 10) || 0;

export async function loadArtists(force) {
  if (AR.loading) return;
  if (AR.loaded && !force) { layout(); return; }
  AR.loading = true;
  if (!AR.list.length) grid.innerHTML = `<div class="empty"><div class="spinner"></div><b>${$t('Собираю исполнителей…')}</b></div>`;
  const scan = AA.astate.scanned ? null : AA.scanFolder(); // in parallel with the album list
  const albums = await Lib.getAllAlbums();
  if (scan) await scan;
  if (albums === AR.src && AR.list.length && grid.querySelector('.atile')) { AR.loaded = true; AR.loading = false; return; } // library unchanged
  AR.src = albums;
  const map = new Map();
  for (const a of albums) {
    // «A; B» (or a multi-value tag) is listed under A and under B
    const names = a.artists && a.artists.length > 1 ? a.artists : [String(a.albumArtist || a.artist || '').trim() || $t('Неизвестный исполнитель')];
    for (const name of names) {
      const k = name.toLowerCase();
      let x = map.get(k);
      if (!x) map.set(k, x = { name, key: k, albums: [], tracks: 0, duration: 0, y0: 0, y1: 0 });
      x.albums.push(a); x.tracks += a.trackCount || 0; x.duration += a.duration || 0;
      const y = yearOf(a); if (y) { x.y0 = x.y0 ? Math.min(x.y0, y) : y; x.y1 = Math.max(x.y1, y); }
    }
  }
  AR.list = [...map.values()];
  for (const x of AR.list) SORT.sortDiscography(x.albums);
  AR.byKey = map;
  await sortList();
  AR.loaded = true; AR.loading = false;
  $('artCount').textContent = AR.list.length || '';
  grid.innerHTML = ''; AR.nodes.clear();
  if (!AR.list.length) { grid.innerHTML = `<div class="empty"><b>${$t('Медиатека пуста')}</b><span>${$t('Исполнители появятся, когда в медиатеке будет музыка')}</span>${emptyActions()}</div>`; return; }
  applyFilter();
  // background download of every missing photo (visible tiles jump the queue)
  if (settings.artistAuto) for (const x of AR.list) AA.want(jobOf(x));
}

async function sortList() {
  const by = settings.artistSort || 'name';
  if (by === 'added' || by === 'played') await SORT.ensure(by, AR.src || []);
  SORT.sortArtists(AR.list, by, isVarious);
}

function applyFilter() {
  const q = $('artFilter').value.trim().toLowerCase();
  AR.view = q ? AR.list.filter((x) => x.key.includes(q) || x.albums.some((a) => a.name.toLowerCase().includes(q))) : AR.list;
  $('artSub').textContent = `${AR.view.length} ${plural(AR.view.length, 'исполнитель', 'исполнителя', 'исполнителей')}`;
  grid.querySelectorAll('.atile').forEach((t) => t.remove()); AR.nodes.clear();
  layout();
}

function layout() {
  const W = scroller.clientWidth - PAD * 2;
  const min = 150 + (settings.baseSize - 14) * 6;
  AR.cols = Math.max(2, Math.floor((W + GAP) / (min + GAP)));
  AR.tw = (W - GAP * (AR.cols - 1)) / AR.cols;
  // name + «N альбомов» + years: three text lines that grow with the text size
  AR.rh = AR.tw + Math.max(64, Math.round(10 + (settings.baseSize || 14) * 3.8));
  grid.style.height = Math.ceil(AR.view.length / AR.cols) * AR.rh + 40 + 'px';
  schedule(true);
}

/** text size changed */
export function relayoutArtists() { if (AR.loaded) { grid.querySelectorAll('.atile').forEach((t) => t.remove()); AR.nodes.clear(); layout(); } }
let raf = 0, re = false;
function schedule(r) { re = re || r; if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(re); re = false; }); }
scroller.addEventListener('scroll', () => schedule(false), { passive: true });
new ResizeObserver(() => { if (router.current === 'artists' && AR.loaded) layout(); }).observe(scroller);

function setAv(el, url, fallback) {
  const img = el.querySelector('img');
  img.classList.toggle('fallback', !!fallback);
  img.onload = () => { img.classList.add('on'); el.querySelector('.ph')?.remove(); if (fallback) Lib.coverLoaded(url); };
  img.src = url;
}

function render(relayout) {
  if (router.current !== 'artists' || !AR.view.length) return;
  const st = scroller.scrollTop, vh = scroller.clientHeight;
  const r0 = Math.max(0, Math.floor((st - 300) / AR.rh)), r1 = Math.ceil((st + vh + 300) / AR.rh);
  const keep = new Set(), noAvatar = [];
  for (let r = r0; r <= r1; r++) for (let c = 0; c < AR.cols; c++) {
    const i = r * AR.cols + c; if (i >= AR.view.length) break;
    const x = AR.view[i];
    keep.add(x.key);
    let el = AR.nodes.get(x.key);
    if (!el) {
      const ph = placeholder(x.name, '');
      el = h(`<div class="atile"><div class="av"><div class="ph" style="background:${ph.bg}">${esc(ph.ini)}</div><img alt=""></div><div class="an"></div><div class="as"></div></div>`);
      el.querySelector('.an').textContent = x.name;
      el.querySelector('.as').textContent = `${x.albums.length} ${plural(x.albums.length, 'альбом', 'альбома', 'альбомов')}${x.y0 ? `\n${x.y0}${x.y1 > x.y0 ? '–' + x.y1 : ''}` : ''}`;
      el.addEventListener('click', () => router.go('artist', x));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); artistMenu(x, e.clientX, e.clientY); });
      grid.appendChild(el); AR.nodes.set(x.key, el); relayout = true;
      AA.avatarUrl(x.name).then((u) => { if (u) setAv(el, u); else noAvatar.push([el, x]); flushFallback(); });
    }
    if (relayout) el.style.cssText = `width:${AR.tw}px;transform:translate(${PAD + c * (AR.tw + GAP)}px,${r * AR.rh + 4}px)`;
  }
  for (const [k, el] of AR.nodes) if (!keep.has(k)) { el.remove(); AR.nodes.delete(k); }
  function flushFallback() {
    if (!noAvatar.length) return;
    const batch = noAvatar.splice(0);
    // while the photo is being fetched, show the artist's first album cover in the circle
    Lib.coversFor(batch.map(([, x]) => x.albums[0]?.firstTrackAbsolutePath).filter(Boolean), Math.min(400, Math.round(AR.tw * dpr() / 50) * 50)).then((get) => {
      for (const [el, x] of batch) {
        const u = get(x.albums[0]?.firstTrackAbsolutePath);
        if (u && !el.querySelector('img.on')) setAv(el, u, true);
        if (!isVarious(x.name)) AA.want(jobOf(x), true);
      }
    });
  }
}

AA.events.addEventListener('saved', (e) => {
  const { name, url } = e.detail;
  const el = AR.nodes.get(name.toLowerCase());
  if (el) setAv(el, url);
  if (router.current === 'artist' && current && current.key === name.toLowerCase()) {
    const im = document.querySelector('#artistHero .artist-av img'); if (im) { im.src = url; im.classList.remove('fallback'); }
  }
});

$('artFilter').addEventListener('input', debounce(applyFilter, 150));
$('artSort').addEventListener('change', async (e) => { setSetting('artistSort', e.target.value); await sortList(); applyFilter(); $('artScroller').scrollTop = 0; });

async function artistMenu(x, px, py) {
  const id = await popupMenu([
    { id: 'open', label: $t('Открыть') },
    { id: 'play', label: $t('Слушать всё') },
    ...(Lib.shared.radioFor ? [{ id: 'radio', label: $t('Радио «Похожее на это»') }] : []),
    { type: 'sep' },
    { id: 'photo', label: $t('Найти фото заново') },
    { id: 'folder', label: $t('Открыть папку с фото') },
  ], px, py);
  if (id === 'open') router.go('artist', x);
  if (id === 'play') playArtist(x, false);
  if (id === 'radio') Lib.shared.radioFor(x.name);
  if (id === 'photo') { AA.refetch(jobOf(x)); toast(`${$t('Ищу фото:')} <b>${esc(x.name)}</b>`); }
  if (id === 'folder') openFolder();
}

export async function openFolder() {
  if (!AA.astate.scanned) await AA.scanFolder();
  const p = AA.astate.folderAbs;
  const r = p ? await call('shell.showInExplorer', { path: p }) : { success: false };
  if (!ok(r)) toast(`${$t('Папка с фото:')} <b>${esc(p || AA.DIR)}</b>`, { ms: 8000 });
}

async function playArtist(x, shuffle) {
  const paths = [];
  for (const a of x.albums) for (const t of await Lib.albumTracks(a)) paths.push(t.handle || t.absolutePath);
  if (shuffle) for (let i = paths.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [paths[i], paths[j]] = [paths[j], paths[i]]; }
  if (paths.length) Lib.playPaths(paths, 0, x.name);
}

// ---------------------------------------------------------------- artist page
let current = null, token = 0;
export async function openArtist(arg) {
  if (!arg) return;
  if (typeof arg === 'string') {
    if (!AR.loaded) await loadArtists(false);
    const q = arg.trim().toLowerCase(), first = q.split(/\s*(?:[,;&/]|\bfeat\.?|\bft\.?|\bx\b)\s*/)[0];
    arg = AR.byKey.get(q) || [...AR.byKey.values()].find((x) => x.key.split(/\s*[,;&]\s*/)[0] === q) || AR.byKey.get(first)
      || [...AR.byKey.values()].find((x) => x.key.split(/\s*[,;&]\s*/)[0] === first);
    if (!arg) { toast($t('Исполнитель не найден в медиатеке')); return; }
  }
  const x = arg; current = x;
  const tk = ++token;
  if (!AA.astate.scanned) await AA.scanFolder();
  const ph = placeholder(x.name, '');
  $('artistHero').innerHTML = `
    <div class="artist-av" style="background:${ph.bg}"><span>${esc(ph.ini)}</span><img alt=""></div>
    <div style="min-width:0">
      <div class="kicker">${$t('Исполнитель')}</div>
      <h1>${esc(x.name)}</h1>
      <div class="album-meta">${x.albums.length} ${plural(x.albums.length, 'альбом', 'альбома', 'альбомов')} · ${x.tracks} ${plural(x.tracks, 'трек', 'трека', 'треков')} · ${fmtDuration(x.duration)}${x.y0 ? ` · ${x.y0}${x.y1 > x.y0 ? '–' + x.y1 : ''}` : ''}</div>
      <div class="album-actions">
        <button class="btn primary" id="arPlay">${icon('play')}${$t('Слушать всё')}</button>
        <button class="btn" id="arShuffle">${icon('shuffle')}${$t('Вперемешку')}</button>
        <button class="btn" id="arPhoto">${icon('image')}${$t('Фото ▾')}</button>
      </div>
    </div>`;
  $('artistHero').prepend(backButton('artists'));
  $('arPlay').onclick = () => playArtist(x, false);
  $('arShuffle').onclick = () => playArtist(x, true);
  $('arPhoto').onclick = async (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const id = await popupMenu([{ id: 'refetch', label: $t('Найти фото заново') }, { id: 'folder', label: $t('Открыть папку с фото') }, { type: 'sep' }, { id: 'help', label: $t('Как поставить своё фото') }], r.left, r.bottom + 4);
    if (id === 'refetch') { AA.refetch(jobOf(x)); toast(`${$t('Ищу фото:')} <b>${esc(x.name)}</b>`); }
    if (id === 'folder') openFolder();
    if (id === 'help') toast($t('Своё фото: <b>{0}</b> в папке с фото, затем Ctrl+R', esc(AA.fileNameFor(x.name))), { ms: 9000 });
  };
  const avImg = document.querySelector('#artistHero .artist-av img');
  avImg.onload = () => { avImg.classList.add('on'); document.querySelector('#artistHero .artist-av span')?.remove(); };
  AA.avatarUrl(x.name).then(async (u) => {
    if (tk !== token) return;
    if (u) avImg.src = u;
    else {
      const get = await Lib.coversFor([x.albums[0]?.firstTrackAbsolutePath], Math.round(180 * dpr()));
      const c = get(x.albums[0]?.firstTrackAbsolutePath);
      if (c && tk === token) { avImg.classList.add('fallback'); avImg.src = c; }
      if (settings.artistAuto) AA.want(jobOf(x), true);
    }
  });
  paletteForAlbum(x.albums[0]?.albumArtist, x.albums[0]?.name, x.albums[0]?.firstTrackAbsolutePath).then((p) => {
    if (tk !== token) return;
    const v = $('view-artist'); v.style.setProperty('--a-accent', p.accent.css); v.style.setProperty('--a-glow', p.glow.css);
  });
  const box = $('artistAlbums');
  box.innerHTML = '';
  for (const a of x.albums) {
    const ph2 = placeholder(a.name, a.albumArtist);
    const el = h(`<div class="tile static"><div class="cov"><div class="ph" style="background:${ph2.bg}">${esc(ph2.ini)}</div><img alt=""><button class="play" title="${$t('Слушать')}">${icon('play', 18)}</button></div><div class="tt"></div><div class="ta"></div></div>`);
    el.querySelector('.tt').textContent = a.name;
    el.querySelector('.ta').textContent = [a.edition || yearOf(a) || '', `${a.trackCount || 0} ${plural(a.trackCount || 0, 'трек', 'трека', 'треков')}`].filter(Boolean).join(' · ');
    el.onclick = () => router.go('album', a);
    el.querySelector('.play').onclick = (e) => { e.stopPropagation(); Lib.playAlbumRow(a); };
    box.appendChild(el);
  }
  $('artistScroller').scrollTop = 0;
  const get = await Lib.coversFor(x.albums.map((a) => a.firstTrackAbsolutePath), 400);
  if (tk !== token) return;
  [...box.children].forEach((el, i) => {
    const u = get(x.albums[i].firstTrackAbsolutePath);
    const img = el.querySelector('img');
    if (u) { img.onload = () => { if (img.naturalWidth > 1) { img.classList.add('on'); el.querySelector('.ph')?.remove(); Lib.coverLoaded(u); } }; img.src = u; }
  });
}

router.on('artists', () => loadArtists(false));
import('./coverfetch.js').then((CF) => CF.events.addEventListener('repaired', () => {
  AR.nodes.forEach((el) => el.remove()); AR.nodes.clear();
  if (router.current === 'artists') layout();
}));
router.on('artist', (x) => openArtist(x));
['library:itemsAdded', 'library:itemsRemoved', 'library:itemsModified'].forEach((ev) => on(ev, debounce(() => { if (ev === 'library:itemsModified' && performance.now() < Loud.writingUntil) return; AR.loaded = false; if (router.current === 'artists') loadArtists(true); }, 3000)));
/* the library list came back different from the on-disk snapshot → rebuild */
Lib.libEvents.addEventListener('changed', () => { AR.loaded = false; if (router.current === 'artists') loadArtists(true); });
export const artistsState = AR;
