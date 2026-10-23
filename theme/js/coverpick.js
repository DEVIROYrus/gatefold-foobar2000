/*
 * Gatefold · coverpick.js — «Album cover»: choose the picture, then where it goes.
 *
 * Where the picture comes from:
 *   · a file on your computer (the system dialog), dropped on the window, or pasted (Ctrl+V);
 *   · what the album already has: images in its folder and pictures embedded in its tracks;
 *   · the web (iTunes, Deezer, MusicBrainz), only when you ask.
 * Where it goes, asked every time (the last answer is offered first):
 *   · only in Gatefold — kept in Gatefold's database; music files and folders are not touched;
 *   · into the tags of the album's tracks;
 *   · a file next to the tracks, under the name you give it.
 * Whatever you choose, the cover is yours: Gatefold never searches for or replaces it again.
 *
 * And for libraries where covers live elsewhere by a fixed rule: a path pattern in title formatting
 * («D:\Covers\%album artist% - %album%») finds them for the whole library (patternScan).
 */
import { call, ok, esc, log } from './bridge.js';
import { h, icon, toast } from './ui.js';
import { settings, setSetting } from './settings.js';
import { $t } from './i18n.js';
import { img as imgOp } from './imgw.js';
import * as CF from './coverfetch.js';
import * as Own from './ownart.js';

const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];
const dirOf = (p) => String(p || '').split('|')[0].replace(/[\\/][^\\/]*$/, '');
const extOf = (mime) => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' }[mime] || 'jpg');
let veil = null, S = null;

async function readFile(path) {
  const r = await call('file.read', { path, encoding: 'binary' });
  if (!ok(r) || !r.content) throw new Error(r.error || $t('не удалось прочитать файл'));
  return imgOp('fromDataUrl', { dataUrl: r.content });
}
/** decode and measure; refuses what is not a picture */
async function picture(blob, src, label = '') {
  const d = await imgOp('decode', { blob });
  return { blob: d.blob, w: d.w, h: d.h, mime: d.mime, src, label, url: URL.createObjectURL(d.blob) };
}

/* ---------------------------------------------------------------- the sheet */
export async function open(a) {
  const job = CF.jobFromAlbum(a);
  if (!job) { toast($t('Этот альбом не на локальном диске — сохранить обложку некуда')); return; }
  await Own.ready();
  S = { a, job, pick: null, found: [], web: null, token: (S ? S.token : 0) + 1 };
  if (!veil) build();
  render();
  requestAnimationFrame(() => veil.classList.add('on'));
  loadAlbumImages(S.token);
}
export function close() {
  if (veil) veil.classList.remove('on');
  if (S) {
    const keep = S.pick && S.pick.url;
    for (const x of [...S.found, ...(S.web || [])]) if (x.url && x.url.startsWith('blob:') && x.url !== keep) URL.revokeObjectURL(x.url);
    if (keep) setTimeout(() => URL.revokeObjectURL(keep), 60000);       // the toast still shows it
  }
  S = null;
}

function build() {
  veil = h(`<div class="upd-veil cp-veil"><div class="upd-sheet cp-sheet" role="dialog" aria-modal="true" aria-label="${$t('Обложка альбома')}">
    <button class="icon-btn upd-x" title="${$t('Закрыть')}">${icon('x', 16)}</button><div class="cp-body"></div></div></div>`);
  document.body.append(veil);
  veil.addEventListener('click', (e) => { if (e.target === veil || e.target.closest('.upd-x')) close(); });
  addEventListener('keydown', (e) => { if (veil.classList.contains('on') && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
  // a picture pasted or dropped anywhere on the sheet
  addEventListener('paste', async (e) => {
    if (!veil.classList.contains('on') || e.target.closest?.('input')) return;
    const it = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith('image/'));
    if (!it) return;
    e.preventDefault();
    try { choose(await picture(it.getAsFile(), 'paste', $t('Из буфера обмена'))); } catch (err) { toast(esc(err.message)); }
  });
  veil.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((x) => x.kind === 'file')) { e.preventDefault(); veil.classList.add('drop'); } });
  veil.addEventListener('dragleave', (e) => { if (e.target === veil) veil.classList.remove('drop'); });
  veil.addEventListener('drop', async (e) => {
    veil.classList.remove('drop');
    const f = [...(e.dataTransfer?.files || [])].find((x) => /^image\//.test(x.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(x.name));
    if (!f) return;
    e.preventDefault(); e.stopPropagation();
    try { choose(await picture(f, 'pc', f.name)); } catch (err) { toast(esc(err.message)); }
  });
}

