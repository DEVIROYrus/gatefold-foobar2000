/*
 * Gatefold · coverquality.js — find weak covers that already exist and replace them.
 *
 * Scan (read-only): for every album the ORIGINAL front cover is requested from
 * foobar and only its header is read (the stream is cancelled after the SOF /
 * IHDR marker): pixel size, format, progressive flag and — for JPEG — the
 * quality factor estimated from the luminance quantisation table (IJG scale;
 * independent of picture content, unlike bytes-per-pixel).
 *
 * Flags: shortest side < qualityMinRes · JPEG quality < qualityMinJpegQ ·
 * aspect outside 0.9…1.11 (scans with borders/spines).
 *
 * Upgrade: the usual sources (iTunes/Deezer/MusicBrainz) are searched, but
 * unlike the missing-cover case we HAVE the right picture already — so every
 * candidate is compared with the current cover (difference hash + 4×4 colour
 * grid). Automatic replacement happens only when the candidate is visibly the
 * same artwork AND larger; everything else waits for a click.
 *
 * Safety: the old picture is backed up to %profile%\aurora\backup\covers and
 * every change is journaled with one-click undo. Shared folders are never
 * touched with a folder file (see coverfetch.js); the result is verified by
 * asking foobar for the cover again — if foobar still shows the old one
 * (embedded art preferred), the sidecar is removed and the art embedded instead.
 */
import { call, ok, log, sleep, albumKeyOf, bumpArtFor, plural } from './bridge.js';
import { settings } from './settings.js';
import * as IDB from './idb.js';
import * as CF from './coverfetch.js';
import { fetchArt, artDiag, heavyTransport } from './artbytes.js';
import { bgCall, slot, spent } from './sched.js';
import { img as imgOp } from './imgw.js';
import * as TC from './thumbcache.js';

import { $t } from './i18n.js';
export const events = new EventTarget();
const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));
export const qstate = { scanning: false, scanned: 0, total: 0, withArt: 0, paused: false, auto: false, busyKey: '', lastError: '', loaded: false, scannedAt: 0 };
export let rows = [];                 // flagged + processed albums (unflagged ones are not kept)
let journal = [];
const BACKUP_DIR = '%profile%\\aurora\\backup\\covers';

const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');

// ---------------------------------------------------------------- persistence
let saveT = 0;
function persist() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { IDB.kvSet('quality.v1', { rows, at: qstate.scannedAt, total: qstate.total, withArt: qstate.withArt }); }, 500);
}
export async function load() {
  if (qstate.loaded) return;
  const d = await IDB.kvGet('quality.v1');
  if (d) { rows = d.rows || []; qstate.scannedAt = d.at || 0; qstate.total = d.total || 0; qstate.withArt = d.withArt || 0; qstate.scanned = d.total || 0; }
  journal = (await IDB.kvGet('journal.v1')) || [];
  for (const r of rows) if (r.st === 'busy') r.st = 'flag';
  qstate.loaded = true;
  emit('change');
}
const saveJournal = () => IDB.kvSet('journal.v1', journal.slice(0, 500));
export const getJournal = () => journal;

// ---------------------------------------------------------------- image header parsing
const STD_L = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
/** IJG quality (1…100) that would produce this luminance table. */
export function jpegQualityFromTable(q) {
  let sum = 0;
  for (let k = 0; k < 64; k++) sum += (q[k] * 100) / STD_L[ZZ[k]];
  const S = sum / 64;
  const Q = S <= 100 ? (200 - S) / 2 : 5000 / S;
  return Math.max(1, Math.min(100, Math.round(Q)));
}
const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const le16 = (b, i) => b[i] | (b[i + 1] << 8);
/** → { fmt, w, h, q?, progressive?, complete } | null (need more bytes) */
export function parseImageHeader(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2, q = 0, sof = null;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (i + 4 > b.length) break;
      const len = u16(b, i + 2);
      if (i + 2 + len > b.length) break; // segment not fully received yet
      if (m === 0xdb) {
        let p = i + 4; const end = i + 2 + len;
        while (p < end) {
          const pq = b[p] >> 4, tq = b[p] & 15; p++;
          const t = new Array(64);
          for (let k = 0; k < 64; k++) { t[k] = pq ? u16(b, p) : b[p]; p += pq ? 2 : 1; }
          if (tq === 0 && !q) q = jpegQualityFromTable(t);
        }
      } else if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
        sof = { h: u16(b, i + 5), w: u16(b, i + 7), progressive: m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce };
      } else if (m === 0xda) break;
      if (sof && q) break;
      i += 2 + len;
    }
    return sof ? { fmt: 'JPEG', w: sof.w, h: sof.h, q, progressive: sof.progressive, complete: true } : null;
  }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (b.length < 26) return null;
    return { fmt: 'PNG', w: u32(b, 16), h: u32(b, 20), complete: true };
  }
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    if (b.length < 30) return null;
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === 'VP8X') return { fmt: 'WebP', w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), complete: true };
    if (tag === 'VP8 ') return { fmt: 'WebP', w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff, complete: true };
    if (tag === 'VP8L') { const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24]; return { fmt: 'WebP', w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)), complete: true }; }
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { fmt: 'GIF', w: le16(b, 6), h: le16(b, 8), complete: true };
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) return { fmt: 'BMP', w: Math.abs(b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24)), h: Math.abs(b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24)), complete: true };
  return b.length > 4096 ? { fmt: '?', w: 0, h: 0, complete: true } : null;
}

