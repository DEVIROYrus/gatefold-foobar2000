/*
 * Gatefold · updater.js — one-click updates from GitHub Releases.
 *
 *  check    GET api.github.com/repos/<REPO>/releases/latest (at most every 12 h, or on demand);
 *           a newer tag than VERSION → an update is offered in the sidebar and in Settings.
 *  install  1. downloads gatefold-theme-<v>.zip and SHA256SUMS.txt from the release,
 *           2. verifies the archive's SHA-256 (WebCrypto) — nothing is written otherwise,
 *           3. reads gatefold.json from it: if the release needs a newer foo_ui_webview2 than the one
 *              installed, it offers the full installer instead of half-updating,
 *           4. copies the current template to %profile%\gatefold\backup\<version> (undo),
 *           5. writes every file into the template folder this page was loaded from (atomic writes,
 *              index.html last), and reloads. Any failure restores the backup.
 *  The zip is read with the browser's own DecompressionStream — no library.
 */
import { call, ok, httpGet, log } from './bridge.js';
import { VERSION, REPO } from './version.js';
import { settings } from './settings.js';
import { $t } from './i18n.js';

export const events = new EventTarget();
const KEY = 'aurora.update', DONE = 'aurora.updated', EVERY = 12 * 3600e3;
const BACKUP_ROOT = '%profile%\\gatefold\\backup';
const UA = { 'User-Agent': 'Gatefold-updater', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

export const enabled = () => /^[\w.-]+\/[\w.-]+$/.test(REPO) && !/^OWNER\//i.test(REPO);
export const state = { checking: false, installing: false, stage: '', progress: 0, error: '', info: load() };
function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
function save(v) { state.info = v; try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} }
const emit = () => events.dispatchEvent(new Event('change'));

/** semver compare; a pre-release (1.1.0-rc1) is lower than its release */
export function cmp(a, b) {
  const p = (v) => { const [main, pre = ''] = String(v).replace(/^v/i, '').split('-'); return { n: main.split('.').map((x) => +x || 0), pre }; };
  const A = p(a), B = p(b);
  for (let i = 0; i < 3; i++) { if ((A.n[i] || 0) !== (B.n[i] || 0)) return (A.n[i] || 0) < (B.n[i] || 0) ? -1 : 1; }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1; if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}
/** the release on offer, or null */
export const available = () => (state.info && state.info.version && cmp(state.info.version, VERSION) > 0 ? state.info : null);

export async function check({ force = false } = {}) {
  if (!enabled() || state.checking) return available();
  if (!force && (!settings.updateCheck || (state.info && Date.now() - state.info.checkedAt < EVERY))) return available();
  state.checking = true; state.error = ''; emit();
  try {
    const r = await httpGet({ url: `https://api.github.com/repos/${REPO}/releases/latest`, headers: UA, timeout: 15000 });
    if (!ok(r)) throw new Error(r.error || 'network');
    if (r.status === 404) { save({ checkedAt: Date.now() }); return null; }
    if (r.status >= 400) throw new Error('GitHub ' + r.status);
    const j = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
    const asset = (re) => (j.assets || []).find((a) => re.test(a.name));
    const zip = asset(/^gatefold-theme-.+\.zip$/i), sums = asset(/^SHA256SUMS\.txt$/i), setup = asset(/^Gatefold-Setup-.+\.exe$/i);
    save({
      checkedAt: Date.now(), version: String(j.tag_name || '').replace(/^v/i, ''), name: j.name || '', notes: String(j.body || '').slice(0, 20000),
      date: j.published_at || '', html: j.html_url || `https://github.com/${REPO}/releases`,
      zip: zip ? { name: zip.name, url: zip.browser_download_url, size: zip.size } : null,
      sums: sums ? sums.browser_download_url : '', setup: setup ? setup.browser_download_url : '',
    });
  } catch (e) {
    state.error = e.message || String(e); log('update check', e);
  } finally { state.checking = false; emit(); }
  return available();
}