function render() {
  if (!S) return;
  const { a, job, pick } = S;
  const own = Own.get(job.key);
  const body = veil.querySelector('.cp-body');
  body.innerHTML = `
    <div class="cp-head"><div class="kicker">${$t('Обложка альбома')}</div><h3>${esc(a.name)}${a.edition ? ` <span class="cp-ed">${esc(a.edition)}</span>` : ''}</h3><div class="sub">${esc(job.artist)}</div></div>
    <div class="cp-main">
      <div class="cp-preview${pick ? '' : ' empty'}">${pick ? `<img src="${esc(pick.url)}" alt=""><div class="cp-dim">${pick.w}×${pick.h}${pick.label ? ' · ' + esc(pick.label) : ''}</div>` : `<div class="cp-drop">${icon('image', 28)}<b>${$t('Перетащите картинку сюда')}</b><span>${$t('или вставьте из буфера: Ctrl+V')}</span></div>`}</div>
      <div class="cp-side">
        <div class="cp-srcs">
          <button class="btn" data-a="file">${icon('folder')}${$t('С компьютера…')}</button>
          <button class="btn" data-a="web">${icon('search')}${$t('Найти в интернете')}</button>
          ${own ? `<button class="btn ghost" data-a="forget" title="${$t('Gatefold забудет эту обложку; файлы не меняются')}">${icon('x')}${$t('Убрать мою обложку')}</button>` : ''}
        </div>
        ${own ? `<div class="cp-note">${icon('check', 14)}${own.src === 'pattern' ? $t('Обложка по вашему правилу пути') : $t('Обложка выбрана вами — Gatefold её не заменит')}</div>` : ''}
        ${pick ? whereHtml() : ''}
      </div>
    </div>
    <div class="cp-grid-h">${$t('У альбома уже есть')}</div>
    <div class="cp-grid" data-g="found">${S.found.length ? S.found.map(tile).join('') : `<div class="cp-none">${S.foundLoading ? '<span class="spinner"></span>' : $t('Картинок в папке и в тегах нет')}</div>`}</div>
    ${S.web ? `<div class="cp-grid-h">${$t('В интернете')}</div><div class="cp-grid" data-g="web">${S.webLoading ? '<div class="cp-none"><span class="spinner"></span></div>' : S.web.length ? S.web.map(tile).join('') : `<div class="cp-none">${$t('Ничего не найдено')}</div>`}</div>` : ''}`;
  body.querySelectorAll('.cp-tile').forEach((el) => { el.onclick = () => takeTile(el.dataset.g || el.closest('[data-g]').dataset.g, +el.dataset.i); });
  body.querySelector('[data-a=file]').onclick = fromPc;
  body.querySelector('[data-a=web]').onclick = searchWeb;
  const fg = body.querySelector('[data-a=forget]');
  if (fg) fg.onclick = async () => { await Own.remove(job.key); toast($t('Gatefold больше не держит свою обложку для «{0}»', esc(a.name))); render(); };
  const save = body.querySelector('[data-a=save]');
  if (save) {
    body.querySelectorAll('input[name=cpw]').forEach((r) => { r.onchange = () => { body.querySelector('.cp-fname').hidden = r.value !== 'file' || !r.checked; }; });
    save.onclick = () => commit(body.querySelector('input[name=cpw]:checked').value, body.querySelector('.cp-fname input').value.trim());
  }
}
const tile = (x, i) => `<button class="cp-tile${S.pick && S.pick.url === x.url ? ' on' : ''}" data-i="${i}" title="${esc(x.label || '')}"><img src="${esc(x.thumb || x.url)}" alt="" loading="lazy"><span>${x.w ? `${x.w}×${x.h}` : esc(x.res ? $t('до {0}px', x.res) : '')}${x.src ? ' · ' + esc(x.srcName || x.src) : ''}</span></button>`;
function whereHtml() {
  const last = settings.coverPickTarget || 'gatefold';
  const opt = (v, title, sub) => `<label class="cp-w"><input type="radio" name="cpw" value="${v}"${last === v ? ' checked' : ''}><span><b>${title}</b><small>${sub}</small></span></label>`;
  return `<div class="cp-where"><div class="cp-wh">${$t('Куда сохранить')}</div>
    ${opt('gatefold', $t('Только в Gatefold'), $t('Файлы и папки с музыкой не меняются'))}
    ${opt('embedded', $t('В теги треков'), $t('Обложка внутри файлов — её увидят и другие программы'))}
    ${opt('file', $t('Файлом рядом с треками'), $t('Под именем, которое вы зададите'))}
    <div class="cp-fname"${last === 'file' ? '' : ' hidden'}><input class="st-input" spellcheck="false" value="${esc(settings.coverPickName || 'cover')}" aria-label="${$t('Имя файла')}"><span>.${extOf(S.pick.mime)}</span></div>
    <button class="btn primary" data-a="save">${icon('check')}${$t('Сохранить')}</button></div>`;
}
function choose(p) { if (!S) return; S.pick = p; render(); }
async function takeTile(g, i) {
  const x = (g === 'web' ? S.web : S.found)[i]; if (!x) return;
  try {
    if (x.blob) return choose(x);
    const el = veil.querySelector(`[data-g="${g}"] [data-i="${i}"]`); if (el) el.classList.add('busy');
    const blob = x.path ? await readFile(x.path) : (await CF.download(x.url)).blob;
    choose(await picture(blob, x.src, x.label));
  } catch (e) { toast($t('Не подошла: ') + esc(e.message)); render(); }
}

