/*
 * Gatefold · thumbcache.js — persistent cover thumbnails (IndexedDB, on disk).
 *
 * Why: foobar decodes a cover on every request. The component's own scaled
 * cache lives in memory and holds 500 entries, so after each start — and
 * whenever a 1700-album library is scrolled past those 500 — every tile means
 * "open the file, extract the picture, decode a 3000 px JPEG, scale, encode".
 * Here each thumbnail is stored once (≈20–60 KB JPEG) and later shown from a
 * blob: URL with no call into foobar at all.
 *
 * Freshness: the component answers the same-origin artwork route with an ETag
 * computed from the art SOURCE files' mtime+size (embedded → the audio file;
 * external → cover.jpg…), and honours If-None-Match with 304 *without decoding*.
 * Each cached thumbnail shown in a session is revalidated once that way in the
 * background; a changed cover is swapped in place. Outside the real host
 * (no ETag) a fingerprint from artwork.getAvailableArtwork + file.getInfo is used.
 *
 * Sizes are snapped to 160/320/480/640 so window resizes don't fragment the cache.
 */
import { call, ok, log, on, sleep } from './bridge.js';
import { settings } from './settings.js';
import * as IDB from './idb.js';
import { fetchArt, heavyTransport } from './artbytes.js';
import { bgCall, slot, spent } from './sched.js';
import { img as imgOp } from './imgw.js';
import * as Loud from './loudness.js';

const SIZES = [160, 320, 480, 640];
export const snap = (s) => SIZES.find((x) => x >= s) || 640;
export const enabled = () => settings.thumbCache !== false && !broken;

const lc = (p) => String(p || '').toLowerCase();
const keyOf = (path, size) => lc(path) + '|' + size;

export const events = new EventTarget();
export const tstate = { hits: 0, misses: 0, stored: 0, checked: 0, refreshed: 0, removed: 0, bytes: 0, count: 0, metaLoaded: false };
let broken = false;           // fetch of artwork URLs impossible (CORS / scheme) → cache disabled for the session

// ---------------------------------------------------------------- blob URL pool (memory)
const MEM_MAX = 900;
const mem = new Map(); // key → blob: URL, insertion order = LRU
function memGet(k) { const u = mem.get(k); if (u) { mem.delete(k); mem.set(k, u); } return u; }
function memSet(k, u) {
  const old = mem.get(k); if (old && old !== u) URL.revokeObjectURL(old);
  mem.delete(k); mem.set(k, u);
  while (mem.size > MEM_MAX) { const [ok0, ou] = mem.entries().next().value; mem.delete(ok0); URL.revokeObjectURL(ou); }
}
function memDrop(k) { const u = mem.get(k); if (u) { mem.delete(k); setTimeout(() => URL.revokeObjectURL(u), 5000); } }

// ---------------------------------------------------------------- size bookkeeping
const META = 'aurora.thumbs.meta';
try { const m = JSON.parse(localStorage.getItem(META) || 'null'); if (m) { tstate.bytes = m.bytes || 0; tstate.count = m.count || 0; tstate.metaLoaded = true; } } catch {}
let metaT = 0;
function metaAdd(dBytes, dCount) {
  tstate.bytes = Math.max(0, tstate.bytes + dBytes); tstate.count = Math.max(0, tstate.count + dCount);
  clearTimeout(metaT); metaT = setTimeout(() => { try { localStorage.setItem(META, JSON.stringify({ bytes: tstate.bytes, count: tstate.count })); } catch {} }, 800);
}
export async function remeasure() {
  const m = await IDB.measure('thumbs');
  tstate.bytes = m.bytes; tstate.count = m.n; tstate.metaLoaded = true;
  try { localStorage.setItem(META, JSON.stringify({ bytes: m.bytes, count: m.n })); } catch {}
  return m;
}
const limitBytes = () => Math.max(50, settings.thumbCacheMB || 400) * 1048576;
let evicting = false;
async function evictIfNeeded() {
  if (evicting || tstate.bytes <= limitBytes()) return;
  evicting = true;
  try {
    const target = limitBytes() * 0.85;
    let freed = 0, n = 0; const need = tstate.bytes - target;
    await IDB.walk('thumbs', 'a', (v, c) => { if (freed >= need) return false; freed += v.n || 0; n++; memDrop(v.k); c.delete(); return true; });
    metaAdd(-freed, -n);
    log(`thumb cache: evicted ${n} (${(freed / 1048576).toFixed(1)} MB)`);
  } finally { evicting = false; }
}

// ---------------------------------------------------------------- lookup (display path)
/**
 * Cached thumbnails for `paths` at snapped `size`. Returns Map path → blob: URL
 * for hits only. Hits not yet validated in this session are queued for a
 * background revalidation.
 */
