/*
 * Gatefold · welcome.js — the first run, before foobar2000 knows about any music.
 *
 * A fresh foobar2000 has an empty media library and empty playlists, so every screen of the theme is
 * empty too, and nothing says where music comes from. While that is so, «Now playing» shows a
 * welcome with two ways in:
 *   1. Connect a music folder to the media library (recommended): the library watches it and fills
 *      Library, Artists and the covers. foobar2000 lets only its own Preferences page add library
 *      folders, so the theme opens that page, shows the three clicks to make there, and waits —
 *      as soon as the library has tracks it says so and opens Library.
 *   2. Open a folder or files right away: they go into a playlist and start playing, no library
 *      needed. (Dragging a folder onto the window does the same — dropzone.js.)
 * The empty Library, Artists and playlist screens offer the same buttons (emptyActions()).
 */
import { call, ok, on, esc, plural, debounce, log } from './bridge.js';
import { router, h, icon, toast } from './ui.js';
import { $t } from './i18n.js';

const AUDIO = ['mp3', 'flac', 'm4a', 'aac', 'alac', 'ogg', 'opus', 'wav', 'wv', 'ape', 'aiff', 'aif', 'dsf', 'dff', 'mpc', 'tak', 'tta', 'wma', 'cue', 'm3u', 'm3u8', 'pls', 'fpl'];
const view = document.getElementById('view-now');
let shown = false, waiting = false, pollT = 0, el = null;

/** is there no music anywhere yet: empty library, empty playlists, nothing playing */
export async function isEmpty() {
  const [lib, pls, cur] = await Promise.all([call('config.getLibraryStatus'), call('playlist.getAll'), call('playback.getCurrentTrack')]);
  if (!ok(lib) || !ok(pls)) return false;                    // unknown → never nag
  if (ok(cur) && cur.found !== false && cur.track) return false;
  const inPlaylists = (pls.playlists || []).reduce((s, p) => s + (p.trackCount || 0), 0);
  return !(lib.enabled && lib.itemCount > 0) && inPlaylists === 0;
}

function render() {
  el = h(`<div class="welcome" role="region" aria-label="${$t('Добро пожаловать')}">
    <div class="wl-hero">
      <div class="wl-mark"><svg class="brand-mark wl-g" viewBox="0 0 100 100" aria-hidden="true"><defs><clipPath id="wlClip"><path d="M19 0H81A19 19 0 0 1 100 19V28A8.75 8.75 0 0 1 82.5 28V22.5A5 5 0 0 0 77.5 17.5H22.5A5 5 0 0 0 17.5 22.5V75.5A5 5 0 0 0 22.5 80.5H68L82.5 66.2H62A5 5 0 0 1 57 61.2V55A5 5 0 0 1 62 50H95A5 5 0 0 1 100 55V81A19 19 0 0 1 81 100H19A19 19 0 0 1 0 81V19A19 19 0 0 1 19 0Z"/></clipPath></defs><path class="bm-g" d="M19 0H81A19 19 0 0 1 100 19V28A8.75 8.75 0 0 1 82.5 28V22.5A5 5 0 0 0 77.5 17.5H22.5A5 5 0 0 0 17.5 22.5V75.5A5 5 0 0 0 22.5 80.5H68L82.5 66.2H62A5 5 0 0 1 57 61.2V55A5 5 0 0 1 62 50H95A5 5 0 0 1 100 55V81A19 19 0 0 1 81 100H19A19 19 0 0 1 0 81V19A19 19 0 0 1 19 0Z"/><path class="bm-fold" clip-path="url(#wlClip)" d="M101 50L69 82Q60 97 46 101H101Z"/></svg></div>
      <h1>${$t('Добро пожаловать в Gatefold')}</h1>
    </div>
    <div class="wl-cards">
      <section class="wl-card primary" data-k="library">
        <div class="wl-ic">${icon('folder', 22)}</div>
        <h2>${$t('Подключить папку с музыкой')}</h2>
        <p>${$t('В окне foobar2000: <b>Add…</b> → папка → <b>OK</b>')}</p>
        <div class="wl-acts"><button class="btn primary" data-welcome="library">${icon('folder')}${$t('Подключить папку…')}</button></div>
        <div class="wl-wait" hidden><span class="spinner"></span><span>${$t('Жду, пока foobar2000 найдёт музыку…')}</span></div>
      </section>
      <section class="wl-card" data-k="open">
        <div class="wl-ic">${icon('play', 22)}</div>
        <h2>${$t('Просто послушать')}</h2>
        <div class="wl-acts">
          <button class="btn" data-welcome="folder">${icon('folder')}${$t('Открыть папку…')}</button>
          <button class="btn" data-welcome="files">${icon('music')}${$t('Выбрать файлы…')}</button>
        </div>
        <p class="wl-drop">${icon('download', 14)}${$t('или перетащите её в окно')}</p>
      </section>
    </div>
    <button class="wl-later link" data-welcome="later">${$t('Позже')}</button>
  </div>`);
  return el;
}

function show() {
  if (shown) return;
  shown = true;
  view.append(el || render());
  document.body.classList.add('no-music');
  if (router.current !== 'now') router.go('now');
}
function hide() {
  if (!shown) return;
  shown = false; waiting = false; clearInterval(pollT);
  document.body.classList.remove('no-music');
  el && el.remove();
}

async function recheck() {
  if (!shown) return;
  if (!(await isEmpty())) hide();
}

