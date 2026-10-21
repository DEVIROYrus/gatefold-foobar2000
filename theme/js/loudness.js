/*
 * Gatefold · loudness.js — «Volume levelling»: every album as loud as the next, with each album's
 * own dynamics left alone.
 *
 * The levelling itself is foobar2000's: its ReplayGain processing applies the gain stored in the
 * files' tags, at playback, sample-exact and gapless, with clipping prevention by the stored peak.
 * Gatefold does the rest:
 *
 *   settings   turns ReplayGain on (album gain by default; «smart» = album gain unless shuffling;
 *              per track), clipping prevention on, and sets the preamp for the chosen target
 *              loudness (ReplayGain's reference is −18 LUFS: −14 LUFS is +4 dB). Whatever foobar2000
 *              was set to before is saved and put back when levelling is turned off.
 *   analysis   finds the tracks whose tags lack ReplayGain values and measures them like the
 *              ReplayGain 2.0 scanner (EBU R128 / BS.1770-4 loudness, true peak; loudness-core.js),
 *              in a worker, in the background, paced by the user's activity and paused on battery.
 *   albums     are measured whole: the album's loudness gates the blocks of all its tracks at once,
 *              so a quiet interlude keeps exactly the level the artist gave it. That only works if
 *              every track of the album carries the album gain — with a track missing it, foobar2000
 *              falls back to that track's own gain and the interlude jumps up by 10 dB or more. So
 *              any album with a track that lacks the album gain is measured again as a whole, and
 *              all its tracks get the same album gain and album peak.
 *   grouping   album tag + the album's folder (a CD1 / Disc 2 sub-folder counts as the album's
 *              folder); one title by two album artists in one folder stays two albums, a
 *              compilation with a different artist on every track stays one. Tracks without an
 *              album tag are singles: their album gain is their track gain.
 *   writing    standard tags (REPLAYGAIN_TRACK_GAIN / _PEAK, REPLAYGAIN_ALBUM_GAIN / _PEAK) through
 *              foobar2000's own tag writers, the audio is never touched; every write is read back
 *              (replaygain.get) and a format whose tags do not keep the values is reported, not
 *              retried. The album that is playing is written only once playback leaves it, so its
 *              loudness never changes halfway through.
 */
import { call, ok, on, log, sleep } from './bridge.js';
import { settings, setSetting } from './settings.js';
import { slot, spent, userIdleFor } from './sched.js';
import * as IDB from './idb.js';
import { REF_LUFS, album as albumOf, gainOf, fmtGain, fmtPeak } from './loudness-core.js';

export const TARGETS = [-18, -16, -14, -23];
export const MODES = ['album', 'auto', 'track'];
const SOURCE = { album: 'album', auto: 'auto', track: 'track' };
const PREV = 'gatefold.level.prev';            // foobar2000's ReplayGain settings before levelling
const FAIL = 'level.fail.v1';                  // track key → time of a failed measurement or write
const NOWRITE = 'gatefold.level.nowrite';       // file extensions whose tags did not keep the values
const RETRY = 30 * 864e5;

export const events = new EventTarget();
/** until when tag changes in the library are Gatefold's own ReplayGain writes (nothing visible changed) */
export let writingUntil = 0;
export const state = {
  phase: 'off',            // off | idle | scanning | measuring | writing | waiting | paused | done | error
  why: '',                 // battery | playing | ''
  albums: 0, albumsDone: 0, tracks: 0, tracksDone: 0,
  written: 0, failed: 0, unwritable: 0, deferred: 0,
  current: '', secondsDone: 0, secondsTotal: 0, rate: 0, error: '',
};
const emit = () => events.dispatchEvent(new Event('change'));
const setPhase = (p, why = '') => { if (state.phase !== p || state.why !== why) { state.phase = p; state.why = why; emit(); } };

/* ---------------------------------------------------------------- foobar2000's ReplayGain settings */
const preampFor = (target) => Math.round((target - REF_LUFS) * 10) / 10;
/* tracks still without values get a preamp that brings a typical modern master (≈ −9 LUFS) near
   the target, so they are not much louder than the levelled ones while the analysis catches up */