async function fromPc() {
  const r = await call('dialog.openFile', { title: $t('Обложка для «{0}»', S.a.name), defaultPath: settings.coverPickDir || dirOf(S.job.path), filters: [{ name: $t('Картинки'), extensions: IMG_EXT }] });
  if (!ok(r) || r.canceled || !(r.filePaths || []).length) return;
  const path = r.filePaths[0];
  setSetting('coverPickDir', dirOf(path));
  try { choose(await picture(await readFile(path), 'pc', path.split(/[\\/]/).pop())); } catch (e) { toast(esc(e.message)); }
}

async function loadAlbumImages(token) {
  S.foundLoading = true;
  const out = [];
  // pictures embedded in the first track, by type
  const types = [['front', $t('в тегах: обложка')], ['back', $t('в тегах: задник')], ['disc', $t('в тегах: диск')]];
  for (const [type, label] of types) {
    const r = await call('artwork.getByPath', { path: S.job.path, type });
    if (!S || token !== S.token) return;
    if (ok(r) && r.available !== false && r.dataUrl) {
      try { const blob = await imgOp('fromDataUrl', { dataUrl: r.dataUrl }); out.push({ ...(await picture(blob, 'tag', label)), srcName: $t('теги') }); } catch {}
    }
  }
  // image files in the album's folder (and its disc folders' parent)
  for (const dir of [...new Set([dirOf(S.job.path), dirOf(dirOf(S.job.path))])]) {
    const r = await call('artwork.getFolderImages', { directory: dir });
    if (!S || token !== S.token) return;
    for (const im of (ok(r) && r.images) || []) {
      if (out.some((x) => x.path === im.path)) continue;
      try { out.push({ ...(await picture(await readFile(im.path), 'folder', im.name)), path: im.path, srcName: im.name }); } catch {}
      if (out.length >= 12) break;
    }
  }
  S.found = out; S.foundLoading = false;
  render();
}
async function searchWeb() {
  S.web = []; S.webLoading = true; render();
  const token = S.token;
  const cands = await CF.findCandidates(S.job, { exhaustive: true }).catch(() => []);
  if (!S || token !== S.token) return;
  S.web = cands.slice(0, 18).map((c) => ({ url: c.url, thumb: c.thumb, res: c.res, src: 'web', srcName: c.src, label: `${c.title} — ${c.artist}${c.year ? ' · ' + c.year : ''}` }));
  S.webLoading = false;
  render();
}