/** Read the original cover and identify it (dimensions, format, JPEG quality). */
async function probeOriginal(url, path, priority) {
  const r = await fetchArt(url, { path, priority });
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error('HTTP ' + r.status + ' · ' + r.via);
  const head = new Uint8Array(await r.blob.slice(0, 768 * 1024).arrayBuffer());
  const info = parseImageHeader(head);
  return info ? { ...info, bytes: r.blob.size } : null;
}
async function fetchOriginal(url, path) {
  const r = await fetchArt(url, { path });
  if (r.status !== 200) throw new Error('HTTP ' + r.status + ' · ' + r.via);
  return r.blob;
}

function flagsOf(info) {
  const f = [];
  const min = Math.min(info.w, info.h);
  if (info.w && min < (settings.qualityMinRes || 600)) f.push('lowres');
  if (info.fmt === 'JPEG' && info.q && info.q < (settings.qualityMinJpegQ || 55)) f.push('jpegq');
  if (info.w && info.h) { const ar = info.w / info.h; if (ar < 0.9 || ar > 1.11) f.push('aspect'); }
  return f;
}
export const severity = (r) => (r.flags.includes('lowres') ? 1000 - Math.min(r.w, r.h) / 10 : 0) + (r.flags.includes('jpegq') ? 100 - (r.q || 100) : 0) + (r.flags.includes('aspect') ? 10 : 0);

// ---------------------------------------------------------------- scan
export async function scan() {
  if (qstate.scanning) return;
  await load();
  qstate.scanning = true; qstate.scanned = 0; qstate.withArt = 0; qstate.lastError = '';
  const prevMap = new Map(rows.filter((r) => r.st && r.st !== 'flag').map((r) => [r.key, r])); // decisions survive a rescan
  const found = [];
  emit('change');
  try {
    const all = [];
    for (let off = 0; ; off += 1000) {
      const r = await call('library.getAlbums', { offset: off, limit: 1000, sort: 'artist' });
      if (!ok(r)) { qstate.lastError = r.error || r.code; break; }
      all.push(...(r.albums || []));
      if (!r.hasMore || !(r.albums || []).length) break;
    }
    qstate.total = all.length;
    // original-size artwork URLs, 100 per call
    const urlMap = new Map();
    const urlFor = async (path) => {
      if (urlMap.has(path)) return urlMap.get(path);
      const i = all.findIndex((a) => a.firstTrackAbsolutePath === path);
      const chunk = all.slice(i, i + 100).map((a) => a.firstTrackAbsolutePath).filter((p) => p && !urlMap.has(p));
      const b = await bgCall('artwork.getFb2kUrlByPathBatch', { paths: chunk, type: 'front' });
      for (const x of (ok(b) && b.artworks) || []) urlMap.set(x.path, x.dataUrl || '');
      if (!urlMap.has(path)) urlMap.set(path, '');
      return urlMap.get(path);
    };
    let idx = 0;
    const worker = async (n) => {
      while (idx < all.length) {
        if (n > 1 && heavyTransport()) return; // originals over IPC: two streams are enough
        while (qstate.paused) await sleep(400);
        const a = all[idx++];
        const job = CF.jobFromAlbum(a);
        qstate.scanned++;
        if (!job) continue;
        try {
          const url = await urlFor(job.path);
          if (!url) continue;
          // bridge transport is paced inside (bgCall); fetch transports decode on the component's workers
          const info = await probeOriginal(url, job.path, 'low');
          if (!heavyTransport()) await sleep(12);
          if (!info || !info.w) continue;
          qstate.withArt++;
          const flags = flagsOf(info);
          const prev = prevMap.get(job.key);
          if (!flags.length && !prev) continue;
          found.push({ ...(prev || {}), key: job.key, artist: job.artist, album: job.album, year: job.year, tracks: job.tracks, path: job.path,
            w: info.w, h: info.h, q: info.q || 0, fmt: info.fmt, bytes: info.bytes || 0, progressive: !!info.progressive, flags,
            st: prev ? (flags.length || prev.st === 'upgraded' ? prev.st : 'ok') : 'flag', t: Date.now() });
        } catch (e) { qstate.lastError = e.message + (Object.keys(artDiag.errors).length ? ' [' + Object.entries(artDiag.errors).map(([k, v]) => k + ': ' + v).join('; ') + ']' : ''); }
        if (qstate.scanned % 25 === 0) { rows = mergeRows(found); emit('change'); }
        await sleep(2);
      }
    };
    await Promise.all([worker(0), worker(1), worker(2)]);
    rows = mergeRows(found);
    qstate.scannedAt = Date.now();
    persist();
  } finally { qstate.scanning = false; emit('change'); }
}
const mergeRows = (list) => [...list].sort((a, b) => severity(b) - severity(a));

