/*
 * Gatefold · artistart.js — artist photos: find, verify, crop, store, serve.
 *
 * Storage: %profile%\aurora\artists\<Artist>.jpg (600×600 JPEG). Any image the
 * user drops there named after the artist (jpg/png/webp) takes precedence and
 * is never overwritten. If the host refuses the write, photos go to IndexedDB.
 *
 * Identity check (the hard part — "Negative", "Extreme", "Nevermore" are each
 * several different bands): a candidate artist is accepted only if one of the
 * user's own albums appears in that artist's discography on the source.
 */
import { call, ok, log, sleep } from './bridge.js';
import { settings, JsonStore } from './settings.js';
import { similarity, cleanAlbum, isVarious } from './match.js';
import { getJSON, download, blobToB64 } from './coverfetch.js';
import { bgCall } from './sched.js';
import { img as imgOp } from './imgw.js';
import * as IDB from './idb.js';

import { $t } from './i18n.js';
export const DIR = '%profile%\\aurora\\artists';
const idx = new JsonStore('aurora.artists.v1', 20000); // key → { s: ok|nf|err, src, t, idb }
export const events = new EventTarget();
const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));
export const astate = { queue: [], busy: null, paused: false, folderAbs: '', files: new Map(), scanned: false, writable: null, lastError: '', session: 0 };
const urls = new Map(); // key → blob: URL ('' = known missing)
// 1.2 migration: errors from 1.1 were mostly the Wikimedia "Invalid URL" bug → retry them now.
try { if (localStorage.getItem('aurora.artists.mig') !== '1.2') { for (const [k, v] of Object.entries(idx.data)) if (v.s === 'err') idx.delete(k); localStorage.setItem('aurora.artists.mig', '1.2'); } } catch {}

export const artistKey = (n) => String(n || '').trim().toLowerCase();
export function fileNameFor(name) {
  let f = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim() || '_';
  if (f.length > 120) f = f.slice(0, 120);
  return f + '.jpg';
}
const stem = (f) => f.replace(/\.(jpe?g|png|webp|gif|bmp)$/i, '').trim().toLowerCase();
const mimeOf = (f) => /\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg';

// ---------------------------------------------------------------- folder index
export async function scanFolder() {
  await call('file.mkdir', { path: DIR });
  const r = await call('file.list', { path: DIR, pattern: '*' });
  astate.files = new Map();
  for (const f of (ok(r) && r.files) || []) if (/\.(jpe?g|png|webp|gif|bmp)$/i.test(f)) astate.files.set(stem(f), f);
  const info = await call('file.getInfo', { path: DIR });
  if (ok(info) && info.exists !== false && info.parent) astate.folderAbs = info.parent.replace(/[\\/]+$/, '') + '\\' + (info.name || 'artists');
  astate.scanned = true;
  emit('change');
}
const fileFor = (name) => astate.files.get(stem(fileNameFor(name))) || astate.files.get(artistKey(name)) || '';