// ---------------------------------------------------------------- bytes helpers
const b64ToBytes = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
function bytesToB64(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function download(url, base64) {
  const r = await httpGet({ url, timeout: 120000, responseType: base64 ? 'base64' : 'text', headers: { 'User-Agent': 'Gatefold-updater' } });
  if (!ok(r) || (r.status && r.status >= 400)) throw new Error($t('не удалось скачать {0}', url.split('/').pop()) + (r.error ? ' — ' + r.error : r.status ? ' — ' + r.status : ''));
  return r.body;
}

/** minimal ZIP reader: stored and deflated entries, central directory → [{ name, data }] */
async function unzip(u) {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let eocd = -1;
  for (let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip: no central directory');
  const count = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip: bad entry');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(u.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (dv.getUint32(off, true) !== 0x04034b50) throw new Error('zip: bad local header');
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const raw = u.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error('zip: unsupported method ' + method);
    out.push({ name, data });
  }
  // the release archive holds one top folder (gatefold/…) — strip it
  const tops = new Set(out.map((e) => e.name.split('/')[0]));
  if (tops.size === 1 && out.every((e) => e.name.includes('/'))) for (const e of out) e.name = e.name.slice(e.name.indexOf('/') + 1);
  return out;
}

const winPath = (dir, rel) => dir.replace(/[\\/]+$/, '') + '\\' + rel.split('/').filter((s) => s && s !== '..' && s !== '.').join('\\');
async function componentVersion() {
  const r = await call('config.getComponents');
  const c = ok(r) && (r.components || []).find((x) => /foo_ui_webview2/i.test(x.filename || '') || /webview2 ui/i.test(x.name || ''));
  return c ? String(c.version || '') : '';
}

function stage(text, progress) { state.stage = text; if (progress != null) state.progress = progress; emit(); }

export async function install() {
  const info = available();
  if (!info || state.installing) return false;
  state.installing = true; state.error = ''; state.needsSetup = false; stage($t('Скачиваю…'), 0.03);
  let dir = '', backup = '', wrote = 0;
  try {
    const src = await call('webview.getSource');
    dir = ok(src) && src.directory;
    if (!dir) throw new Error($t('Тема загружена не из папки шаблона (сервер разработки или адрес) — обновите её установщиком'));
    if (!info.zip || !info.sums) throw new Error($t('В релизе нет архива темы — скачайте установщик'));

    const zipB64 = await download(info.zip.url, true);
    stage($t('Проверяю контрольную сумму…'), 0.35);
    const sums = await download(info.sums, false);
    const bytes = b64ToBytes(zipB64);
    const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
    const line = String(sums).split(/\r?\n/).find((l) => l.trim().endsWith(info.zip.name));
    if (!line || line.trim().split(/\s+/)[0].toLowerCase() !== digest) throw new Error($t('Контрольная сумма архива не совпала — обновление отменено'));

    stage($t('Распаковываю…'), 0.45);
    const files = await unzip(bytes);
    const get = (n) => files.find((f) => f.name === n);
    const ver = get('js/version.js') && (new TextDecoder().decode(get('js/version.js').data).match(/VERSION = '([^']+)'/) || [])[1];
    if (!get('index.html') || ver !== info.version) throw new Error($t('Архив не похож на Gatefold {0}', info.version));
    const man = get('gatefold.json') ? JSON.parse(new TextDecoder().decode(get('gatefold.json').data)) : {};
    const needComp = man.requires && man.requires.foo_ui_webview2;
    if (needComp) {
      const have = await componentVersion();
      if (have && cmp(have, needComp) < 0) {
        const e = new Error($t('Новой версии нужен компонент WebView2 UI {0} (у вас {1}). Обновите всё установщиком — он сделает это сам.', needComp, have)); e.needsSetup = true; throw e;
      }
    }

    stage($t('Сохраняю резервную копию…'), 0.5);
    await call('file.mkdir', { path: BACKUP_ROOT });
    backup = `${BACKUP_ROOT}\\${VERSION}`;
    const bk = await call('file.copy', { source: dir, destination: backup, overwrite: true });
    if (!ok(bk)) throw new Error($t('Не удалось сохранить резервную копию: {0}', bk.error || bk.code));

    // pages last: a reload mid-way still loads the old index.html
    files.sort((a, b) => (/\.html$/.test(a.name) ? 1 : 0) - (/\.html$/.test(b.name) ? 1 : 0));
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const w = await call('file.write', { path: winPath(dir, f.name), content: 'base64:' + bytesToB64(f.data), encoding: 'binary', atomic: true });
      if (!ok(w)) throw new Error($t('Не удалось записать {0}: {1}', f.name, w.error || w.code));
      wrote++;
      if (i % 4 === 0) stage($t('Устанавливаю… {0} из {1}', i + 1, files.length), 0.55 + 0.4 * (i + 1) / files.length);
    }
    try { localStorage.setItem(DONE, JSON.stringify({ from: VERSION, to: info.version, at: Date.now(), backup, notes: info.notes, html: info.html })); } catch {}
    stage($t('Готово — перезапускаю интерфейс'), 1);
    setTimeout(() => location.reload(), 700);
    return true;
  } catch (e) {
    log('update failed', e);
    if (wrote && backup && dir) await call('file.copy', { source: backup, destination: dir, overwrite: true }).catch(() => {});
    state.error = e.message || String(e); state.needsSetup = !!e.needsSetup;
    state.installing = false; emit();
    return false;
  }
}