// ---------------------------------------------------------------- visual comparison
const signature = (blob) => imgOp('signature', { blob });
export async function compare(blobA, blobB) {
  const [a, b] = await Promise.all([signature(blobA), signature(blobB)]);
  let ham = 0; for (let i = 0; i < 64; i++) ham += a.bits[i] !== b.bits[i] ? 1 : 0;
  let cd = 0; for (let i = 0; i < 16; i++) cd += Math.hypot(a.grid[i][0] - b.grid[i][0], a.grid[i][1] - b.grid[i][1], a.grid[i][2] - b.grid[i][2]);
  cd /= 16;
  const verdict = ham <= 10 && cd < 38 ? 'same' : ham <= 20 && cd < 70 ? 'similar' : 'different';
  return { ham, cd: Math.round(cd), verdict };
}

// ---------------------------------------------------------------- upgrade
const sizeNeed = (r) => (r.flags.includes('lowres') ? Math.max(Math.round(Math.min(r.w, r.h) * 1.4), settings.coverMinSize || 600) : Math.round(Math.min(r.w, r.h) * 0.95));

/**
 * Search, compare, and either install (auto) or leave candidates for review.
 * opts.auto → only 'same' + score ≥ threshold is installed.
 */
export async function upgrade(row, { auto = false } = {}) {
  const r = rows.find((x) => x.key === row.key) || row;
  qstate.busyKey = r.key; r.st = 'busy'; r.note = ''; emit('change');
  try {
    const job = { key: r.key, artist: r.artist, album: r.album, year: r.year, tracks: r.tracks, path: r.path };
    const u = await call('artwork.getFb2kUrlByPath', { path: r.path, type: 'front' });
    if (!ok(u) || !u.dataUrl) throw new Error($t('у альбома больше нет обложки'));
    const oldBlob = await fetchOriginal(u.dataUrl, r.path);
    const need = sizeNeed(r);
    const cands = (await CF.findCandidates(job, { exhaustive: true }))
      .filter((c) => c.score >= 0.6 && c.res >= need)
      .sort((a, b) => (b.score - a.score) || (b.res - a.res))
      .slice(0, 4);
    const tested = [];
    for (const c of cands) {
      try {
        const img = await CF.download(c.url);
        const minSide = Math.min(img.w, img.h);
        if (minSide < need) { tested.push({ ...slim(c), w: img.w, h: img.h, verdict: 'small' }); continue; }
        const ar = img.w / img.h; if (ar < 0.85 || ar > 1.18) continue;
        if (r.flags.includes('jpegq') && !r.flags.includes('lowres')) {
          const hq = parseImageHeader(new Uint8Array(await img.blob.slice(0, 65536).arrayBuffer()));
          if (hq && hq.fmt === 'JPEG' && hq.q && hq.q < (r.q || 0) + 15) { tested.push({ ...slim(c), w: img.w, h: img.h, verdict: 'small' }); continue; }
        }
        const sim = await compare(oldBlob, img.blob);
        const prev = await previewUrl(img.blob);
        if (prev) previews.set(r.key + '|' + c.url, prev);
        tested.push({ ...slim(c), w: img.w, h: img.h, ...sim, _img: img });
        if (sim.verdict === 'same' && c.score >= settings.coverThreshold) break; // good enough — spare the remaining downloads
      } catch (e) { log('quality candidate failed', c.src, e.message); }
    }
    const usable = tested.filter((t) => t._img);
    const order = { same: 0, similar: 1, different: 2 };
    usable.sort((a, b) => (order[a.verdict] - order[b.verdict]) || (b.score - a.score) || (b.w - a.w));
    const best = usable[0];
    if (best && auto && settings.qualityAuto === 'same' && best.verdict === 'same' && best.score >= settings.coverThreshold) {
      await install(r, best._img, best, oldBlob);
    } else if (usable.length) {
      r.st = 'review';
      r.cands = usable.slice(0, 4).map(({ _img, ...c }) => c);
      r.note = auto ? (best.verdict === 'same' ? $t('та же картинка, но совпадение альбома ниже порога') : best.verdict === 'similar' ? $t('найденная картинка похожа, но не идентична') : $t('найденная картинка отличается от текущей')) : '';
    } else {
      r.st = 'nobetter';
      r.note = tested.length ? $t('лучше {0} px ничего не нашлось', Math.min(r.w, r.h)) : $t('источники ничего не нашли');
    }
  } catch (e) {
    r.st = 'err'; r.note = e.message; qstate.lastError = e.message;
  } finally {
    qstate.busyKey = ''; persist(); emit('change');
  }
  return r;
}
const slim = (c) => ({ src: c.src, title: c.title, artist: c.artist, year: c.year, url: c.url, thumb: c.thumb, res: c.res, score: +(c.score || 0).toFixed(3) });