export async function lookup(paths, size) {
  const out = new Map();
  if (!enabled() || !paths.length) return out;
  const want = [];
  for (const p of paths) {
    if (!p) continue;
    const k = keyOf(p, size), u = memGet(k);
    if (u) { out.set(p, u); tstate.hits++; queueCheck(p, size); } else want.push(p);
  }
  if (!want.length) return out;
  const rows = await IDB.getMany('thumbs', want.map((p) => keyOf(p, size)));
  const touch = [];
  const now = Date.now();
  for (const p of want) {
    const k = keyOf(p, size), v = rows.get(k);
    if (!v || !v.b) { tstate.misses++; continue; }
    const u = URL.createObjectURL(v.b);
    memSet(k, u); out.set(p, u); tstate.hits++;
    if (now - (v.a || 0) > 864e5) { v.a = now; touch.push(v); }
    queueCheck(p, size, v.c || v.a || 0);
  }
  if (touch.length) IDB.putMany('thumbs', touch);
  return out;
}

// ---------------------------------------------------------------- capture (after a miss displayed from foobar)
const capQ = [];
const capKeys = new Set();
/** Called once an <img> successfully showed `url` (an fb2k:// artwork URL) for (path, size). */
export function capture(path, size, url) {
  if (!enabled() || !path || !url || /^(blob|data):/i.test(url)) return;
  const k = keyOf(path, size);
  if (capKeys.has(k) || mem.has(k)) return;
  capKeys.add(k); capQ.push({ path, size, url, k });
  pumpCap();
}
let capRunning = 0;
async function pumpCap() {
  // Through the bridge every capture moves the ORIGINAL picture over IPC: one at a time, only when idle.
  while (capRunning < (heavyTransport() ? 1 : 2) && capQ.length) {
    capRunning++;
    const j = capQ.shift();
    (async () => {
      try {
        // never compete with scrolling: wait for a quiet moment, then account the host time
        const pri = heavyTransport() ? 'low' : 'normal';
        await slot(pri);
        const t = performance.now();
        await store(j.path, j.size, j.url);
        spent(heavyTransport() ? performance.now() - t : 3, pri);
      }
      catch (e) { log('thumb capture failed', e.message); }
      finally { capKeys.delete(j.k); capRunning--; pumpCap(); }
    })();
  }
}

async function fetchThumb(url, etag, path) {
  let r;
  try { r = await fetchArt(url, { etag, path }); }
  catch (e) { if (!broken) { broken = true; log('thumb cache disabled: no way to read artwork bytes', e.message); } throw e; }
  if (r.status === 304) return { same: true };
  if (r.status === 404) return { missing: true };
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  return { blob: r.blob, etag: r.etag || '' };
}

/** Big originals (when the art is already smaller than the requested size the host sends it as is) are re-encoded — in the image worker. */
async function compact(blob, size) {
  if (blob.size <= 160 * 1024) return blob;
  try { return (await imgOp('resize', { blob, max: size, quality: 0.88 })).blob; } catch { return blob; }
}

/** Own fingerprint of the art sources — only used when the host gives no ETag. */
async function fingerprint(path) {
  const a = await bgCall('artwork.getAvailableArtwork', { path });
  if (!ok(a)) return '';
  const src = (a.sources || []).map(String);
  const dir = String(path).replace(/[\\/][^\\/]*$/, '');
  const parts = [src.join(',')];
  for (const s of src) {
    const target = s === 'embedded' ? path : s.startsWith('folder:') ? dir + '\\' + s.slice(7) : '';
    if (!target) continue;
    const i = await bgCall('file.getInfo', { path: target });
    parts.push(ok(i) && i.exists !== false ? `${i.modified || 0}:${i.size || 0}` : '?');
  }
  return parts.join('|');
}

async function store(path, size, url) {
  const res = await fetchThumb(url, '', path);
  if (!res.blob) return;
  const blob = await compact(res.blob, size);
  // no ETag (cross-origin transport): the source fingerprint is taken later, by the
  // low-priority revalidation — never on the display path
  const k = keyOf(path, size);
  const old = (await IDB.getMany('thumbs', [k])).get(k);
  const row = { k, p: lc(path), s: size, b: blob, e: res.etag, fp: res.etag ? '' : null, a: Date.now(), c: Date.now(), n: blob.size };
  if (await IDB.putMany('thumbs', [row])) {
    metaAdd(blob.size - (old ? old.n || 0 : 0), old ? 0 : 1);
    tstate.stored++;
    checkedAt.set(k, Date.now());
    evictIfNeeded();
  }
}

// ---------------------------------------------------------------- revalidation (background)
/* Each thumbnail is re-checked at most once a day (persisted), plus immediately-ish
   when foobar reports that its track changed (metadb:changed carries paths; play
   count updates from the statistics hook are ignored). All checks go through the
   low-priority budget in sched.js. */
