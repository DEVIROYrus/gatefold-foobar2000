/*
 * Gatefold · idb.js — one IndexedDB database for everything too big for localStorage
 * (localStorage is capped at ~5 MB for the whole origin and is synchronous).
 *
 *   thumbs  { k, p, s, b:Blob, fp, a, n }   cover thumbnails (thumbcache.js)
 *   kv      key → any                        lyrics cache, quality scan, change journal
 *
 * The database lives in the WebView2 user-data folder on disk, so it survives
 * restarts. Every helper resolves (never rejects): a broken IDB degrades to
 * "no cache", not to a broken UI.
 */
const NAME = 'aurora', VERSION = 1;
let dbp = null;

export function db() {
  if (!dbp) dbp = new Promise((res) => {
    try {
      const rq = indexedDB.open(NAME, VERSION);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains('thumbs')) { const s = d.createObjectStore('thumbs', { keyPath: 'k' }); s.createIndex('a', 'a'); s.createIndex('p', 'p'); }
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      rq.onsuccess = () => { const d = rq.result; d.onversionchange = () => d.close(); res(d); };
      rq.onerror = () => res(null);
      rq.onblocked = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}

const done = (tx) => new Promise((res) => { tx.oncomplete = () => res(true); tx.onerror = () => res(false); tx.onabort = () => res(false); });

export async function kvGet(key, dflt = null) {
  const d = await db(); if (!d) return dflt;
  return new Promise((res) => {
    try { const r = d.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => res(r.result === undefined ? dflt : r.result); r.onerror = () => res(dflt); }
    catch { res(dflt); }
  });
}
export async function kvSet(key, value) {
  const d = await db(); if (!d) return false;
  try { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); return done(tx); } catch { return false; }
}
export async function kvDel(key) {
  const d = await db(); if (!d) return false;
  try { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(key); return done(tx); } catch { return false; }
}

/** Many gets in ONE transaction (a separate transaction per thumbnail costs ~1 ms each). */
export async function getMany(store, keys) {
  const out = new Map();
  const d = await db(); if (!d || !keys.length) return out;
  return new Promise((res) => {
    try {
      const tx = d.transaction(store); const os = tx.objectStore(store);
      for (const k of keys) { const r = os.get(k); r.onsuccess = () => { if (r.result !== undefined) out.set(k, r.result); }; }
      tx.oncomplete = () => res(out); tx.onerror = () => res(out); tx.onabort = () => res(out);
    } catch { res(out); }
  });
}
export async function putMany(store, values) {
  const d = await db(); if (!d || !values.length) return false;
  try { const tx = d.transaction(store, 'readwrite'); const os = tx.objectStore(store); for (const v of values) os.put(v); return done(tx); } catch { return false; }
}
export async function delMany(store, keys) {
  const d = await db(); if (!d || !keys.length) return false;
  try { const tx = d.transaction(store, 'readwrite'); const os = tx.objectStore(store); for (const k of keys) os.delete(k); return done(tx); } catch { return false; }
}
/** Rows whose index `index` equals `value`. */
export async function byIndex(store, index, value) {
  const d = await db(); if (!d) return [];
  return new Promise((res) => {
    try { const r = d.transaction(store).objectStore(store).index(index).getAll(value); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); }
    catch { res([]); }
  });
}
/** Walk an index in ascending order; `fn(value)` returns false to stop. Read-write cursor so callers may delete. */
export async function walk(store, index, fn) {
  const d = await db(); if (!d) return;
  return new Promise((res) => {
    try {
      const tx = d.transaction(store, 'readwrite');
      const rq = tx.objectStore(store).index(index).openCursor();
      rq.onsuccess = () => { const c = rq.result; if (!c) return; if (fn(c.value, c) === false) return; c.continue(); };
      tx.oncomplete = () => res(); tx.onerror = () => res(); tx.onabort = () => res();
    } catch { res(); }
  });
}
export async function clearStore(store) {
  const d = await db(); if (!d) return false;
  try { const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).clear(); return done(tx); } catch { return false; }
}
/** Bytes and rows actually stored (slow-ish full scan; for the settings screen only). */
export async function measure(store) {
  const d = await db(); if (!d) return { n: 0, bytes: 0 };
  return new Promise((res) => {
    let n = 0, bytes = 0;
    try {
      const rq = d.transaction(store).objectStore(store).openCursor();
      rq.onsuccess = () => { const c = rq.result; if (!c) return res({ n, bytes }); n++; bytes += c.value.n || (c.value.b && c.value.b.size) || 0; c.continue(); };
      rq.onerror = () => res({ n, bytes });
    } catch { res({ n, bytes }); }
  });
}

/** Delete every kv entry whose key starts with `prefix` (used to wipe an optional module's data). */
export async function kvDelPrefix(prefix) {
  const d = await db(); if (!d) return 0;
  return new Promise((res) => {
    let n = 0;
    try {
      const tx = d.transaction('kv', 'readwrite');
      const rq = tx.objectStore('kv').openCursor();
      rq.onsuccess = () => { const c = rq.result; if (!c) return; if (String(c.key).startsWith(prefix)) { c.delete(); n++; } c.continue(); };
      tx.oncomplete = () => res(n); tx.onerror = () => res(n);
    } catch { res(0); }
  });
}