/** User picked a candidate from the review list. */
export async function applyCandidate(key, cand) {
  const r = rows.find((x) => x.key === key); if (!r) return;
  qstate.busyKey = key; r.st = 'busy'; emit('change');
  try {
    const u = await call('artwork.getFb2kUrlByPath', { path: r.path, type: 'front' });
    const oldBlob = ok(u) && u.dataUrl ? await fetchOriginal(u.dataUrl, r.path) : null;
    const img = await CF.download(cand.url);
    await install(r, img, cand, oldBlob);
  } catch (e) { r.st = 'err'; r.note = e.message; }
  finally { qstate.busyKey = ''; persist(); emit('change'); }
}
/* Candidate previews come from the bytes already downloaded for the comparison,
   so the review grid never depends on the source's thumbnail server. Memory only. */
const previews = new Map();
export const previewFor = (key, cd) => previews.get(key + '|' + cd.url) || cd.thumb || '';
async function previewUrl(blob) {
  try {
    const b = (await imgOp('resize', { blob, max: 240, quality: 0.85, square: true })).blob;
    if (previews.size > 200) { const [k, u] = previews.entries().next().value; URL.revokeObjectURL(u); previews.delete(k); }
    return b ? URL.createObjectURL(b) : '';
  } catch { return ''; }
}

export function keep(key) { const r = rows.find((x) => x.key === key); if (r) { r.st = 'kept'; r.cands = null; persist(); emit('change'); } }

export async function upgradeAll() {
  if (qstate.auto) return;
  qstate.auto = true; emit('change');
  try {
    for (const r of [...rows]) {
      if (!qstate.auto) break;
      while (qstate.paused) await sleep(500);
      if (r.st !== 'flag' && r.st !== 'err') continue;
      await upgrade(r, { auto: true });
      await sleep(400);
    }
  } finally { qstate.auto = false; emit('change'); }
}
export function stopAll() { qstate.auto = false; emit('change'); }
export function setPaused(p) { qstate.paused = p; emit('change'); }

// ---------------------------------------------------------------- writing (with backup, verification, journal)
const extOf = (mime) => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg');
const sniffMime = (u8) => (u8[0] === 0x89 ? 'image/png' : u8[0] === 0x52 ? 'image/webp' : 'image/jpeg');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const hash8 = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); };