/** the update that just happened (shown once after the reload), or null */
export function justUpdated() {
  try { const d = JSON.parse(localStorage.getItem(DONE) || 'null'); return d && d.to === VERSION ? d : null; } catch { return null; }
}
export function ackUpdated() { try { const d = JSON.parse(localStorage.getItem(DONE) || 'null'); if (d) { d.ack = true; localStorage.setItem(DONE, JSON.stringify(d)); } } catch {} }

/** put back the version that was replaced by the last update */
export async function rollback() {
  const d = justUpdated() || (() => { try { return JSON.parse(localStorage.getItem(DONE) || 'null'); } catch { return null; } })();
  if (!d || !d.backup) return false;
  const src = await call('webview.getSource'); const dir = ok(src) && src.directory;
  const ex = await call('file.exists', { path: d.backup });
  if (!dir || !ok(ex) || ex.exists === false) return false;
  const r = await call('file.copy', { source: d.backup, destination: dir, overwrite: true });
  if (!ok(r)) return false;
  try { localStorage.removeItem(DONE); localStorage.removeItem(KEY); } catch {}
  location.reload();
  return true;
}
export const canRollback = () => { try { const d = JSON.parse(localStorage.getItem(DONE) || 'null'); return !!(d && d.backup && d.to === VERSION); } catch { return false; } };

/* tiny, safe Markdown for release notes: headings, lists, bold, code, links */
export function notesHtml(md) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a data-href="$2">$1</a>');
  const out = []; let list = false;
  // the release workflow appends what is bundled and the checksums after this marker — not news
  const body = String(md || '').split(/<!--\s*gatefold:end\s*-->/)[0];
  for (const raw of body.split(/\r?\n/)) {
    const l = raw.trimEnd();
    if (/^```/.test(l) || /^\s*[a-f0-9]{64}\s/.test(l) || /^SHA-?256\b/i.test(l)) continue;   // checksum block
    if (/^#{1,4}\s+\[?v?\d+\.\d+/.test(l)) continue;                          // the CHANGELOG's own «## [1.1.0] — date»
    const li = l.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    const hd = l.match(/^(#{1,4})\s+(.*)/);
    if (hd) out.push(`<h5>${inline(hd[2])}</h5>`); else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}
