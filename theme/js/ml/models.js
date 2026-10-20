/*
 * Gatefold · ml/models.js — fetching the sound-analysis models, once, on request.
 *
 * The models (Discogs-EffNet and its heads, Music Technology Group UPF, CC BY-NC-SA 4.0) are not
 * part of Gatefold: they are published by this repository's «ML assets» workflow on the
 * `ml-assets` branch and downloaded only when the user turns the feature on. Every file is checked
 * against the SHA-256 in manifest.json and kept in IndexedDB, so it is downloaded once.
 * Sources: raw.githubusercontent.com (allows fetch with progress); the `ml-models-1` release
 * through foobar2000's own HTTP client as a fallback.
 */
import { httpGet, ok, log } from '../bridge.js';
import { REPO } from '../version.js';
import * as IDB from '../idb.js';

const HOME = 'DEVIROYrus/gatefold-foobar2000';
const repo = () => (/^[\w.-]+\/[\w.-]+$/.test(REPO) && !/^OWNER\//i.test(REPO) ? REPO : HOME);
export const sources = () => [`https://raw.githubusercontent.com/${repo()}/ml-assets/models/`, `https://github.com/${repo()}/releases/download/ml-models-1/`];
const K_MAN = 'ml.manifest', K_FILE = (n) => 'ml.file.' + n;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (buf) => hex(await crypto.subtle.digest('SHA-256', buf));
const b64ToBytes = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

async function getBytes(name, size, onBytes) {
  const [raw, rel] = sources();
  try {
    const r = await fetch(raw + name, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!r.body) return await r.arrayBuffer();
    const reader = r.body.getReader(); const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length; onBytes(got);
    }
    const out = new Uint8Array(got); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out.buffer;
  } catch (e) {
    log('ml fetch → release', name, e.message || e);
    const r = await httpGet({ url: rel + name, timeout: 600000, responseType: 'base64', headers: { 'User-Agent': 'Gatefold' } });
    if (!ok(r) || (r.status && r.status >= 400)) throw new Error(`${name}: ${r.error || r.status || 'network'}`);
    const u = b64ToBytes(r.body); onBytes(size || u.length);
    return u.buffer;
  }
}

async function getText(name) {
  const [raw, rel] = sources();
  try { const r = await fetch(raw + name, { cache: 'no-store' }); if (r.ok) return await r.text(); throw new Error('HTTP ' + r.status); }
  catch (e) {
    const r = await httpGet({ url: rel + name, timeout: 30000, headers: { 'User-Agent': 'Gatefold' } });
    if (!ok(r) || (r.status && r.status >= 400)) throw new Error(`${name}: ${r.error || r.status || e.message || 'network'}`);
    return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  }
}

/** the files one analysis needs */
export const needed = (m) => [m.ort.file, m.effnet.file, ...m.heads.map((h) => h.file)].filter((f, i, a) => a.indexOf(f) === i && m.files[f]);
export const totalBytes = (m) => needed(m).reduce((s, f) => s + (m.files[f].size || 0), 0);

/** the manifest: the stored one, refreshed from the network when `refresh` (or none is stored) */
export async function manifest(refresh = false) {
  const stored = await IDB.kvGet(K_MAN, null);
  if (stored && !refresh) return stored;
  try {
    const m = JSON.parse(await getText('manifest.json'));
    if (!m || !m.effnet || !m.files) throw new Error('bad manifest');
    await IDB.kvSet(K_MAN, m);
    return m;
  } catch (e) { if (stored) return stored; throw e; }
}

/** every model file in memory, downloading what is missing; onProgress(doneBytes, totalBytes) */
export async function load(onProgress = () => {}, { refresh = false } = {}) {
  const m = await manifest(refresh);
  const files = needed(m);
  const total = totalBytes(m);
  let base = 0;
  const out = {};
  for (const f of files) {
    const want = m.files[f];
    let row = await IDB.kvGet(K_FILE(f), null);
    if (!row || row.sha !== want.sha256) {
      const buf = await getBytes(f, want.size, (n) => onProgress(base + n, total));
      const got = await sha256(buf);
      if (got !== want.sha256) throw new Error(`${f}: checksum mismatch`);
      row = { sha: got, buf };
      await IDB.kvSet(K_FILE(f), row);
      await IDB.kvSet('ml.sha.' + f, got);
    }
    out[f] = row.buf;
    base += want.size; onProgress(base, total);
  }
  return { manifest: m, models: out, id: (m.files[m.effnet.file].sha256 || '').slice(0, 12) };
}

/** are all files already on disk (no download needed)? */
export async function present() {
  const m = await IDB.kvGet(K_MAN, null);
  if (!m) return false;
  for (const f of needed(m)) if ((await IDB.kvGet('ml.sha.' + f, '')) !== m.files[f].sha256) return false;
  return true;
}

export async function remove() { await IDB.kvDelPrefix('ml.file.'); await IDB.kvDelPrefix('ml.sha.'); await IDB.kvDel(K_MAN); }