async function absPath(p) {
  if (!/%/.test(p)) return p;
  const i = await call('file.getInfo', { path: p });
  return ok(i) && i.parent ? i.parent.replace(/[\\/]+$/, '') + '\\' + (i.name || p.split('\\').pop()) : '';
}
/** Binary write into a music folder: host file API → foobar's own cover writer → PowerShell copy. */
async function writeBinary(dest, b64, { allowFoobarWriter = false, trackPath = '' } = {}) {
  let r = await call('file.write', { path: dest, content: 'base64:' + b64, encoding: 'binary', atomic: true });
  if (ok(r)) return 'file';
  if (allowFoobarWriter && /\\cover\.jpg$/i.test(dest) && trackPath) {
    const e = await call('metadata.embedArtwork', { path: trackPath, imageData: b64, type: 'front', target: ['file'] });
    if (ok(e)) return 'foobar';
  }
  const tmp = '%profile%\\aurora\\tmp\\up-' + Date.now() + '.bin';
  const w = await call('file.write', { path: tmp, content: 'base64:' + b64, encoding: 'binary' });
  if (!ok(w)) throw new Error($t('запись запрещена: ') + (r.error || r.code));
  const src = await absPath(tmp);
  const cmd = `Copy-Item -LiteralPath ${CF.psq(src)} -Destination ${CF.psq(dest)} -Force`;
  const sp = await call('shell.spawn', { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], hidden: true, waitForExitMs: 20000 });
  call('file.delete', { path: tmp, moveToTrash: false });
  if (ok(sp) && (sp.exited === undefined || sp.exitCode === 0)) return 'powershell';
  throw new Error($t('не удалось записать файл: ') + (r.error || sp.error || 'unknown'));
}

/** Does foobar now serve the new picture? (compares pixel size of the original) */
async function verify(path, w, h) {
  for (const wait of [400, 1500, 4000]) {
    await sleep(wait);
    const u = await call('artwork.getFb2kUrlByPath', { path, type: 'front' });
    if (!ok(u) || !u.dataUrl) continue;
    try { const i = await probeOriginal(u.dataUrl + (u.dataUrl.includes('?') ? '&' : '?') + 'qv=' + Date.now(), path); if (i && i.w === w && i.h === h) return true; } catch {}
  }
  return false;
}

