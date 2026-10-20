/*
 * Gatefold · dropzone.js — drag files/folders from Explorer into foobar2000.
 *
 * WebView2 receives the OS drop; the page must accept it (preventDefault in
 * dragover) and then asks the host for the real paths (dnd.getPathsAsync).
 * foobar2000 itself expands folders/playlists (playlist.addPaths), so a whole
 * album tree can be dropped. The imported batch then gets an action bar whose
 * menus are foobar's own context menu built for exactly those files
 * (menu.getContextMenu mode:'handles') — Convert ▸ presets, ReplayGain,
 * Masstagger, DR Meter… run on the dropped tracks, not on the playing one.
 */
import { call, ok, esc, plural, log } from './bridge.js';
import { router, $, h, icon, toast, popupMenu } from './ui.js';

import { $t } from './i18n.js';
const overlay = $('dropOverlay');
let depth = 0, hoverTarget = 'new', hoverPl = null;

const hasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

function show() { document.body.classList.add('dragging'); }
function hide() {
  document.body.classList.remove('dragging'); depth = 0;
  overlay.querySelectorAll('.drop-zone').forEach((z) => z.classList.remove('hot'));
  document.querySelectorAll('.pl-item.drop-hl').forEach((x) => x.classList.remove('drop-hl'));
}
function setHover(e) {
  const pl = e.target.closest && e.target.closest('.pl-item[data-guid]');
  const zone = e.target.closest && e.target.closest('.drop-zone');
  document.querySelectorAll('.pl-item.drop-hl').forEach((x) => { if (x !== pl) x.classList.remove('drop-hl'); });
  hoverPl = pl ? pl.dataset.guid : null;
  if (pl) pl.classList.add('drop-hl');
  if (zone) hoverTarget = zone.dataset.target;
  overlay.querySelectorAll('.drop-zone').forEach((z) => z.classList.toggle('hot', !hoverPl && z.dataset.target === hoverTarget));
}

/* The overlay covers the views while files hang over the window. Counting dragenter/dragleave is
   fragile (a leave can be lost when the drag is cancelled outside, or the host does not forward it),
   and a forgotten overlay would swallow every click. So it also goes away when dragover stops coming
   (one comes at least every few hundred ms while a drag is over the page) or the mouse moves normally. */
let lastOver = 0, watch = 0;
function alive() {
  clearInterval(watch);
  watch = setInterval(() => { if (!document.body.classList.contains('dragging')) { clearInterval(watch); return; } if (performance.now() - lastOver > 1500) hide(); }, 250);
}
document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; lastOver = performance.now(); show(); setHover(e); alive(); });
document.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); lastOver = performance.now(); e.dataTransfer.dropEffect = 'copy'; if (!document.body.classList.contains('dragging')) { show(); alive(); } setHover(e); });
for (const ev of ['pointermove', 'pointerdown']) addEventListener(ev, () => { if (document.body.classList.contains('dragging')) hide(); }, { capture: true, passive: true });
addEventListener('gatefold:input-reset', () => { if (document.body.classList.contains('dragging')) hide(); });
document.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--depth <= 0) hide(); });
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const target = hoverPl || hoverTarget;
  const n = e.dataTransfer.files ? e.dataTransfer.files.length : 0;
  hide();
  handleDrop(target, n);
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('dragging')) hide(); });

const stamp = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

async function handleDrop(target, n) {
  const r = await call('dnd.getPathsAsync', {});
  const paths = ok(r) ? (r.paths || []).map((p, i) => (r.resolvedPaths && r.resolvedPaths[i]) || p).filter(Boolean) : [];
  if (!paths.length) {
    toast($t('Не удалось получить пути перетаскиваемых файлов{0}. Попробуйте ещё раз — отпускайте файлы после того, как появится подсветка.', r.error ? ': ' + esc(r.error) : ''), { ms: 7000 });
    log('dnd.getPathsAsync', r);
    return;
  }
  let guid = '', name = '';
  if (target === 'new') {
    name = $t('Импорт · {0}', stamp());
    const c = await call('playlist.create', { name });
    guid = ok(c) ? c.guid : '';
  } else if (target === 'current') {
    const a = await call('playlist.getActive');
    if (ok(a) && a.found !== false) { guid = a.guid; name = a.name; }
  } else {
    guid = target;
    const all = await call('playlist.getAll');
    name = ((ok(all) && all.playlists) || []).find((p) => p.guid === guid)?.name || '';
  }
  if (!guid) { toast($t('Не удалось подготовить плейлист для импорта')); return; }
  toast(`${$t('Добавляю')} ${paths.length} ${plural(paths.length, 'объект', 'объекта', 'объектов')}…`, { ms: 2500 });
  const add = await call('playlist.addPaths', { paths, playlistGuid: guid });
  if (!ok(add)) { toast($t('foobar2000 не добавил файлы: ') + esc(add.error || add.code || '')); return; }
  const start = add.countBefore ?? 0;
  const count = add.addedCount ?? Math.max(0, (add.totalCount ?? 0) - start);
  await call('playlist.setActive', { playlistGuid: guid });
  router.go('playlist', guid);
  showBatch({ guid, name, start, count });
}