/* ---------------------------------------------------------------- actions */
export async function connectLibrary() {
  const r = await call('config.showLibraryPreferences');
  if (!ok(r)) { call('misc.showPreferences'); toast($t('Откройте раздел Media Library в настройках foobar2000')); }
  waiting = true;
  if (el) { el.querySelector('.wl-wait').hidden = false; el.querySelector('[data-k=library]').classList.add('waiting'); }
  const t0 = Date.now();
  clearInterval(pollT);
  pollT = setInterval(async () => {
    if (Date.now() - t0 > 15 * 60e3) { clearInterval(pollT); waiting = false; return; }
    const s = await call('config.getLibraryStatus');
    if (ok(s) && s.enabled && s.itemCount > 0) libraryArrived(s.itemCount);
  }, 3000);
}
function libraryArrived(n) {
  if (!waiting) return;
  waiting = false; clearInterval(pollT);
  hide();
  toast($t('Медиатека подключена: {0} {1}', n.toLocaleString(), plural(n, 'трек', 'трека', 'треков')), { ms: 7000 });
  router.go('library');
}

const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** paths → a playlist (a new one named after them, or `guid`), then play what was added */
async function addAndPlay(paths, { guid = '', name = '', folder = false } = {}) {
  let start = 0, made = false;
  if (!guid) {
    const c = await call('playlist.create', { name: name || $t('Моя музыка') });
    if (!ok(c)) { toast($t('Не удалось создать плейлист: {0}', esc(c.error || c.code || ''))); return; }
    guid = c.guid; made = true;
  } else {
    const all = await call('playlist.getAll');
    start = ((ok(all) && all.playlists) || []).find((p) => p.guid === guid)?.trackCount || 0;
  }
  toast($t('Добавляю музыку…'), { ms: 4000 });
  let added = -1;
  /* A folder goes through foobar2000's own «Add folder» (playlist.addPaths): it walks the subfolders and
     works on network shares. playlist.addPathsAsync takes a folder for a single track that cannot play. */
  const a = folder ? null : await call('playlist.addPathsAsync', { paths, playlistGuid: guid });
  if (a && ok(a) && a.operationId) {
    added = await new Promise((resolve) => {
      const off = on('playlist:addComplete', (d) => { if (d.operationId === a.operationId) { off && off(); clearTimeout(t); resolve(d.addedCount ?? 0); } });
      const t = setTimeout(() => { off && off(); resolve(-1); }, 10 * 60e3);
    });
  } else {
    const s = await call('playlist.addPaths', { paths, playlistGuid: guid });
    if (!ok(s)) {
      if (made) call('playlist.remove', { playlistGuid: guid });                   // no empty playlist left behind
      toast(s.code === 'NOT_FOUND' ? $t('Музыки не найдено') : $t('foobar2000 не добавил файлы: ') + esc(s.error || s.code || '')); return;
    }
    added = s.addedCount ?? -1;
    if (s.countBefore != null) start = s.countBefore;
  }
  if (added === 0) { if (made) call('playlist.remove', { playlistGuid: guid }); toast($t('Музыки не найдено')); return; }
  await call('playlist.setActive', { playlistGuid: guid });
  await call('playlist.playTrack', { playlistGuid: guid, index: start });
  hide();
  router.go('playlist', guid);
  if (added > 0) toast($t('Добавлено {0} {1}', added.toLocaleString(), plural(added, 'трек', 'трека', 'треков')), {
    ms: 9000, action: { label: $t('Добавить папку в медиатеку'), fn: connectLibrary },
  });
}

export async function openFolder(guid = '') {
  const r = await call('dialog.openFolder', { title: $t('Папка с музыкой'), defaultPath: '%music%' });
  if (!ok(r) || r.canceled || !r.folderPath) return;
  await addAndPlay([r.folderPath], { guid, name: baseName(r.folderPath), folder: true });
}
export async function openFiles(guid = '') {
  const r = await call('dialog.openFile', { title: $t('Музыкальные файлы'), multiple: true, defaultPath: '%music%',
    filters: [{ name: $t('Музыка'), extensions: AUDIO }, { name: $t('Все файлы'), extensions: ['*'] }] });
  if (!ok(r) || r.canceled || !(r.filePaths || []).length) return;
  await addAndPlay(r.filePaths, { guid, name: r.filePaths.length === 1 ? baseName(r.filePaths[0]).replace(/\.[^.]+$/, '') : $t('Моя музыка') });
}

/** buttons for an empty screen; `guid` makes them fill that playlist instead of a new one */
export function emptyActions({ library = true, guid = '' } = {}) {
  const g = guid ? ` data-guid="${esc(guid)}"` : '';
  return `<div class="empty-acts">
    ${library ? `<button class="btn primary" data-welcome="library">${icon('folder')}${$t('Подключить папку с музыкой…')}</button>` : ''}
    <button class="btn${library ? '' : ' primary'}" data-welcome="folder"${g}>${icon('folder')}${$t('Открыть папку…')}</button>
    <button class="btn" data-welcome="files"${g}>${icon('music')}${$t('Выбрать файлы…')}</button>
  </div>`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-welcome]');
  if (!b) return;
  const guid = b.dataset.guid || '';
  switch (b.dataset.welcome) {
    case 'library': connectLibrary(); break;
    case 'folder': openFolder(guid); break;
    case 'files': openFiles(guid); break;
    case 'later': try { sessionStorage.setItem('gatefold.welcome.later', '1'); } catch {} hide(); break;
  }
});

/* ---------------------------------------------------------------- start-up */
export async function init() {
  try { if (sessionStorage.getItem('gatefold.welcome.later')) return; } catch {}
  if (!(await isEmpty())) return;
  show();
  const again = debounce(recheck, 600);
  ['playlist:itemsAdded', 'playback:trackChanged', 'library:itemsAdded'].forEach((ev) => on(ev, again));
  on('library:itemsAdded', () => { if (waiting) call('config.getLibraryStatus').then((s) => { if (ok(s) && s.itemCount > 0) libraryArrived(s.itemCount); }); });
  log('welcome: no music yet');
}