async function install(r, img, cand, oldBlob) {
  const job = { key: r.key, artist: r.artist, album: r.album, year: r.year, tracks: r.tracks, path: r.path };
  const dir = dirOf(r.path);
  // 1. backup the current picture
  let backup = '';
  if (oldBlob) {
    const u8 = new Uint8Array(await oldBlob.slice(0, 16).arrayBuffer());
    backup = `${BACKUP_DIR}\\${stamp()}-${hash8(r.key)}.${extOf(sniffMime(u8))}`;
    const w = await call('file.write', { path: backup, content: 'base64:' + (await CF.blobToB64(oldBlob)), encoding: 'binary' });
    if (!ok(w)) throw new Error($t('не удалось сохранить резервную копию — замена отменена ({0})', w.error || w.code));
  }
  // 2. where does foobar take the current cover from?
  const av = await call('artwork.getAvailableArtwork', { path: r.path });
  const sources = ok(av) ? (av.sources || []).map(String) : [];
  const folderSrc = sources.find((s) => s.startsWith('folder:'));
  const others = await CF.otherAlbumsInDir(job);
  const entry = { id: Date.now().toString(36) + hash8(r.key).slice(0, 4), t: Date.now(), key: r.key, artist: r.artist, album: r.album, path: r.path, backup, from: `${r.w}×${r.h}`, to: `${img.w}×${img.h}`, src: cand.src };
  if (folderSrc) {
    if (others > 0) throw new Error($t('текущая обложка — общий файл папки с {0} альбомами; его замена изменила бы и их', others + 1));
    const orig = dir + '\\' + folderSrc.slice(7);
    const stem = orig.replace(/\.[^.\\]+$/, '');
    const dest = stem + '.' + extOf(img.mime);
    entry.via = await writeBinary(dest, img.b64);
    if (dest.toLowerCase() !== orig.toLowerCase()) await CF.recycle(orig);
    Object.assign(entry, { mode: 'replace-file', orig, dest });
  } else if (sources.includes('embedded') || !sources.length) {
    if (others === 0) {
      const dest = dir + '\\cover.jpg';
      const jpg = img.mime === 'image/jpeg' ? img : await toJpeg(img);
      entry.via = await writeBinary(dest, jpg.b64, { allowFoobarWriter: true, trackPath: r.path });
      Object.assign(entry, { mode: 'add-file', dest });
      if (!(await verify(r.path, jpg.w, jpg.h))) {
        // foobar prefers embedded art here → put it where foobar looks instead
        await CF.recycle(dest);
        const e = await CF.embedIntoAlbum(job, img);
        Object.assign(entry, { mode: 'embed', dest: '', tracks: e.tracks, via: 'embedded' });
        const k = Math.min(1, 1400 / Math.max(img.w, img.h)); // embedIntoAlbum keeps embedded copies ≤ 1400 px
        if (!(await verify(r.path, Math.round(img.w * k), Math.round(img.h * k)))) entry.warn = $t('foobar берёт обложку из файла с нестандартным именем — проверьте шаблоны Album art');
      }
    } else {
      const e = await CF.embedIntoAlbum(job, img);
      Object.assign(entry, { mode: 'embed', tracks: e.tracks, via: 'embedded' });
    }
  }
  journal.unshift(entry); saveJournal();
  r.st = 'upgraded'; r.cands = null; r.note = `${r.w}×${r.h} → ${img.w}×${img.h} · ${cand.src}${entry.warn ? ' · ⚠ ' + entry.warn : ''}`; r.jid = entry.id;
  r.w0 = r.w0 || r.w; r.h0 = r.h0 || r.h;
  afterChange(r.path);
  const blobUrl = URL.createObjectURL(img.blob);
  CF.events.dispatchEvent(new CustomEvent('saved', { detail: { job, url: blobUrl, cand: { ...cand, src: $t('улучшение · ') + cand.src } } }));
  setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
}
async function toJpeg(img) {
  return { ...img, ...(await imgOp('resize', { blob: img.blob, w: img.w, h: img.h, quality: 0.93, wantB64: true })) };
}
function afterChange(path) { bumpArtFor(path); TC.forget(path); }

export async function undo(id) {
  const e = journal.find((x) => x.id === id);
  if (!e || e.undone) return;
  const rd = e.backup ? await call('file.read', { path: e.backup, encoding: 'binary' }) : null;
  const b64 = rd && ok(rd) ? rd.content : '';
  if (e.mode === 'replace-file') {
    if (!b64) throw new Error($t('резервная копия не найдена: ') + e.backup);
    await writeBinary(e.orig, b64);
    if (e.dest && e.dest.toLowerCase() !== e.orig.toLowerCase()) await CF.recycle(e.dest);
  } else if (e.mode === 'add-file') {
    await CF.recycle(e.dest);
  } else if (e.mode === 'embed') {
    if (!b64) throw new Error($t('резервная копия не найдена: ') + e.backup);
    for (const p of e.tracks || []) await bgCall('metadata.embedArtwork', { path: p, imageData: b64, type: 'front', target: ['embedded'] }, 'normal');
  }
  e.undone = Date.now(); saveJournal();
  const r = rows.find((x) => x.key === e.key);
  if (r) { r.st = 'kept'; r.note = $t('возвращена прежняя обложка'); persist(); }
  afterChange(e.path);
  if (b64) {
    const url = URL.createObjectURL(await imgOp('fromDataUrl', { dataUrl: b64 }));
    CF.events.dispatchEvent(new CustomEvent('saved', { detail: { job: { key: e.key, album: e.album, artist: e.artist, path: e.path }, url, cand: { src: $t('возвращена прежняя') } } }));
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
  emit('change');
}

export function summary() {
  const s = { lowres: 0, jpegq: 0, aspect: 0, upgraded: 0, review: 0, todo: 0 };
  for (const r of rows) {
    for (const f of r.flags) s[f]++;
    if (r.st === 'upgraded') s.upgraded++; else if (r.st === 'review') s.review++; else if (r.st === 'flag' || r.st === 'err') s.todo++;
  }
  return s;
}
export const flagText = (r) => [
  r.flags.includes('lowres') ? `${r.w}×${r.h}` : '',
  r.flags.includes('jpegq') ? `JPEG ≈${r.q}%` : '',
  r.flags.includes('aspect') ? $t('не квадратная') : '',
].filter(Boolean);
export { plural };