const preampUntagged = (target) => Math.max(-24, Math.min(0, Math.round((target + 9) * 10) / 10));

export async function readFoobar() { const r = await call('replaygain.getSettings'); return ok(r) ? r : null; }

async function apply() {
  const t = TARGETS.includes(+settings.levelTarget) ? +settings.levelTarget : -18;
  const m = SOURCE[settings.levelMode] || 'album';
  const a = await call('replaygain.setMode', { sourceMode: m, processingMode: 'gain_and_peak' });
  const b = await call('replaygain.setPreamp', { withRg: preampFor(t), withoutRg: preampUntagged(t) });
  if (!ok(a) || !ok(b)) { state.error = (a && a.error) || (b && b.error) || 'replaygain'; emit(); return false; }
  return true;
}

export async function enable() {
  const cur = await readFoobar();
  try { if (cur && !localStorage.getItem(PREV)) localStorage.setItem(PREV, JSON.stringify({ sourceMode: cur.sourceMode, processingMode: cur.processingMode, withRg: cur.preampWithRg, withoutRg: cur.preampWithoutRg })); } catch {}
  setSetting('level', true);
  const done = await apply();
  if (settings.levelScan) start();
  emit();
  return done;
}
export async function disable() {
  setSetting('level', false);
  stop();
  let prev = null; try { prev = JSON.parse(localStorage.getItem(PREV) || 'null'); } catch {}
  if (prev && prev.sourceMode && prev.sourceMode !== 'none') {
    await call('replaygain.setMode', { sourceMode: prev.sourceMode, processingMode: prev.processingMode || 'gain_and_peak' });
    await call('replaygain.setPreamp', { withRg: +prev.withRg || 0, withoutRg: +prev.withoutRg || 0 });
  } else await call('replaygain.setMode', { sourceMode: 'none' });
  try { localStorage.removeItem(PREV); } catch {}
  setPhase('off');
}
export async function setMode(m) { setSetting('levelMode', m); if (settings.level) await apply(); }
export async function setTarget(t) { setSetting('levelTarget', +t); if (settings.level) await apply(); }
export function setScan(v) { setSetting('levelScan', !!v); if (v && settings.level) start(); else if (!v) stop(); }
export function pause(p) { setSetting('levelPaused', !!p); wakeUp(); emit(); }