// ---------------------------------------------------------------- IndexedDB fallback
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res) => {
    try {
      const rq = indexedDB.open('aurora-artists', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('img');
      rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}
async function idbGet(k) { const d = await db(); if (!d) return null; return new Promise((res) => { const r = d.transaction('img').objectStore('img').get(k); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); }
async function idbDel(k) { const d = await db(); if (!d) return false; return new Promise((res) => { const t = d.transaction('img', 'readwrite'); t.objectStore('img').delete(k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); }
async function idbPut(k, v) { const d = await db(); if (!d) return false; return new Promise((res) => { const t = d.transaction('img', 'readwrite'); t.objectStore('img').put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); }

// ---------------------------------------------------------------- serving
const reading = new Map();
export function avatarUrl(name) {
  const key = artistKey(name);
  if (urls.has(key)) return Promise.resolve(urls.get(key));
  if (reading.has(key)) return reading.get(key);
  const p = (async () => {
    let url = '';
    const f = fileFor(name);
    if (f) {
      // copy kept in IndexedDB: a grid of 300 artists no longer means 300 file reads on foobar's UI thread
      const c = await IDB.kvGet('av:' + f.toLowerCase());
      if (c && c.b) { url = URL.createObjectURL(c.b); validateAvatar(f, c, key); }
      else {
        const r = await call('file.read', { path: DIR + '\\' + f, encoding: 'binary' });
        if (ok(r) && r.content) {
          const blob = await imgOp('fromDataUrl', { dataUrl: r.content, mime: mimeOf(f) });
          url = URL.createObjectURL(blob);
          IDB.kvSet('av:' + f.toLowerCase(), { b: blob, m: null });
        }
      }
    } else if (idx.get(key)?.idb) {
      const b = await idbGet(key); if (b) url = URL.createObjectURL(b);
    }
    urls.set(key, url); reading.delete(key);
    return url;
  })();
  reading.set(key, p);
  return p;
}

/* Once per session per photo, in the background: if the file in the folder was
   replaced (same name), reload it. The first check only records the baseline. */
const validated = new Set();
async function validateAvatar(f, c, key) {
  const lk = f.toLowerCase();
  if (validated.has(lk)) return;
  validated.add(lk);
  const i = await bgCall('file.getInfo', { path: DIR + '\\' + f });
  if (!ok(i) || i.exists === false) return;
  const m = `${i.modified || 0}:${i.size || 0}`;
  if (c.m === null || c.m === undefined) { IDB.kvSet('av:' + lk, { ...c, m }); return; }
  if (c.m === m) return;
  const r = await bgCall('file.read', { path: DIR + '\\' + f, encoding: 'binary' }, 'normal');
  if (!ok(r) || !r.content) return;
  const blob = await imgOp('fromDataUrl', { dataUrl: r.content, mime: mimeOf(f) });
  IDB.kvSet('av:' + lk, { b: blob, m });
  const url = URL.createObjectURL(blob);
  const old = urls.get(key); urls.set(key, url);
  emit('saved', { name: key, url, src: $t('папка') });
  if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);
}

// ---------------------------------------------------------------- queue
const DAY = 864e5;
function shouldTry(name) {
  const key = artistKey(name);
  if (!name || isVarious(name) || fileFor(name)) return false;
  const st = idx.get(key);
  if (!st) return true;
  const age = Date.now() - (st.t || 0);
  if (st.s === 'ok') return !st.idb && age > DAY;      // file was deleted by the user → refetch later
  if (st.s === 'nf') return age > 30 * DAY;
  if (st.s === 'err') return age > DAY;
  return false;
}

/** artist: { name, albums: [albumName…] } */
export function want(artist, priority = false, force = false) {
  if (!artist || !astate.scanned) return false;
  if (!force && !shouldTry(artist.name)) return false;
  const key = artistKey(artist.name);
  if (astate.busy && artistKey(astate.busy.name) === key) return false;
  const i = astate.queue.findIndex((a) => artistKey(a.name) === key);
  if (i >= 0) { if (!priority) return false; astate.queue.splice(i, 1); }
  priority ? astate.queue.unshift(artist) : astate.queue.push(artist);
  pump();
  return true;
}
export function stats() {
  const c = { ok: 0, nf: 0, err: 0 };
  for (const v of Object.values(idx.data)) c[v.s] = (c[v.s] || 0) + 1;
  c.files = astate.files.size; c.queue = astate.queue.length;
  return c;
}
export function resetNotFound() { for (const [k, v] of Object.entries(idx.data)) if (v.s !== 'ok' && v.s !== 'off') idx.delete(k); emit('change'); }
export function setPaused(p) { astate.paused = p; emit('change'); if (!p) pump(); }

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (astate.queue.length && !astate.paused) {
      const a = astate.queue.shift();
      astate.busy = a; emit('change');
      await processArtist(a);
      astate.busy = null; emit('change');
      await sleep(250);
    }
  } finally { pumping = false; astate.busy = null; emit('change'); }
}

// ---------------------------------------------------------------- finding
const enc = encodeURIComponent;
const unq = (s) => String(s || '').replace(/["\\]/g, ' ').trim();
function verifies(local, titles) {
  if (!local.length || !titles.length) return false;
  return local.some((a) => titles.some((t) => similarity(cleanAlbum(a), cleanAlbum(t)) >= 0.86));
}

async function fromDeezer(a) {
  const j = await getJSON(`https://api.deezer.com/search/artist?q=${enc(a.name)}&limit=10`);
  const cands = ((j && j.data) || [])
    .filter((d) => d.picture_xl && !/\/artist\/\//.test(d.picture_xl)) // empty md5 = silhouette placeholder
    .map((d) => ({ id: d.id, name: d.name, fans: d.nb_fan || 0, url: d.picture_xl, sim: similarity(a.name, d.name) }))
    .filter((d) => d.sim >= 0.86)
    .sort((x, y) => (y.sim - x.sim) || (y.fans - x.fans));
  for (const d of cands.slice(0, 3)) {
    const al = await getJSON(`https://api.deezer.com/artist/${d.id}/albums?limit=100`);
    if (verifies(a.albums, ((al && al.data) || []).map((x) => x.title))) return { url: d.url, src: 'Deezer', verified: true };
  }
  return { unverified: cands };
}

async function fromWikidata(a) {
  const j = await getJSON(`https://musicbrainz.org/ws/2/artist/?query=${enc(`artist:"${unq(a.name)}"`)}&fmt=json&limit=5`);
  const cands = ((j && j.artists) || []).filter((x) => similarity(a.name, x.name) >= 0.9 || (x.aliases || []).some((al) => similarity(a.name, al.name) >= 0.92));
  for (const x of cands.slice(0, 3)) {
    const rg = await getJSON(`https://musicbrainz.org/ws/2/release-group?artist=${x.id}&fmt=json&limit=100`);
    if (!verifies(a.albums, ((rg && rg['release-groups']) || []).map((r) => r.title))) continue;
    const rel = await getJSON(`https://musicbrainz.org/ws/2/artist/${x.id}?inc=url-rels&fmt=json`);
    const wd = ((rel && rel.relations) || []).find((r) => r.type === 'wikidata' && r.url && r.url.resource);
    if (!wd) continue;
    const q = wd.url.resource.split('/').pop();
    const e = await getJSON(`https://www.wikidata.org/wiki/Special:EntityData/${q}.json`);
    const claim = e && e.entities && e.entities[q] && e.entities[q].claims && e.entities[q].claims.P18;
    const file = claim && claim[0] && claim[0].mainsnak && claim[0].mainsnak.datavalue && claim[0].mainsnak.datavalue.value;
    if (!file) continue;
    // Resolve to a direct upload.wikimedia.org thumbnail: Special:FilePath answers
    // with a redirect that the host's HTTP client reports as "Invalid URL".
    const ii = await getJSON(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url&iiurlwidth=900&titles=${enc('File:' + file)}`);
    const page = ii && ii.query && ii.query.pages && Object.values(ii.query.pages)[0];
    const info = page && page.imageinfo && page.imageinfo[0];
    const url = info && (info.thumburl || info.url);
    if (url && /^https:\/\/upload\.wikimedia\.org\//.test(url) && !/\.(svg|tiff?|pdf|djvu)$/i.test(info.url || '')) return { url, src: 'Wikimedia', verified: true };
  }
  return null;
}

async function findImage(a) {
  const dz = await fromDeezer(a);
  if (dz && dz.url) return dz;
  const wd = await fromWikidata(a);
  if (wd) return wd;
  // Last resort: exactly one Deezer artist with this exact name and a real audience.
  const exact = ((dz && dz.unverified) || []).filter((d) => d.sim >= 0.97);
  if (exact.length === 1 && exact[0].fans >= 200) return { url: exact[0].url, src: $t('Deezer · без проверки по альбомам'), verified: false };
  return null;
}

/** Square crop biased upwards (faces sit in the upper part of portraits), 600 px JPEG — in the image worker. */
const squareJpeg = async (blob) => (await imgOp('resize', { blob, max: 600, quality: 0.9, square: true, bias: 0.15 })).blob;

async function processArtist(a) {
  const key = artistKey(a.name);
  try {
    const hit = await findImage(a);
    if (!hit) { idx.set(key, { s: 'nf', t: Date.now() }); return; }
    const img = await download(hit.url);
    const blob = await squareJpeg(img.blob);
    const b64 = await blobToB64(blob);
    const name = fileNameFor(a.name);
    let idb = false;
    if (astate.writable !== false) {
      const w = await bgCall('file.write', { path: DIR + '\\' + name, content: 'base64:' + b64, encoding: 'binary', atomic: true });
      if (ok(w)) { astate.writable = true; astate.files.set(stem(name), name); IDB.kvSet('av:' + name.toLowerCase(), { b: blob, m: null }); validated.add(name.toLowerCase()); }
      else { astate.writable = false; astate.lastError = $t('запись в папку профиля запрещена: ') + (w.error || w.code); log('artist photo write refused → IndexedDB', w); }
    }
    if (astate.writable === false) idb = await idbPut(key, blob);
    idx.set(key, { s: 'ok', t: Date.now(), src: hit.src, idb, v: hit.verified });
    const url = URL.createObjectURL(blob);
    const old = urls.get(key); if (old) URL.revokeObjectURL(old);
    urls.set(key, url);
    astate.session++;
    emit('saved', { name: a.name, url, src: hit.src });
  } catch (e) {
    idx.set(key, { s: 'err', t: Date.now(), e: String(e.message).slice(0, 160) });
    astate.lastError = a.name + ': ' + e.message;
    log('artist photo failed', a.name, e);
  }
}

/** Forget the stored photo so the next want() fetches a fresh one (user-provided files are kept). */
export function refetch(artist) {
  const key = artistKey(artist.name);
  idx.delete(key);
  const f = fileFor(artist.name);
  if (f && f === fileNameFor(artist.name)) { astate.files.delete(stem(f)); IDB.kvDel('av:' + f.toLowerCase()); }
  urls.delete(key);
  return want(artist, true, true);
}

/** a photo for this artist: found, or a file of the user's in the folder */
export const hasPhoto = (name) => !!fileFor(name) || !!urls.get(artistKey(name)) || !!idx.get(artistKey(name))?.idb;

/** «No photo»: a wrong picture goes away and is never looked for again («Find photo again» undoes it).
    The photo Gatefold saved is deleted; a file the user put in the folder goes to the Recycle Bin. */
export async function removePhoto(artist) {
  const key = artistKey(artist.name);
  if (astate.busy && artistKey(astate.busy.name) === key) return false;
  const i = astate.queue.findIndex((a) => artistKey(a.name) === key);
  if (i >= 0) astate.queue.splice(i, 1);
  for (let f = fileFor(artist.name), n = 0; f && n < 4; f = fileFor(artist.name), n++) {   // «Name.jpg» and «name.png» may both be there
    const r = await bgCall('file.delete', { path: DIR + '\\' + f, moveToTrash: f !== fileNameFor(artist.name) }, 'normal');
    if (!ok(r) && r.code !== 'NOT_FOUND') { log('artist photo delete refused', f, r); return false; }
    astate.files.delete(stem(f));
    IDB.kvDel('av:' + f.toLowerCase());
  }
  if (idx.get(key)?.idb) await idbDel(key);
  idx.set(key, { s: 'off', t: Date.now() });
  const old = urls.get(key); urls.set(key, '');
  if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);
  emit('removed', { name: key });
  return true;
}