const RECHECK = 864e5;
const checkedAt = new Map();      // key → last check (ms), mirrors row.c
const due = new Set();            // lower-cased paths whose files changed
const chkQ = [];
const chkKeys = new Set();
function queueCheck(path, size, c) {
  const k = keyOf(path, size);
  if (c !== undefined && !checkedAt.has(k)) checkedAt.set(k, c || 0);
  if (chkKeys.has(k)) return;
  if (!due.has(lc(path)) && Date.now() - (checkedAt.get(k) || 0) < RECHECK) return;
  chkKeys.add(k); chkQ.push({ path, size, k, changed: due.has(lc(path)) });
  pumpChk();
}
let chkRunning = false;
async function pumpChk() {
  if (chkRunning) return;
  chkRunning = true;
  try {
    while (chkQ.length) {
      const j = chkQ.shift();
      try { await slot('low'); await revalidate(j); }
      catch (e) { log('thumb check failed', e.message); }
      finally { chkKeys.delete(j.k); checkedAt.set(j.k, Date.now()); due.delete(lc(j.path)); }
    }
  } finally { chkRunning = false; }
}
async function revalidate({ path, size, k, changed }) {
  const row = (await IDB.getMany('thumbs', [k])).get(k);
  if (!row) return;
  tstate.checked++;
  const r = await bgCall('artwork.getFb2kUrlByPath', { path, maxSize: size });
  const url = ok(r) && r.dataUrl;
  if (!url) return;
  let res;
  if (row.e) { const t = performance.now(); res = await fetchThumb(url, row.e, path); spent(performance.now() - t); }
  else {
    const fp = await fingerprint(path);
    if ((row.fp === null || row.fp === undefined) && !changed) { // routine first check: record the baseline
      await IDB.putMany('thumbs', [{ ...row, fp, c: Date.now() }]); return;
    }
    if (fp && fp === row.fp) res = { same: true };
    else { await slot('low'); const t = performance.now(); res = await fetchThumb(url + (url.includes('?') ? '&' : '?') + 'tc=' + Date.now(), '', path); spent(performance.now() - t); }
  }
  if (res.same) { IDB.putMany('thumbs', [{ ...row, c: Date.now() }]); return; }
  const oldUrl = mem.get(k) || '';
  if (res.missing) {
    await IDB.delMany('thumbs', [k]); metaAdd(-(row.n || 0), -1); memDrop(k); tstate.removed++;
    events.dispatchEvent(new CustomEvent('updated', { detail: { path, size, oldUrl, url: '' } }));
    return;
  }
  const blob = await compact(res.blob, size);
  const fp = res.etag ? '' : await fingerprint(path);
  await IDB.putMany('thumbs', [{ ...row, b: blob, e: res.etag, fp, a: Date.now(), c: Date.now(), n: blob.size }]);
  metaAdd(blob.size - (row.n || 0), 0);
  const nu = URL.createObjectURL(blob); memSet(k, nu);
  tstate.refreshed++;
  events.dispatchEvent(new CustomEvent('updated', { detail: { path, size, oldUrl, url: nu } }));
}

// ---------------------------------------------------------------- invalidation
/** Forget every size of one track's thumbnail (its cover was just replaced). */
export async function forget(path) {
  const rows = await IDB.byIndex('thumbs', 'p', lc(path));
  if (rows.length) { await IDB.delMany('thumbs', rows.map((r) => r.k)); metaAdd(-rows.reduce((s, r) => s + (r.n || 0), 0), -rows.length); }
  for (const s of SIZES) { const k = keyOf(path, s); memDrop(k); checkedAt.delete(k); }
}
/** Forget all thumbnails in a folder (shared folders: one cover file affected every album in it). */
export async function forgetDir(dir) {
  const pre = lc(dir).replace(/[\\/]+$/, '') + '\\';
  const ks = [];
  let freed = 0;
  await IDB.walk('thumbs', 'p', (v, c) => { if (v.p.startsWith(pre) && !v.p.slice(pre.length).includes('\\')) { ks.push(v.k); freed += v.n || 0; c.delete(); } return true; });
  if (ks.length) metaAdd(-freed, -ks.length);
  for (const k of ks) { memDrop(k); checkedAt.delete(k); }
}
export async function clear() {
  await IDB.clearStore('thumbs');
  for (const k of [...mem.keys()]) memDrop(k);
  checkedAt.clear();
  tstate.bytes = 0; tstate.count = 0; metaAdd(0, 0);
}
/* A track's file changed (tag editor, embedded art…) → its thumbnail is due for a check.
   Play-count updates from the statistics hook don't touch the picture. */
on('metadb:changed', (d) => {
  if (!d || d.fromHook || performance.now() < Loud.writingUntil) return;   // ReplayGain tags, not pictures
  for (const t of d.tracks || []) if (t && t.path) due.add(lc(t.path));
});