async function commit(where, fname) {
  const { job, pick, a } = S;
  const btn = veil.querySelector('[data-a=save]'); btn.disabled = true; btn.classList.add('busy');
  setSetting('coverPickTarget', where);
  try {
    const paths = await CF.albumPaths(job);
    const album = { key: job.key, name: job.album, artist: job.artist, paths, dirs: [] };
    if (where === 'embedded') {
      const b64 = await imgOp('b64', { blob: pick.blob });
      const res = await CF.embedIntoAlbum(job, { ...pick, b64 });
      log('cover embedded', res.via);
    } else if (where === 'file') {
      const name = (fname || 'cover').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'cover';
      setSetting('coverPickName', name);
      const r = await call('metadata.embedArtwork', { path: job.path, imageData: await imgOp('b64', { blob: pick.blob }), type: 'front', target: ['file'], filename: `${name}.${extOf(pick.mime)}` });
      if (!ok(r)) throw new Error(r.error || r.code || '?');
      album.dirs = [];
    }
    // the picture stays in Gatefold too (a file under your own name is not one foobar2000 looks for),
    // and the album is locked: never searched for or replaced again
    await Own.set(album, { blob: pick.blob }, { where, src: pick.src || 'pc', lock: true });
    toast($t('Обложка «{0}» сохранена', esc(a.name)), { img: pick.url });
    close();
  } catch (e) { toast($t('Не удалось сохранить: ') + esc(e.message)); btn.disabled = false; btn.classList.remove('busy'); }
}

/* ---------------------------------------------------------------- your path rule, for the whole library */
export const scanState = { running: false, done: 0, total: 0, found: 0, error: '' };
/** the path the rule gives for a track (without extension) — for the preview in Settings */
export async function patternFor(path, pattern = settings.coverPattern) {
  if (!pattern || !path) return '';
  const r = await call('titleformat.evalFieldsBatch', { paths: [path], fields: { p: pattern.replace(/\.\*$/, '') } });
  return ok(r) && r.results && r.results[0] ? String(r.results[0].p || '') : '';
}
const dirCache = new Map();
async function findImage(base) {
  const dir = dirOf(base), name = base.slice(dir.length + 1).toLowerCase();
  if (!dirCache.has(dir)) {
    const r = await call('file.list', { path: dir });
    dirCache.set(dir, new Map(((ok(r) && r.files) || []).map((f) => [f.toLowerCase(), f])));
  }
  const files = dirCache.get(dir);
  for (const e of IMG_EXT) { const f = files.get(`${name}.${e}`); if (f) return `${dir}\\${f}`; }
  return '';
}
/** every album of the library: a picture at the rule's path becomes its cover (kept as a thumbnail + the path) */
export async function patternScan(albums, { onProgress } = {}) {
  const pattern = settings.coverPattern;
  if (!pattern || scanState.running) return;
  Object.assign(scanState, { running: true, done: 0, total: albums.length, found: 0, error: '' });
  dirCache.clear();
  await Own.ready();
  try {
    for (let i = 0; i < albums.length; i += 400) {
      const part = albums.slice(i, i + 400).filter((a) => a.firstTrackAbsolutePath);
      const r = await call('titleformat.evalFieldsBatch', { paths: part.map((a) => a.firstTrackAbsolutePath), fields: { p: pattern.replace(/\.\*$/, '') } });
      if (!ok(r)) throw new Error(r.error || $t('шаблон не разобран'));
      for (let k = 0; k < part.length; k++) {
        const a = part[k], base = String((r.results[k] || {}).p || '').trim();
        scanState.done++;
        if (!base || /\?/.test(base)) continue;
        const file = await findImage(base);
        if (!file) continue;
        const job = CF.jobFromAlbum(a); if (!job) continue;
        const had = Own.get(job.key);
        if (had && (had.src !== 'pattern' || had.path === file)) { scanState.found++; continue; }   // yours already / unchanged
        try {
          const blob = await readFile(file);
          await Own.set({ key: job.key, name: job.album, artist: job.artist, paths: await CF.albumPaths(job), dirs: [] }, { blob }, { where: 'pattern', src: 'pattern', path: file, lock: true });
          scanState.found++;
        } catch (e) { log('cover rule', file, e.message); }
        if (onProgress && scanState.done % 20 === 0) onProgress();
      }
      if (onProgress) onProgress();
    }
  } catch (e) { scanState.error = e.message; }
  finally { scanState.running = false; if (onProgress) onProgress(); }
}
