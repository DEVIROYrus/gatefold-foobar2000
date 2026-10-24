/*
 * Gatefold · coverfetch.js — finds and installs missing album art.
 *
 * Flow per album:
 *   sources (rate-limited, sequential):  iTunes (≤3000 px) → Deezer (1000 px) → MusicBrainz + Cover Art Archive (1200 px)
 *   score every candidate (match.js) → auto-accept ≥ threshold, review queue 0.6…threshold, otherwise "not found"
 *   download through the host (no CORS) → validate (decodes, ≥ min size, ~square, not blank) → optional downscale
 *   save: metadata.embedArtwork target "file" → cover.jpg beside the tracks (foobar's own media-write path)
 *         fallback: PowerShell Invoke-WebRequest straight into the album folder
 * Triggers: the playing album (immediately) + an idle background sweep of the library.
 */
import { call, ok, on, log, sleep, albumKeyOf, plural, bumpArtV, artUrl, httpGet } from './bridge.js';
import { bgCall, slot, spent } from './sched.js';
import { img as imgOp } from './imgw.js';
import * as IDB from './idb.js';
import { settings, JsonStore } from './settings.js';
import { scoreCandidate, cleanAlbum, queryArtist, isVarious } from './match.js';

import { $t } from './i18n.js';
import * as Own from './ownart.js';
const UA = 'GatefoldFoobarTheme/1.0 (foobar2000 WebView2 theme; cover art lookup)';
const store = new JsonStore('aurora.covers.v1', 30000);       // key → { s, t, src, w, h, sc }
const review = new JsonStore('aurora.covers.review.v1', 400); // key → { job, cands }
const LOG_KEY = 'aurora.covers.log.v1';
let history = []; try { history = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch {}

export const events = new EventTarget();
const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));

export const state = { queue: [], busy: null, paused: false, sweeping: false, sweepDone: false, diagRunning: false, repairing: false, scanned: 0, total: 0, checked: 0, missing: 0, withArt: 0, skipped: 0, sessionSaved: 0, lastError: '' };

const DAY = 864e5;
function shouldTry(key) {
  const st = store.get(key);
  if (!st) return true;
  const age = Date.now() - (st.t || 0);
  if (st.s === 'ok') return age > 7 * DAY;          // we saved one; if art vanished, try again later
  if (st.s === 'nf') return age > 30 * DAY;
  if (st.s === 'err') return age > DAY;
  return false;                                       // 'rev' / 'skip' wait for the user
}
const isLocal = (p) => /^[a-z]:\\|^\\\\/i.test(p || '');

let logT = 0;
function pushLog(entry) {
  history.unshift({ ...entry, t: Date.now() });
  history = history.slice(0, 120);
  clearTimeout(logT); logT = setTimeout(saveLog, 2500);
  emit('change');
}
function saveLog() { clearTimeout(logT); try { localStorage.setItem(LOG_KEY, JSON.stringify(history)); } catch {} }
addEventListener('pagehide', saveLog);
export const getLog = () => history;
export const getReview = () => Object.entries(review.data).map(([key, v]) => ({ key, ...v }));
export function getStats() {
  const c = { ok: 0, nf: 0, err: 0, rev: 0, skip: 0 };
  for (const v of Object.values(store.data)) c[v.s] = (c[v.s] || 0) + 1;
  return c;
}

// ------------------------------------------------------------------ network
const GAP = { 'itunes.apple.com': 3200, 'api.deezer.com': 250, 'musicbrainz.org': 1100, 'coverartarchive.org': 350, 'www.wikidata.org': 300, 'commons.wikimedia.org': 300, 'lrclib.net': 150, 'labs.api.listenbrainz.org': 500 };
const lastHit = {};
async function throttle(url) {
  let host = ''; try { host = new URL(url).host; } catch {}
  // the slot is reserved before waiting, so callers running side by side (covers, artist photos,
  // genres) still keep to the host's rate instead of all firing when the same wait ends
  const now = Date.now(), at = Math.max(now, (lastHit[host] || 0) + (GAP[host] || 250));
  lastHit[host] = at;
  if (at > now) await sleep(at - now);
}
function backoff(url, ms) { try { lastHit[new URL(url).host] = Date.now() + ms; } catch {} }

/* WinHTTP rejects non-ASCII / unescaped characters with "Invalid URL"; the URL
   parser percent-encodes them exactly once. */
