/*
 * Gatefold · ownart.js — covers you chose, kept by Gatefold itself.
 *
 * Some libraries are organised strictly: the cover of an album is not a «cover.jpg» in its folder,
 * or it is a particular one (an LP-proportioned sleeve, a limited Japanese edition) that no search
 * should replace. Here Gatefold keeps:
 *   · covers picked «only in Gatefold» — the picture is stored in Gatefold's own database (a copy up
 *     to 3000 px and a 640 px thumbnail); music files and folders are never touched;
 *   · covers found by your path rule (Settings → Covers: «D:\Covers\%album artist% - %album%») —
 *     only a thumbnail and the path; the full picture is read from your file when it is shown;
 *   · locks: an album whose cover you set (wherever it was saved) is never searched for or replaced.
 * Covers of tracks are looked up by the track's path (every track of the album is remembered), so a
 * playlist row, a tile, Now Playing, the Canvas and the mini player all show the same picture.
 * Other Gatefold windows hear about changes through a BroadcastChannel.
 */
import { call, ok, log } from './bridge.js';
import * as IDB from './idb.js';
import { img as imgOp } from './imgw.js';

const META = 'ownart.meta.v1';
const IMG = (k, kind) => `ownart.${kind}.${k}`;            // kind: 'thumb' | 'full'
export const events = new EventTarget();
let meta = null, loading = null;                           // key → { at, src, where, path, w, h, paths[], dirs[], album, artist }
const byPath = new Map(), byDir = new Map();
const urls = new Map();                                    // `${kind}:${key}` → object URL
const bc = (() => { try { return new BroadcastChannel('gatefold-ownart'); } catch { return null; } })();
const lc = (s) => String(s || '').toLowerCase();
const dirOf = (p) => lc(String(p || '').split('|')[0].replace(/[\\/][^\\/]*$/, ''));

function index() {
  byPath.clear(); byDir.clear();
  for (const [k, m] of Object.entries(meta)) {
    for (const p of m.paths || []) byPath.set(lc(p), k);
    for (const d of m.dirs || []) byDir.set(lc(d), k);
  }
}
/** load the list (once; again when another window changed it) */
export function ready() {
  if (meta) return Promise.resolve();
  return (loading ||= IDB.kvGet(META, {}).then((m) => { meta = m || {}; index(); }));
}
async function reload() {
  meta = (await IDB.kvGet(META, {})) || {}; index();
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  events.dispatchEvent(new Event('change'));
}
if (bc) bc.onmessage = () => reload();
const persist = async () => { await IDB.kvSet(META, meta); index(); events.dispatchEvent(new Event('change')); if (bc) bc.postMessage('change'); };

/** the album a track belongs to, when it has a cover of yours ('' if not) */
export function keyForPath(path) {
  if (!meta || !path) return '';
  const p = lc(path);
  return byPath.get(p) || byPath.get(p.split('|subsong:')[0]) || byDir.get(dirOf(p)) || '';
}
export const get = (key) => (meta && meta[key]) || null;
/** an album whose cover you set: never searched for, never replaced */
export const locked = (key) => !!(meta && meta[key] && meta[key].lock !== false);
/** an album shown with a picture kept here (not one saved into the files) */
export const hasImage = (key) => !!(meta && meta[key] && meta[key].w);

async function blobOf(key, kind) {
  const b = await IDB.kvGet(IMG(key, kind), null);
  if (b) return b;
  const m = meta && meta[key];
  if (kind === 'full' && m && m.path) {                    // a cover of your path rule: read from your file
    const r = await call('file.read', { path: m.path, encoding: 'binary' });
    if (ok(r) && r.content) return imgOp('fromDataUrl', { dataUrl: r.content });
  }
  return kind === 'full' ? IDB.kvGet(IMG(key, 'thumb'), null) : null;
}
/** an object URL of the picture: 'thumb' (≤ 640 px, lists and tiles) or 'full' (Now Playing, Canvas) */
export async function url(key, kind = 'thumb') {
  if (!hasImage(key)) return '';
  const id = kind + ':' + key;
  if (urls.has(id)) return urls.get(id);
  const b = await blobOf(key, kind);
  if (!b) return '';
  const u = URL.createObjectURL(b);
  urls.set(id, u);
  if (kind === 'full' && urls.size > 400) for (const [k, v] of urls) if (k.startsWith('full:') && k !== id) { URL.revokeObjectURL(v); urls.delete(k); break; }
  return u;
}
/** the picture for a track path, or '' */
export async function urlForPath(path, kind = 'thumb') { await ready(); const k = keyForPath(path); return k ? url(k, kind) : ''; }
/** the thumbnails of these paths, ready for a synchronous lookup: get(path) → url | '' */
export async function prepare(paths) {
  await ready();
  const out = new Map();
  if (!byPath.size && !byDir.size) return (p) => '';
  await Promise.all([...new Set(paths.filter(Boolean))].map(async (p) => { const k = keyForPath(p); if (k && hasImage(k)) { const u = await url(k, 'thumb'); if (u) out.set(p, u); } }));
  return (p) => out.get(p) || '';
}

/**
 * Keep a cover for an album.
 *   album: { key, name, artist, paths[] (its tracks), dirs[] (folders that hold only it) }
 *   pic:   { blob } — the picture (stored when where === 'gatefold'), or null for a lock only
 *   where: 'gatefold' (kept here) | 'embedded' | 'file' (saved into the files — only locked here) | 'pattern'
 */
export async function set(album, pic, { where = 'gatefold', src = 'pc', path = '', lock = true } = {}) {
  await ready();
  const m = { at: Date.now(), src, where, path, lock, album: album.name || '', artist: album.artist || '', paths: album.paths || [], dirs: album.dirs || [] };
  if (pic && pic.blob) {
    const d = await imgOp('decode', { blob: pic.blob });
    m.w = d.w; m.h = d.h;
    const thumb = await imgOp('resize', { blob: d.blob, w: d.w, h: d.h, max: 640, quality: 0.9 });
    await IDB.kvSet(IMG(album.key, 'thumb'), thumb.blob);
    if (src !== 'pattern') {                                // a path rule's cover is read from your file when shown
      const full = Math.max(d.w, d.h) > 3000 ? (await imgOp('resize', { blob: d.blob, w: d.w, h: d.h, max: 3000, quality: 0.94 })).blob : d.blob;
      await IDB.kvSet(IMG(album.key, 'full'), full);
    } else await IDB.kvDel(IMG(album.key, 'full'));
  }
  else { await IDB.kvDel(IMG(album.key, 'thumb')); await IDB.kvDel(IMG(album.key, 'full')); }   // a lock only: the files show the cover
  for (const kind of ['thumb', 'full']) { const u = urls.get(kind + ':' + album.key); if (u) { URL.revokeObjectURL(u); urls.delete(kind + ':' + album.key); } }
  meta[album.key] = m;
  await persist();
  log('own cover', album.key, where, src);
  return m;
}
/** forget the cover kept for an album (its files are not touched) */
export async function remove(key) {
  await ready();
  if (!meta[key]) return;
  delete meta[key];
  await IDB.kvDel(IMG(key, 'thumb')); await IDB.kvDel(IMG(key, 'full'));
  for (const kind of ['thumb', 'full']) { const u = urls.get(kind + ':' + key); if (u) { URL.revokeObjectURL(u); urls.delete(kind + ':' + key); } }
  await persist();
}
export const all = () => (meta ? Object.entries(meta).map(([key, m]) => ({ key, ...m })) : []);