// ------------------------------------------------------------------ batch action bar
let batch = null;
const bar = $('batchBar');

async function batchHandles() {
  const out = [];
  for (let s = batch.start; s < batch.start + batch.count; s += 1000) {
    const r = await call('playlist.getTracks', { playlistGuid: batch.guid, start: s, count: Math.min(1000, batch.start + batch.count - s), fields: ['handle', 'absolutePath', 'subsong'] });
    if (!ok(r)) break;
    for (const t of r.tracks || []) out.push(t.handle || (t.subsong ? `${t.absolutePath}|subsong:${t.subsong}` : t.absolutePath));
  }
  return out;
}

function mapCtx(items) {
  return (items || []).filter((it) => it && !it.hidden).map((it) => {
    if (it.type === 'separator') return { type: 'sep' };
    const kids = it.children && it.children.length ? mapCtx(it.children) : null;
    return { id: kids ? null : String(it.commandId), label: String(it.displayLabel || it.label || '').replace(/&(?!&)/g, ''), disabled: !kids && (it.enabled === false || it.commandId == null), children: kids };
  }).filter((x, i, a) => !(x.type === 'sep' && (i === 0 || a[i - 1].type === 'sep')));
}
const CONVERT = /^(convert|конверт|преобраз)/i;
function findConvert(items) {
  for (const it of items || []) {
    const l = String(it.displayLabel || it.label || '');
    if (it.children && CONVERT.test(l)) return it;
  }
  for (const it of items || []) if (it.children) { const f = findConvert(it.children); if (f) return f; }
  return null;
}

async function contextFor(onlyConvert, anchor) {
  const handles = await batchHandles();
  if (!handles.length) { toast($t('Треки импорта не найдены — возможно, плейлист изменён')); return; }
  const m = await call('menu.getContextMenu', { mode: 'handles', handles, withAvailability: false });
  if (!ok(m) || !m.items) { toast($t('Контекстное меню недоступно: ') + esc(m.error || '')); return; }
  let items = m.items;
  if (onlyConvert) {
    const conv = findConvert(items);
    if (!conv) { toast($t('В меню нет пункта Convert — включён ли компонент Converter? Открываю все действия.')); }
    else items = conv.children;
  }
  const r = anchor.getBoundingClientRect();
  const menu = mapCtx(items);
  const id = await popupMenu(menu, r.left, r.top - 8 - Math.min(14, menu.length) * 32);
  if (id == null || id === 'null') return;
  const run = await call('menu.runContextCommandById', { id: +id, mode: 'handles', handles });
  if (!ok(run)) toast($t('Команда не выполнена: ') + esc(run.error || run.code || ''));
}

function showBatch(b) {
  batch = b;
  bar.innerHTML = '';
  bar.append(
    h(`<div class="bb-text">${icon('folder', 18)}<div><b>${$t('Импортировано: {0} {1}', b.count, plural(b.count, 'трек', 'трека', 'треков'))}</b><small>${$t('в «{0}»', esc(b.name))}</small></div></div>`),
  );
  const btn = (html, fn, cls = '') => { const e = h(`<button class="btn sm ${cls}">${html}</button>`); e.onclick = () => fn(e); bar.append(e); return e; };
  btn($t('{0}Конвертировать ▾', icon('refresh')), (e) => contextFor(true, e), 'primary');
  btn($t('{0}Все действия ▾', icon('more')), (e) => contextFor(false, e));
  btn($t('{0}Играть', icon('play')), () => call('playlist.playTrack', { playlistGuid: b.guid, index: b.start }));
  btn(icon('x'), () => hideBatch(), 'icon-only');
  bar.classList.add('on'); document.body.classList.add('batch-on');
}
function hideBatch() { bar.classList.remove('on'); document.body.classList.remove('batch-on'); batch = null; }