export function safeUrl(url) {
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw 0; return u.href; }
  catch { throw new Error('Invalid URL: ' + String(url).slice(0, 120)); }
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return '?'; } };
const header = (r, name) => { const h = r && r.headers; if (!h) return ''; if (typeof h === 'string') { const m = h.match(new RegExp('^' + name + ':\\s*(.+)$', 'im')); return m ? m[1].trim() : ''; } for (const k of Object.keys(h)) if (k.toLowerCase() === name) return String(h[k]); return ''; };

export async function getJSON(url) {
  try { url = safeUrl(url); } catch (e) { state.lastError = e.message; return null; }
  await throttle(url);
  const r = await httpGet({ url, timeout: 20000, headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!ok(r)) { state.lastError = r.error || 'http error'; return null; }
  if (r.status === 403 || r.status === 429 || r.status === 503) { backoff(url, 60000); return null; }
  if (r.status && r.status >= 400) return null;
  try { return typeof r.body === 'string' ? JSON.parse(r.body) : r.body; } catch { return null; }
}

// ------------------------------------------------------------------ sources
const enc = encodeURIComponent;
const unq = (s) => String(s || '').replace(/["\\]/g, ' ').trim();

async function fromItunes(job) {
  const out = [];
  const term = (isVarious(job.artist) ? '' : queryArtist(job.artist) + ' ') + cleanAlbum(job.album);
  const countries = String(settings.coverCountries || 'US').split(/[,\s]+/).filter(Boolean).slice(0, 4);
  for (const c of countries) {
    const j = await getJSON(`https://itunes.apple.com/search?term=${enc(term)}&media=music&entity=album&limit=12&country=${enc(c)}`);
    for (const r of (j && j.results) || []) {
      if (!r.artworkUrl100) continue;
      const base = r.artworkUrl100.replace(/\/[^/]+$/, '');
      out.push({ src: 'iTunes ' + c.toUpperCase(), title: r.collectionName, artist: r.artistName, year: String(r.releaseDate || '').slice(0, 4),
        tracks: r.trackCount, url: base + '/3000x3000bb.jpg', thumb: base + '/300x300bb.jpg', res: 3000 });
    }
    if (out.some((x) => scoreCandidate(job, x).score >= 0.93)) break; // good enough, spare the next storefront
  }
  return out;
}

async function fromDeezer(job) {
  const va = isVarious(job.artist);
  const strict = va ? `album:"${unq(cleanAlbum(job.album))}"` : `artist:"${unq(queryArtist(job.artist))}" album:"${unq(cleanAlbum(job.album))}"`;
  let j = await getJSON(`https://api.deezer.com/search/album?q=${enc(strict)}&limit=12`);
  if (!j || !j.data || !j.data.length) j = await getJSON(`https://api.deezer.com/search/album?q=${enc((va ? '' : queryArtist(job.artist) + ' ') + cleanAlbum(job.album))}&limit=12`);
  return ((j && j.data) || [])
    .filter((d) => d.cover_xl && !/\/cover\/\//.test(d.cover_xl)) // empty md5 = Deezer's grey placeholder
    .map((d) => ({ src: 'Deezer', title: d.title, artist: d.artist && d.artist.name, tracks: d.nb_tracks, url: d.cover_xl, thumb: d.cover_medium || d.cover_xl, res: 1000 }));
}

async function fromMusicBrainz(job) {
  const va = isVarious(job.artist);
  const q = va ? `releasegroup:"${unq(cleanAlbum(job.album))}"` : `releasegroup:"${unq(cleanAlbum(job.album))}" AND artist:"${unq(queryArtist(job.artist))}"`;
  const j = await getJSON(`https://musicbrainz.org/ws/2/release-group/?query=${enc(q)}&fmt=json&limit=8`);
  return ((j && j['release-groups']) || []).map((rg) => ({
    src: 'MusicBrainz', title: rg.title,
    artist: (rg['artist-credit'] || []).map((a) => (a.name || '') + (a.joinphrase || '')).join('') || '',
    year: String(rg['first-release-date'] || '').slice(0, 4),
    url: `https://coverartarchive.org/release-group/${rg.id}/front-1200`, thumb: `https://coverartarchive.org/release-group/${rg.id}/front-250`, res: 1200,
  }));
}

export async function findCandidates(job, { exhaustive = false } = {}) {
  const thr = settings.coverThreshold;
  const srcs = settings.coverSources;
  let all = [];
  const add = (list) => {
    for (const c of list) {
      if (all.some((x) => x.url === c.url)) continue;
      all.push({ ...c, ...scoreCandidate(job, c) });
    }
    all.sort((a, b) => b.score - a.score);
  };
  const best = () => (all[0] ? all[0].score : 0);
  if (srcs.itunes) add(await fromItunes(job));
  if (srcs.deezer && (exhaustive || best() < thr + 0.08)) add(await fromDeezer(job));
  if (srcs.musicbrainz && (exhaustive || best() < thr)) add(await fromMusicBrainz(job));
  return all;
}

// ------------------------------------------------------------------ image handling
/* Decoding, validation, resizing and base64 all run in js/imgworker.js. */
export const blobToB64 = (blob) => imgOp('b64', { blob });

export async function download(url) {
  url = safeUrl(url);
  let r;
  for (let hop = 0; ; hop++) {
    await throttle(url);
    r = await httpGet({ url, responseType: 'base64', timeout: 45000, headers: { 'User-Agent': UA } });
    if (!ok(r)) throw new Error((r.error || 'download failed') + ' · ' + hostOf(url));
    const loc = r.status >= 300 && r.status < 400 ? header(r, 'location') : '';
    if (!loc || hop >= 4) break;
    url = safeUrl(new URL(loc, url).href);   // host may not follow redirects itself
  }
  if (r.status && r.status >= 400) throw new Error('HTTP ' + r.status + ' · ' + hostOf(url));
  if (typeof r.body !== 'string') throw new Error('empty image');
  return imgOp('decode', { b64: r.body });   // → { blob, mime, w, h, std, size, b64 }
}

function validate(img) {
  const min = settings.coverMinSize || 0;
  if (Math.min(img.w, img.h) < min) return $t('слишком маленькая ({0}×{1})', img.w, img.h);
  const ar = img.w / img.h;
  if (ar < 0.85 || ar > 1.18) return $t('не квадратная ({0}×{1})', img.w, img.h);
  if (img.std < 3.5) return $t('пустая/заглушка');
  return '';
}

async function maybeDownscale(img) {
  const max = settings.coverMaxSize || 0;
  if (!max || Math.max(img.w, img.h) <= max) return img;
  return { ...img, ...(await imgOp('resize', { blob: img.blob, w: img.w, h: img.h, max, quality: 0.93, wantB64: true })) };
}

export const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
/** PowerShell, started without making foobar2000 wait for it: a wait inside the host (waitForExitMs)
 *  blocks foobar2000's UI thread for as long as the command runs — up to the whole download, the window
 *  «Not responding». The result is checked from here instead: `done()` every 700 ms, until it says yes
 *  or `ms` pass. → whether `done()` said yes */
export async function powershell(cmd, ms, done) {
  const sp = await call('shell.spawn', { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], hidden: true });
  if (!ok(sp)) return false;
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { await sleep(700); if (await done()) return true; }
  return false;
}
/** a file that exists, is not empty and has stopped growing (a download or a copy that has finished) */
export function fileSettled(path, since = 0) {
  let last = -1;
  return async () => {
    const i = await call('file.getInfo', { path });
    if (!ok(i) || !i.exists || !(i.size > 0) || (since && (i.modified || 0) + 1000 < since)) return false;
    const same = i.size === last; last = i.size; return same;
  };
}
// ------------------------------------------------------------------ folder ownership
/*
 * foobar2000 resolves external art per DIRECTORY: a cover.jpg applies to every
 * track in that folder and overrides embedded art. Writing one into a folder
 * that holds several albums re-covers all of them (the 1.1 bug). So we keep an
 * index  folder → albums  and only ever write sidecar files into folders that
 * belong to exactly one album. Shared folders get the art embedded into the
 * album's own tracks instead.
 */
const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');
const lc = (x) => String(x || '').toLowerCase();
let dirIdx = null, dirIdxT = 0, dirIdxP = null;
export async function getDirIndex(fresh = false) {
  if (!fresh && dirIdx && Date.now() - dirIdxT < 10 * 60e3) return dirIdx;
  if (dirIdxP) return dirIdxP;
  dirIdxP = (async () => {
    const m = new Map();
    for (let off = 0; off < 400000; off += 1000) {
      const r = await call('library.getAlbums', { offset: off, limit: 1000, sort: 'name' });
      if (!ok(r)) break;
      for (const a of r.albums || []) {
        const d = dirOf(a.firstTrackAbsolutePath);
        if (!d) continue;
        let e = m.get(lc(d));
        if (!e) m.set(lc(d), e = { dir: d, keys: new Set() });
        e.keys.add(albumKeyOf(a.albumArtist || a.artist, a.name));
      }
      if (!r.hasMore) break;
    }
    dirIdx = m; dirIdxT = Date.now(); dirIdxP = null;
    return m;
  })();
  return dirIdxP;
}
['library:itemsAdded', 'library:itemsRemoved', 'library:itemsModified'].forEach((ev) => on(ev, () => { dirIdx = null; }));

/** How many OTHER albums keep their first track in this job's folder. */
export async function otherAlbumsInDir(job) {
  const m = await getDirIndex();
  const e = m.get(lc(dirOf(job.path)));
  return e ? [...e.keys].filter((k) => k !== job.key).length : 0;
}

async function downscaleTo(img, max) {
  if (Math.max(img.w, img.h) <= max) return img.b64 ? img : { ...img, b64: await blobToB64(img.blob) };
  return { ...img, ...(await imgOp('resize', { blob: img.blob, w: img.w, h: img.h, max, quality: 0.92, wantB64: true })) };
}

export async function embedIntoAlbum(job, img) {
  const small = await downscaleTo(img, 1400); // embedded copies live in every track — keep them lean
  let tracks = [];
  for (const p of job.parts || [{ name: job.album, albumArtist: job.artist }]) {      // every part of a merged album
    const r = await bgCall('library.getAlbumTracks', { album: p.name, albumArtist: p.albumArtist }, 'normal');
    if (ok(r)) tracks.push(...(r.tracks || r.items || []));
  }
  if (!tracks.length) tracks = [{ absolutePath: job.path }];
  let n = 0, err = '';
  const done = [];
  for (const t of tracks) {
    const p = t.handle || t.absolutePath;
    // album_art_editor rewrites the file on foobar's UI thread — one track per slot, paced
    const e = await bgCall('metadata.embedArtwork', { path: p, imageData: small.b64, type: 'front', target: ['embedded'] }, 'normal');
    if (ok(e)) { n++; done.push(p); } else err = e.error || e.code || '';
  }
  if (!n) throw new Error($t('не удалось встроить обложку в треки: ') + err);
  return { via: $t('встроено в {0} {1} (общая папка)', n, plural(n, 'трек', 'трека', 'треков')), savedTo: '', tracks: done };
}

/** an album's tracks (every part of a merged one) — for covers kept by Gatefold and for embedding */
export async function albumPaths(job) {
  if (job.paths && job.paths.length) return job.paths;      // an edition: exactly its own tracks
  const out = [];
  for (const p of job.parts || [{ name: job.album, albumArtist: job.artist }]) {
    const r = await bgCall('library.getAlbumTracks', { album: p.name, albumArtist: p.albumArtist }, 'normal');
    if (ok(r)) for (const t of r.tracks || r.items || []) out.push(t.handle || (t.subsong ? `${t.absolutePath}|subsong:${t.subsong}` : t.absolutePath));
  }
  return out.length ? out : [job.path];
}
/** keep the picture in Gatefold only: music files and folders stay as they are (ownart.js) */
async function keepInGatefold(job, img, { lock = false, src = 'web' } = {}) {
  const paths = await albumPaths(job);
  const dirs = (await otherAlbumsInDir(job)) === 0 ? [dirOf(job.path)] : [];
  await Own.set({ key: job.key, name: job.album, artist: job.artist, paths, dirs }, { blob: img.blob }, { where: 'gatefold', src, lock });
  return { via: $t('только в Gatefold'), savedTo: '' };
}

async function save(job, img, url) {
  if (settings.coverTarget === 'gatefold') return keepInGatefold(job, img);
  if (settings.coverTarget === 'embedded') {
    if (job.fromSweep) return keepInGatefold(job, img);          // the sweep does not rewrite tracks (see below)
    if (!img.b64) img = { ...img, b64: await blobToB64(img.blob) }; return embedIntoAlbum(job, img);
  }
  const others = await otherAlbumsInDir(job);
  if (others > 0) {
    // a folder shared by several albums (a folder of singles, a «Downloads»): the background sweep never
    // rewrites those tracks one by one — on a big library that was thousands of files rewritten on
    // foobar2000's UI thread. It keeps the cover in Gatefold; the playing album follows your setting.
    if (job.fromSweep) return keepInGatefold(job, img);
    if (settings.coverSharedDir === 'skip') throw new Error($t('папка общая для {0} альбомов — cover.jpg испортил бы их обложки (включите встраивание в треки)', others + 1));
    return embedIntoAlbum(job, img);
  }
  // the background sweep writes only cover.jpg (a small file); putting the picture into the tracks
  // themselves rewrites every file on foobar2000's UI thread, so that is left to what you ask for
  const target = settings.coverTarget === 'all' && !job.fromSweep ? ['all'] : ['file'];
  if (!img.b64) img = { ...img, b64: await blobToB64(img.blob) };
  const r = await bgCall('metadata.embedArtwork', { path: job.path, imageData: img.b64, type: 'front', target }, 'normal');
  if (ok(r)) return { via: 'foobar', savedTo: r.savedTo || (r.results && r.results.file && r.results.file.savedTo) || '' };
  const dir = dirOf(job.path);
  const dest = dir + '\\cover.jpg';
  // the picture is already here: written straight into the folder when the host allows it
  const w = await bgCall('file.write', { path: dest, content: 'base64:' + img.b64, encoding: 'binary', atomic: true }, 'normal');
  if (ok(w)) return { via: 'file', savedTo: dest };
  // a folder foobar2000 cannot write to: the sweep keeps the cover in Gatefold (nothing else to try in
  // the background); for the album you are looking at, PowerShell gets one go — without a wait in the host
  if (job.fromSweep) { log('cover: folder not writable, kept in Gatefold', dir, r.code || r.error); return keepInGatefold(job, img); }
  log('embedArtwork refused, falling back to PowerShell:', r.code, r.error);
  const t0 = Date.now();
  const cmd = `$ProgressPreference='SilentlyContinue';[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;` +
    `if(-not (Test-Path -LiteralPath ${psq(dest)})){Invoke-WebRequest -UseBasicParsing -Uri ${psq(url)} -OutFile ${psq(dest)}}`;
  if (await powershell(cmd, 45000, fileSettled(dest, t0))) return { via: 'powershell', savedTo: dest };
  throw new Error($t('не удалось сохранить: ') + (r.error || w.error || 'unknown'));
}

// ------------------------------------------------------------------ diagnosis & repair of 1.1 damage
export let diag = null; // { sharedDirs, files:[{path,dir,albums,modified}], foreign:[...] }
function auroraEpoch() {
  let t = Infinity;
  for (const e of history) if (e.t) t = Math.min(t, e.t);
  for (const v of Object.values(store.data)) if (v.t) t = Math.min(t, v.t);
  return Number.isFinite(t) ? t - 2 * 3600e3 : Infinity;
}
const COVERNAME = /^(cover|folder|front)\.(jpe?g|png|webp|gif|bmp)$/i;

/** Find cover files Gatefold wrote into folders shared by several albums. Read-only. */
export async function diagnoseSharedCovers() {
  state.diagRunning = true; emit('change');
  try {
    const m = await getDirIndex(true);
    const since = auroraEpoch();
    const out = { sharedDirs: 0, files: [], foreign: [], at: Date.now() };
    for (const e of m.values()) {
      if (e.keys.size < 2) continue;
      out.sharedDirs++;
      const r = await bgCall('artwork.getFolderImages', { directory: e.dir });
      for (const im of (ok(r) && r.images) || []) {
        const name = String(im.name || im.path || '').split(/[\\/]/).pop();
        if (!COVERNAME.test(name)) continue;
        const path = im.path || e.dir + '\\' + name;
        const info = await bgCall('file.getInfo', { path });
        const modified = ok(info) ? +info.modified || 0 : 0;
        (modified >= since ? out.files : out.foreign).push({ path, dir: e.dir, albums: e.keys.size, modified });
      }
    }
    diag = out;
    log('shared-folder diagnosis', JSON.stringify({ sharedDirs: out.sharedDirs, ours: out.files.length, foreign: out.foreign.length }));
    return out;
  } finally { state.diagRunning = false; emit('change'); }
}

export async function recycle(path) {
  const r = await call('file.delete', { path, moveToTrash: true });
  if (ok(r)) return true;
  const cmd = `Add-Type -AssemblyName Microsoft.VisualBasic;[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${psq(path)},'OnlyErrorDialogs','SendToRecycleBin')`;
  return powershell(cmd, 15000, async () => { const i = await call('file.getInfo', { path }); return ok(i) && !i.exists; });
}

/** Move wrongly placed covers to the Recycle Bin and re-queue the affected albums. */
export async function repairSharedCovers({ includeForeign = false } = {}) {
  const d = diag || await diagnoseSharedCovers();
  const files = includeForeign ? d.files.concat(d.foreign) : d.files;
  state.repairing = true; emit('change');
  let moved = 0, failed = 0;
  const m = await getDirIndex();
  try {
    for (const f of files) {
      if (await recycle(f.path)) moved++; else failed++;
      const e = m.get(lc(f.dir));
      if (e) { for (const k of e.keys) { store.delete(k); review.delete(k); } forgetSeen([...e.keys]); }
    }
  } finally { state.repairing = false; }
  bumpArtV();
  diag = null;
  pushLog({ s: moved ? 'ok' : 'err', artist: 'Gatefold', album: $t('Исправление общих папок: в Корзину {0}, ошибок {1}', moved, failed) });
  emit('repaired', { moved, failed });
  return { moved, failed };
}

/** an album whose cover you set yourself (wherever it was saved): never searched for or replaced again */
export async function lockCover(job, where) {
  await Own.set({ key: job.key, name: job.album, artist: job.artist, paths: await albumPaths(job), dirs: [] }, null, { where, src: 'manual', lock: true });
}
export async function applyCandidate(job, cand, { manual = false } = {}) {
  let img = await download(cand.url);
  const bad = validate(img);
  if (bad) throw new Error(bad);
  img = await maybeDownscale(img);
  if (manual) job = { ...job, fromSweep: false };                  // your click: saved the way the settings say
  const saved = manual && settings.coverTarget === 'gatefold' ? await keepInGatefold(job, img, { lock: true, src: 'web' }) : await save(job, img, cand.url);
  if (manual && settings.coverTarget !== 'gatefold') await lockCover(job, settings.coverTarget === 'embedded' ? 'embedded' : 'file');
  const objUrl = URL.createObjectURL(img.blob);
  store.set(job.key, { s: 'ok', t: Date.now(), src: cand.src, w: img.w, h: img.h, sc: +(cand.score || 0).toFixed(3) });
  review.delete(job.key);
  state.sessionSaved++;
  pushLog({ s: 'ok', artist: job.artist, album: job.album, src: cand.src, w: img.w, h: img.h, sc: cand.score, thumb: cand.thumb, via: saved.via });
  emit('saved', { job, url: objUrl, cand, savedTo: saved.savedTo });
  setTimeout(() => URL.revokeObjectURL(objUrl), 120000);
  return { img, saved, url: objUrl };
}

// ------------------------------------------------------------------ queue
export function jobFromTrack(t) {
  if (!t || !t.album || !isLocal(t.path)) return null;
  return { key: albumKeyOf(t.albumArtist, t.album), artist: t.albumArtist || t.artist, album: t.album, year: t.year, tracks: 0, path: t.path };
}
export function jobFromAlbum(a) {
  const artist = a.albumArtist || a.artist || '';
  if (!a.name || !isLocal(a.firstTrackAbsolutePath)) return null;
  // an edition of an album (library.js) has its own key and exactly its own tracks
  return { key: a.edKey || albumKeyOf(artist, a.name), artist, album: a.name, year: String(a.year || '').slice(0, 4), tracks: a.trackCount || 0, path: a.firstTrackAbsolutePath, parts: a.parts || null, paths: a.edPaths || null, edition: a.edition || '' };
}

export function enqueue(job, priority = false, force = false) {
  if (!job) return false;
  if (!force && !shouldTry(job.key)) return false;
  if (state.busy && state.busy.key === job.key) return false;
  const i = state.queue.findIndex((j) => j.key === job.key);
  if (i >= 0) { if (!priority) return false; state.queue.splice(i, 1); }
  priority ? state.queue.unshift(job) : state.queue.push(job);
  emit('change');
  pump();
  return true;
}

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (state.queue.length && !state.paused) {
      const job = state.queue.shift();
      state.busy = job; emit('change');
      await processJob(job);
      state.busy = null; emit('change');
      await sleep(job.fromSweep ? 1200 : 200);
    }
  } finally { pumping = false; state.busy = null; emit('change'); }
}

async function processJob(job) {
  const thr = settings.coverThreshold;
  try {
    await Own.ready();
    if (Own.get(job.key) || Own.keyForPath(job.path)) {
      // a cover you set or Gatefold keeps for this album: nothing to look for
      store.set(job.key, { s: 'ok', t: Date.now(), src: $t('ваша обложка') });
      return;
    }
    if (!job.force && (await otherAlbumsInDir(job)) === 0 && await folderHasCover(job.path)) {
      // a cover file exists but foobar didn't match it (pattern settings / cache) — never overwrite it
      store.set(job.key, { s: 'ok', t: Date.now(), src: $t('папка') });
      pushLog({ s: 'ok', artist: job.artist, album: job.album, src: $t('уже есть файл в папке — проверьте шаблоны Album art') });
      return;
    }
    const cands = await findCandidates(job);
    const good = cands.filter((c) => c.score >= thr);
    if (good.length) {
      // within 0.04 of the best score, prefer the highest resolution source
      const top = good[0].score;
      const ordered = good.filter((c) => c.score >= top - 0.04).sort((a, b) => b.res - a.res).concat(good.filter((c) => c.score < top - 0.04));
      let lastErr = '';
      for (const c of ordered.slice(0, 4)) {
        try { await applyCandidate(job, c); return; } catch (e) { lastErr = e.message; log('candidate rejected', c.src, e.message); }
      }
      throw new Error(lastErr || $t('все кандидаты отклонены'));
    }
    const maybe = cands.filter((c) => c.score >= 0.6);
    if (maybe.length) {
      review.set(job.key, { job, cands: cands.slice(0, 8).map(({ src, title, artist, year, tracks, url, thumb, res, score }) => ({ src, title, artist, year, tracks, url, thumb, res, score })) });
      store.set(job.key, { s: 'rev', t: Date.now(), sc: +maybe[0].score.toFixed(3) });
      pushLog({ s: 'rev', artist: job.artist, album: job.album, src: maybe[0].src, sc: maybe[0].score, thumb: maybe[0].thumb });
      emit('review', { job });
      return;
    }
    store.set(job.key, { s: 'nf', t: Date.now() });
    pushLog({ s: 'nf', artist: job.artist, album: job.album });
  } catch (e) {
    store.set(job.key, { s: 'err', t: Date.now() });
    state.lastError = e.message;
    pushLog({ s: 'err', artist: job.artist, album: job.album, err: e.message });
  }
}

export function skipReview(key) {
  review.delete(key);
  store.set(key, { s: 'skip', t: Date.now() });
  emit('change');
}
export function resetStatus(which) {
  for (const [k, v] of Object.entries(store.data)) if (!which || v.s === which) store.delete(k);
  if (!which) for (const k of Object.keys(review.data)) review.delete(k);
  emit('change');
}
export function setPaused(p) { state.paused = p; emit('change'); if (!p) pump(); }

// ------------------------------------------------------------------ art detection
/*
 * Why two signals: artwork.getFb2kUrl* only *builds* a fb2k:// URL — it can
 * report "available" for albums with no art at all (the tile then fails to
 * load and shows initials). So we ask the album-art extractor directly
 * (getAvailableArtwork: embedded + external files) and confirm by actually
 * loading a 48 px thumbnail, exactly like the UI does.
 */
const FRONT = /front|cover|folder|album/i;
function parseAvailability(r) {
  if (!ok(r)) return null;
  if (r.available === false) return false;
  const lists = [r.artworks, r.sources, r.types].filter(Array.isArray);
  if (lists.length) {
    const items = lists.flat();
    if (!items.length) return false;
    return items.some((it) => {
      if (typeof it === 'string') return FRONT.test(it) || !/back|disc|icon|artist/i.test(it);
      if (!it || it.available === false) return false;
      const t = String(it.type || it.kind || it.name || it.label || it.source || '');
      return !t || FRONT.test(t) || !/back|disc|icon|artist/i.test(t);
    });
  }
  return r.available === true ? true : null;
}

function probeImage(url, timeout = 8000) {
  return new Promise((res) => {
    const im = new Image();
    const tm = setTimeout(() => { im.src = ''; res(null); }, timeout);
    im.onload = () => { clearTimeout(tm); res(im.naturalWidth > 1); };
    im.onerror = () => { clearTimeout(tm); res(false); };
    im.src = url;
  });
}

let shapeLogged = false;
/** Slow, authoritative check (opens the files on foobar's UI thread) — only for doubtful cases. */
async function availability(path, priority = 'low') {
  const a = await bgCall('artwork.getAvailableArtwork', { path }, priority);
  if (!shapeLogged && ok(a)) { shapeLogged = true; log('getAvailableArtwork shape:', JSON.stringify(a).slice(0, 300)); }
  return parseAvailability(a);
}
export async function hasArt(path) {
  await Own.ready();
  if (Own.keyForPath(path)) return true;                  // a cover you chose (ownart.js)
  const u = await bgCall('artwork.getFb2kUrlByPath', { path, maxSize: 48 }, 'normal');
  const probe = ok(u) && u.dataUrl ? await probeImage(artUrl(u.dataUrl)) : null;
  if (probe === true) return true;
  const v = await availability(path, 'normal');
  return v === null ? probe !== false : v;
}

/* Albums known to have art — remembered across sessions so a restart doesn't
   re-check 2000 albums. Re-checked after 30 days; a tile that fails to load
   reports its album at once anyway (reportMissing). */
const SEEN_TTL = 30 * DAY;
let seen = null, seenDirty = false, seenT = 0;
async function loadSeen() { if (!seen) seen = new Map(Object.entries((await IDB.kvGet('covers.seen.v1')) || {})); return seen; }
function markSeen(key) { seen.set(key, Date.now()); seenDirty = true; clearTimeout(seenT); seenT = setTimeout(saveSeen, 4000); }
function saveSeen() { if (!seen || !seenDirty) return; seenDirty = false; IDB.kvSet('covers.seen.v1', Object.fromEntries(seen)); }
addEventListener('pagehide', saveSeen);
export async function forgetSeen(keys) { await loadSeen(); let n = 0; for (const k of [].concat(keys)) if (seen.delete(k)) n++; if (n) { seenDirty = true; saveSeen(); } }

/** Images that foobar's default patterns would pick up already sitting in the folder. */
async function folderHasCover(path) {
  const dir = path.replace(/[\\/][^\\/]*$/, '');
  const r = await bgCall('artwork.getFolderImages', { directory: dir }, 'normal');
  const imgs = ok(r) ? (r.images || []) : [];
  return imgs.some((x) => /^(cover|folder|front|albumart\w*)\.(jpe?g|png|webp|gif|bmp)$/i.test(String(typeof x === 'string' ? x : x.name || x.path || '').split(/[\\/]/).pop()));
}

/** Called by the UI whenever a cover visibly fails to load. */
export function reportMissing(job) {
  if (!job || Own.locked(job.key)) return false;
  forgetSeen(job.key);
  if (!(settings.coverAuto || settings.coverSweep)) return false;
  return enqueue(job, true);
}

// ------------------------------------------------------------------ library sweep
/*
 * Cost model (foobar's UI thread is what matters):
 *   - URLs for 100 albums come from ONE getFb2kUrlByPathBatch call (string building);
 *   - presence is tested by loading a 48 px thumbnail: the component extracts and
 *     scales it on its CPU worker threads, not on the UI thread;
 *   - only thumbnails that fail are confirmed with getAvailableArtwork (opens files
 *     on the UI thread), through the background budget in sched.js;
 *   - albums seen with art in the last 30 days are not touched at all.
 */
export async function sweepLibrary(manual = false) {
  if (state.sweeping) return;
  state.sweeping = true; state.scanned = 0; state.checked = 0; state.missing = 0; state.withArt = 0; state.skipped = 0; state.sweepDone = false;
  emit('change');
  const live = () => (manual || settings.coverSweep) && !state.paused;
  try {
    await loadSeen(); await Own.ready();
    const now = Date.now();
    let offset = 0;
    for (;;) {
      if (!live()) break;
      const r = await bgCall('library.getAlbums', { offset, limit: 500, sort: 'artist' });
      if (!ok(r)) { state.lastError = 'library.getAlbums: ' + (r.error || r.code); break; }
      const albums = r.albums || [];
      state.total = r.total || albums.length;
      const todo = [];
      for (const a of albums) {
        state.scanned++;
        const j = jobFromAlbum(a);
        if (!j || !shouldTry(j.key)) { state.skipped++; continue; }
        if (Own.get(j.key) || Own.keyForPath(j.path)) { state.withArt++; continue; }     // your cover
        if (!manual && now - (seen.get(j.key) || 0) < SEEN_TTL) { state.withArt++; continue; }
        todo.push(j);
      }
      for (let i = 0; i < todo.length && live(); i += 100) {
        const chunk = todo.slice(i, i + 100);
        const b = await bgCall('artwork.getFb2kUrlByPathBatch', { paths: chunk.map((j) => j.path), maxSize: 48 });
        const urls = new Map(((ok(b) && b.artworks) || []).map((x) => [x.path, x.dataUrl]));
        // 4 thumbnails in flight: they decode on the component's worker threads
        let k = 0;
        const lane = async () => {
          while (k < chunk.length && live()) {
            const j = chunk[k++];
            await slot('low');
            const u = urls.get(j.path);
            const probe = u ? await probeImage(artUrl(u)) : null;
            spent(2);
            state.checked++;
            let has = probe === true;
            if (!has) { const v = await availability(j.path); has = v === null ? probe !== false : v; }
            if (has) { state.withArt++; markSeen(j.key); }
            else { state.missing++; j.fromSweep = true; enqueue(j); }
            if (state.checked % 25 === 0) emit('change');
          }
        };
        await Promise.all([lane(), lane(), lane(), lane()]);
      }
      emit('change');
      offset += albums.length;
      if (!r.hasMore || !albums.length) break;
      while (state.queue.length > 60 && !state.paused) await sleep(2000);
    }
    state.sweepDone = live() || state.scanned >= state.total;
  } finally { saveSeen(); state.sweeping = false; emit('change'); }
}