/* ---------------------------------------------------------------- the library */
const FIELDS = ['absolutePath', 'subsong', 'album', 'albumArtist', 'artist', 'title', 'duration', 'sampleRate', 'channels', 'codec'];
const pathOf = (t) => (t.subsong > 0 ? `${t.absolutePath}|subsong:${t.subsong}` : t.absolutePath);
const keyOf = (t) => pathOf(t).toLowerCase();
const extOf = (p) => (String(p).split('|')[0].match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
const dirOf = (p) => String(p).split('|')[0].replace(/[\\/][^\\/]*$/, '');
const DISC = /^(cd|disc|disk|диск|диск №|vol\.?|volume|side)\s*[-_.#№]?\s*\d+\b/i;
/** the album's folder: a «CD1» / «Disc 2» sub-folder belongs to its parent */
const rootOf = (p) => { const d = dirOf(p); return DISC.test(d.split(/[\\/]/).pop() || '') ? dirOf(d) : d; };

/** album groups: [{ key, name, tracks:[t…] }] */
export function groupAlbums(tracks) {
  const by = new Map();
  for (const t of tracks) {
    const k = t.album && norm(t.album) ? `${rootOf(t.absolutePath).toLowerCase()}|${norm(t.album)}` : `single|${keyOf(t)}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  const out = [];
  for (const [k, list] of by) {
    // one title by two different album artists in one folder: two albums, when each side is
    // album-sized; a compilation (an artist per track) stays one
    const aa = new Map();
    for (const t of list) { const a = norm(t.albumArtist); if (!aa.has(a)) aa.set(a, []); aa.get(a).push(t); }
    if (aa.size > 1 && [...aa.values()].every((g) => g.length >= 3)) for (const [a, g] of aa) out.push({ key: k + '|' + a, name: g[0].album, artist: g[0].albumArtist || g[0].artist, tracks: g });
    else out.push({ key: k, name: list[0].album || list[0].title, artist: list[0].albumArtist || list[0].artist, tracks: list, single: k.startsWith('single|') });
  }
  return out;
}

async function queryKeys(q) {
  const r = await call('library.query', { query: q, limit: 1000000, fields: ['absolutePath', 'subsong'] });
  return ok(r) ? new Set((r.tracks || []).map(keyOf)) : null;
}
/** which tracks lack the track gain, which the album gain (a foobar2000 query; per file if it fails) */
async function missing(tracks) {
  let T = await queryKeys('%replaygain_track_gain% MISSING'), A = await queryKeys('%replaygain_album_gain% MISSING');
  if (T && A) return { T, A };
  T = new Set(); A = new Set();
  for (let i = 0; i < tracks.length && running; i += 200) {
    await slot('low');
    const t0 = performance.now();
    const part = tracks.slice(i, i + 200);
    const r = await call('replaygain.get', { paths: part.map(pathOf) });
    spent(performance.now() - t0);
    (ok(r) ? r.results || [] : []).forEach((x, j) => {
      if (!x || !x.success) return;
      if (x.trackGainRaw == null) T.add(keyOf(part[j]));
      if (x.albumGainRaw == null) A.add(keyOf(part[j]));
    });
  }
  return { T, A };
}

/* ---------------------------------------------------------------- decoding (whole tracks, in pieces) */
const waiting = new Map();
let wired = false;
function wire() {
  if (wired) return; wired = true;
  const wv = window.chrome && window.chrome.webview;
  if (wv) wv.addEventListener('sharedbufferreceived', (e) => {
    const info = e.additionalData;
    if (!info || info.purpose !== 'audio.decodePcm') return;
    const w = waiting.get(info.taskId); if (!w) return;
    const buffer = e.getBuffer();
    try {
      const cap = new DataView(buffer).getUint32(24, true), n = Math.min(info.frames, cap), ch = info.channels || 1;
      // a copy per channel: the shared buffer is read-only and released right away
      w.planes = Array.from({ length: ch }, (_, c) => new Float32Array(new Float32Array(buffer, 64 + c * cap * 4, n)));
      w.frames = n; w.sr = info.sampleRate; w.ch = ch;
    } catch (err) { log('level buffer', err); }
    try { wv.releaseBuffer && wv.releaseBuffer(buffer); } catch {}
    if (w.ready) { waiting.delete(info.taskId); w.resolve(w); }
  });
  on('audio:pcmReady', (d) => { const w = waiting.get(d.taskId); if (!w) return; w.ready = true; w.end = d.end; w.truncated = d.truncated; if (w.planes) { waiting.delete(d.taskId); w.resolve(w); } });
  on('audio:pcmFailed', (d) => { const w = waiting.get(d.taskId); if (w) { waiting.delete(d.taskId); w.resolve({ failed: d.code || 'failed' }); } });
}
async function decodePiece(path, start, end) {
  wire();
  const r = await call('audio.decodePcm', { path, start, end });
  if (!ok(r) || !r.taskId) return { failed: (r && r.code) || 'failed' };
  return new Promise((resolve) => {
    waiting.set(r.taskId, { resolve, planes: null, ready: false });
    setTimeout(() => { if (waiting.has(r.taskId)) { waiting.delete(r.taskId); call('audio.cancelDecodePcm', { taskId: r.taskId }); resolve({ failed: 'timeout' }); } }, 120000);
  });
}

/* ---------------------------------------------------------------- the worker */
let worker = null, wseq = 0;
const wreq = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./loudness-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => { const r = wreq.get(e.data.id); if (r) { wreq.delete(e.data.id); r(e.data); } };
  worker.onerror = (e) => { log('level worker', e.message || e); for (const r of wreq.values()) r({ error: 'worker' }); wreq.clear(); };
  return worker;
}

/** measure one track → { lufs, peak, truePeak, hist, seconds } | { failed } */
async function measure(t) {
  const path = pathOf(t), dur = +t.duration || 0;
  const sr0 = +t.sampleRate || 48000, ch0 = Math.max(1, +t.channels || 2);
  // pieces of at most ~48 MB of samples (the host caps one buffer at 256 MB)
  const piece = Math.max(5, Math.min(60, Math.floor(48e6 / (sr0 * ch0 * 4))));
  const id = ++wseq, w = getWorker();
  let begun = false, pos = 0;
  for (;;) {
    if (!running) { if (begun) w.postMessage({ type: 'drop', id }); return { failed: 'stopped' }; }
    await slot('low');
    const t0 = performance.now();
    const end = dur ? Math.min(dur, pos + piece) : pos + piece;
    const d = await decodePiece(path, pos, end);
    spent(Math.min(40, performance.now() - t0));
    if (d.failed) {
      if (begun && (d.failed === 'INVALID_PARAMS' || !dur)) break;      // ran past the end of a track of unknown length
      if (begun) w.postMessage({ type: 'drop', id });
      return { failed: d.failed };
    }
    if (!begun) { w.postMessage({ type: 'begin', id, fs: d.sr || sr0, ch: d.ch || ch0 }); begun = true; }
    if (d.frames) w.postMessage({ type: 'push', id, planes: d.planes, frames: d.frames }, d.planes.map((p) => p.buffer));
    const got = d.frames / (d.sr || sr0), from = pos;
    state.secondsDone += got; emit();
    pos = typeof d.end === 'number' && d.end > pos ? d.end : pos + got;
    if (!d.frames || d.truncated) break;
    if (dur ? pos >= dur - 0.01 : got < end - from - 0.05) break;      // the end (a short last piece when the length is unknown)
    await pace();
  }
  const res = await new Promise((r) => { wreq.set(id, r); w.postMessage({ type: 'end', id }); });
  return res.error || !res.result ? { failed: res.error || 'measure' } : res.result;
}

/* ---------------------------------------------------------------- pacing */
let wake = null;
const wakeUp = () => { const w = wake; wake = null; if (w) w(); };
const waitWake = (ms) => new Promise((r) => { wake = r; setTimeout(() => { if (wake === r) wake = null; r(); }, ms); });
async function onBattery() { try { const b = navigator.getBattery && await navigator.getBattery(); return !!(b && b.charging === false); } catch { return false; } }
/** the analysis yields to the user: a short breath between pieces, longer while they are busy */
async function pace() {
  const away = document.visibilityState === 'hidden' || userIdleFor() > 30000;
  await sleep(away ? 20 : 120);
  while (running && settings.levelPaused) { setPhase('paused'); await waitWake(30000); }
}

/* ---------------------------------------------------------------- the run */
let running = false, alive = false, playingKey = '';
const deferred = new Map();      // album key → the job waiting for playback to leave the album

export function start() {
  if (!settings.level || !settings.levelScan) return;
  running = true;
  if (alive) { wakeUp(); return; }                 // the loop is still there (perhaps just told to stop): it carries on
  alive = true;
  run().catch((e) => { log('level run', e); running = false; state.error = String(e.message || e); setPhase('error'); })
    .finally(() => { alive = false; if (running) { running = false; start(); } });   // asked to start again while it was ending
}
/** look at the library again now, and give the files that failed before another chance */
export function rescan() {
  failed = {}; IDB.kvSet(FAIL, {}); try { localStorage.removeItem(NOWRITE); } catch {}
  if (running) wakeUp(); else start();
}
export function stop() { running = false; wakeUp(); for (const r of wreq.values()) r({ error: 'stopped' }); wreq.clear(); if (worker) { worker.terminate(); worker = null; } }

let failed = {};
async function run() {
  failed = (await IDB.kvGet(FAIL, {})) || {};
  let nowrite = []; try { nowrite = JSON.parse(localStorage.getItem(NOWRITE) || '[]'); } catch {}
  for (;;) {
    if (!running) return;
    setPhase('scanning');
    const r = await call('library.query', { query: 'ALL', limit: 1000000, fields: FIELDS });
    if (!ok(r)) { state.error = r && r.code === 'LIBRARY_DISABLED' ? 'LIBRARY' : (r && r.error) || 'library.query'; setPhase('error'); await waitWake(10 * 60000); continue; }
    const tracks = (ok(r) && r.tracks || []).filter((t) => t.absolutePath && !/^[a-z]+:\/\//i.test(t.absolutePath) && (+t.duration || 0) >= 0);
    const { T, A } = await missing(tracks);
    const now = Date.now();
    const groups = groupAlbums(tracks).filter((g) => g.tracks.some((t) => {
      const k = keyOf(t);
      return (T.has(k) || A.has(k)) && !(failed[k] && now - failed[k] < RETRY) && !nowrite.includes(extOf(t.absolutePath));
    }));
    // on disk order: neighbouring folders read faster from a hard drive
    groups.sort((a, b) => (a.tracks[0].absolutePath < b.tracks[0].absolutePath ? -1 : 1));
    Object.assign(state, { albums: groups.length, albumsDone: 0, tracks: groups.reduce((n, g) => n + g.tracks.length, 0), tracksDone: 0, written: 0, failed: 0, unwritable: 0, deferred: 0, secondsDone: 0, error: '' });
    state.secondsTotal = groups.reduce((n, g) => n + g.tracks.reduce((m, t) => m + (+t.duration || 0), 0), 0);
    emit();
    if (!groups.length) { setPhase('done'); await waitWake(30 * 60000); if (!running) return; continue; }
    const t0 = performance.now(); const sec0 = state.secondsDone;
    for (const g of groups) {
      if (!running) return;
      while (running && (settings.levelPaused || await onBattery())) { setPhase('paused', settings.levelPaused ? '' : 'battery'); await waitWake(60000); }
      if (!running) return;
      state.current = g.artist ? `${g.artist} — ${g.name}` : g.name;
      setPhase('measuring');
      const job = await measureAlbum(g, T, A);
      state.tracksDone += g.tracks.length;
      if (job) {
        if (g.tracks.some((t) => keyOf(t) === playingKey)) { deferred.set(g.key, job); state.deferred = deferred.size; }
        else await write(job, nowrite);
      }
      state.albumsDone++;
      const el = (performance.now() - t0) / 1000;
      state.rate = el > 5 ? (state.secondsDone - sec0) / el : 0;     // seconds of audio per second
      emit();
      await flushDeferred(nowrite);
    }
    state.current = '';
    await IDB.kvSet(FAIL, failed);
    // the album that is playing is written once playback leaves it
    while (running && deferred.size) { setPhase('waiting', 'playing'); await waitWake(60000); await flushDeferred(nowrite); }
    if (!running) return;
    setPhase('done');
    await waitWake(30 * 60000);           // then a new look: tracks added to the library in the meantime
  }
}

/** measure every track of an album → the tags to write, or null */
async function measureAlbum(g, T, A) {
  if (g.single && !T.has(keyOf(g.tracks[0]))) {
    // a single with a track gain but no album gain: its album gain is that same value
    const t = g.tracks[0], r = await call('replaygain.get', { paths: [pathOf(t)] }), x = ok(r) && r.results && r.results[0];
    if (x && x.success && x.trackGainRaw != null) return { key: g.key, items: [{ path: pathOf(t), key: keyOf(t), tags: { REPLAYGAIN_ALBUM_GAIN: fmtGain(x.trackGainRaw), REPLAYGAIN_ALBUM_PEAK: fmtPeak(x.trackPeakRaw != null ? x.trackPeakRaw : 1) } }] };
  }
  const results = [];
  for (const t of g.tracks) {
    if (!running) return null;
    const r = await measure(t);
    if (r.failed) { if (r.failed !== 'stopped') { failed[keyOf(t)] = Date.now(); state.failed++; log('level: cannot measure', pathOf(t), r.failed); } results.push(null); }
    else {
      // silence, or shorter than one 400 ms block: no loudness of its own (it still takes the album's)
      if (r.lufs == null) failed[keyOf(t)] = Date.now();
      results.push(r);
    }
  }
  if (!running) return null;
  const okRes = results.filter(Boolean);
  if (!okRes.length) return null;
  const al = albumOf(okRes);
  const items = [];
  g.tracks.forEach((t, i) => {
    const r = results[i]; if (!r) return;
    // the whole set, from this one measurement; a track that already had some values gets them
    // cleared first (see write) so the file never holds two different album gains
    const tags = {}, tg = gainOf(r.lufs), k = keyOf(t);
    if (tg != null) { tags.REPLAYGAIN_TRACK_GAIN = fmtGain(tg); tags.REPLAYGAIN_TRACK_PEAK = fmtPeak(r.truePeak); }
    if (al.gain != null) { tags.REPLAYGAIN_ALBUM_GAIN = fmtGain(g.single && tg != null ? tg : al.gain); tags.REPLAYGAIN_ALBUM_PEAK = fmtPeak(g.single ? r.truePeak : al.peak); }
    if (Object.keys(tags).length) items.push({ path: pathOf(t), key: k, tags, had: !T.has(k) || !A.has(k) });
  });
  // a silent track that could not be measured still belongs to the album: same album values
  g.tracks.forEach((t, i) => { if (!results[i] && al.gain != null && !failed[keyOf(t)]) items.push({ path: pathOf(t), key: keyOf(t), tags: { REPLAYGAIN_ALBUM_GAIN: fmtGain(al.gain), REPLAYGAIN_ALBUM_PEAK: fmtPeak(al.peak) } }); });
  return items.length ? { key: g.key, name: state.current, items, album: al } : null;
}

/* ---------------------------------------------------------------- writing and reading back */
const writeWait = new Map();
let writeWired = false;
function wireWrites() {
  if (writeWired) return; writeWired = true;
  on('metadata:writeComplete', (d) => { const k = String(d.path || '').toLowerCase(); const r = writeWait.get(k); if (r) { writeWait.delete(k); r(d); } });
}
/* foobar2000 opens the next track a few seconds early (gapless): tags that change in that moment
   would miss it, so no writing in the last 20 s of a track */
async function clearOfTrackChange() {
  for (let i = 0; i < 6; i++) {
    const p = await call('playback.getPosition');
    const left = ok(p) && p.duration > 0 ? p.duration - p.position : Infinity;
    if (!(left < 20)) return;
    await new Promise((r) => { const off = on('playback:trackChanged', () => { off(); r(); }); setTimeout(() => { off(); r(); }, (left + 3) * 1000); });
    await sleep(3000);
  }
}
async function write(job, nowrite) {
  wireWrites();
  await clearOfTrackChange();
  setPhase('writing');
  const done = job.items.map((it) => new Promise((res) => { writeWait.set(it.path.toLowerCase(), res); setTimeout(() => { if (writeWait.delete(it.path.toLowerCase())) res({ success: false, status: 'timeout' }); }, 45000); }));
  await slot('normal');
  writingUntil = performance.now() + 15000;
  // values already in a file are cleared first: a tag written next to foobar2000's own ReplayGain
  // fields would leave two of them, and which one is read back is up to the format
  const had = job.items.filter((it) => it.had);
  if (had.length) {
    const c = await call('replaygain.clear', { paths: had.map((it) => it.path) });
    if (ok(c)) for (let i = 0; i < 40; i++) {
      await sleep(250);
      const g = await call('replaygain.get', { paths: had.map((it) => it.path) });
      if (!ok(g) || (g.results || []).every((x) => !x || !x.success || !x.hasReplayGain)) break;
    }
  }
  const r = await call('metadata.writeBatch', { items: job.items.map(({ path, tags }) => ({ path, tags })) });
  if (!ok(r) && !(r && r.successCount)) {
    for (const it of job.items) { writeWait.delete(it.path.toLowerCase()); failed[it.key] = Date.now(); }
    state.failed += job.items.length; log('level: write refused', r && r.error); emit(); return;
  }
  const outcomes = await Promise.all(done);
  writingUntil = performance.now() + 10000;
  await sleep(300);
  // read back what foobar2000 now sees in the files
  const back = await call('replaygain.get', { paths: job.items.map((it) => it.path) });
  const rows = ok(back) ? back.results || [] : [];
  const extBad = new Map();
  job.items.forEach((it, i) => {
    const row = rows[i], want = it.tags.REPLAYGAIN_ALBUM_GAIN ? parseFloat(it.tags.REPLAYGAIN_ALBUM_GAIN) : parseFloat(it.tags.REPLAYGAIN_TRACK_GAIN);
    const got = row && row.success ? (it.tags.REPLAYGAIN_ALBUM_GAIN ? row.albumGainRaw : row.trackGainRaw) : null;
    const ext = extOf(it.path);
    if (got != null && Math.abs(got - want) < 0.06) { state.written++; extBad.set(ext, (extBad.get(ext) || 0)); return; }
    failed[it.key] = Date.now();
    if (outcomes[i] && outcomes[i].success) { state.unwritable++; if (!it.had) extBad.set(ext, (extBad.get(ext) || 0) + 1); }
    else state.failed++;
  });
  // the tags were written but do not hold the values: this format will not take them this way
  for (const [ext, bad] of extBad) {
    const okCount = job.items.filter((it) => extOf(it.path) === ext).length - bad;
    if (bad && !okCount && ext && !nowrite.includes(ext)) { nowrite.push(ext); try { localStorage.setItem(NOWRITE, JSON.stringify(nowrite)); } catch {} log('level: .' + ext + ' does not keep ReplayGain tags written as metadata'); }
  }
  IDB.kvSet(FAIL, failed);
  emit();
}
async function flushDeferred(nowrite) {
  for (const [k, job] of [...deferred]) {
    if (job.items.some((it) => it.key === playingKey)) continue;
    deferred.delete(k); state.deferred = deferred.size;
    await write(job, nowrite);
  }
}

/* ---------------------------------------------------------------- life cycle */
export function init() {
  on('playback:trackChanged', (d) => {
    const p = d && (d.absolutePath || d.path);
    playingKey = p ? (d.subsong > 0 ? `${p}|subsong:${d.subsong}` : p).toLowerCase() : '';
    if (deferred.size) wakeUp();
  });
  on('playback:stopped', () => { playingKey = ''; if (deferred.size) wakeUp(); });
  // ReplayGain switched off in foobar2000's own preferences: levelling is off too
  on('audio:replaygainModeChanged', (d) => {
    if (!settings.level) return;
    const m = +d.mode;
    if (m === 0) { setSetting('level', false); stop(); try { localStorage.removeItem(PREV); } catch {} setPhase('off'); return; }
    const mode = { 1: 'track', 2: 'album', 3: 'auto' }[m];
    if (mode && mode !== settings.levelMode) setSetting('levelMode', mode);   // changed in foobar2000's own preferences
    emit();
  });
  on('library:itemsAdded', () => { if (running && (state.phase === 'done')) wakeUp(); });
  call('playback.getCurrentTrack').then((r) => {
    const t = ok(r) && r.found !== false ? (r.track || r) : null;
    if (t && (t.absolutePath || t.path)) playingKey = (t.subsong > 0 ? `${t.absolutePath || t.path}|subsong:${t.subsong}` : (t.absolutePath || t.path)).toLowerCase();
  });
  if (!settings.level) return;
  readFoobar().then((s) => {
    if (s && s.sourceMode === 'none') { setSetting('level', false); try { localStorage.removeItem(PREV); } catch {} emit(); return; }
    setTimeout(start, 20000);          // after the start-up work
  });
}
