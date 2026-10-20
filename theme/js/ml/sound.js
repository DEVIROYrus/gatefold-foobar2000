/*
 * Gatefold · ml/sound.js — every track of the library, listened to by a neural network.
 *
 * The way streaming services describe music: Discogs-EffNet (trained on millions of tracks with
 * 400 Discogs styles) turns ~2-second mel patches into a 1280-number embedding — tracks that sound
 * alike get nearby embeddings — plus style probabilities; small heads on top estimate moods
 * (aggressive, relaxed, sad, happy, party), danceability, voice/instrumental, acoustic/electronic.
 * Two 24-second pieces of each track (from 30 % and 65 %) — 44 s of music in 22 non-overlapping
 * 2-second patches — are decoded by foobar2000 and
 * analysed in a Web Worker with onnxruntime-web: one thread, never the interface thread.
 *
 * Gentle on the computer: one track at a time; while you use the computer the analysis keeps to
 * about a quarter of one CPU core (half when you are away or the window is minimised), waits for
 * pauses in your input, and stops on battery power. The playing track and the radio's candidates
 * go first. Results stay on disk (IndexedDB, ~1.7 KB per track); each track is analysed once.
 *
 * Similarity: cosine of embeddings centred on the library's mean (the library's «average sound»
 * says nothing about two tracks), combined with the mood estimates.
 */
import { call, ok, on, log, sleep, normTrack } from '../bridge.js';
import { settings, setSetting } from '../settings.js';
import { slot, userIdleFor } from '../sched.js';
import * as IDB from '../idb.js';
import * as Models from './models.js';
import { decode } from '../vibe.js';
import { SR } from './frontend.js';

/* name, head, positive class */
export const MOODS = [['aggressive', 'mood_aggressive', 'aggressive'], ['relaxed', 'mood_relaxed', 'relaxed'], ['sad', 'mood_sad', 'sad'],
  ['happy', 'mood_happy', 'happy'], ['party', 'mood_party', 'party'], ['danceable', 'danceability', 'danceable'],
  ['instrumental', 'voice_instrumental', 'instrumental'], ['acoustic', 'mood_acoustic', 'acoustic'], ['electronic', 'mood_electronic', 'electronic']];
const MW = [1.7, 1.3, 1.3, 1.0, 0.7, 0.8, 0.6, 0.8, 0.8];
const MWS = MW.reduce((s, v) => s + v, 0);
const STORE = 'sound', PIECE = 24, HOP = 128;
/* how tracks are sampled; part of the record's version, so a change re-analyses them */
const SAMPLING = 's3';
const FIELDS = ['handle', 'absolutePath', 'subsong', 'title', 'artist', 'albumArtist', 'album', 'duration'];

export const events = new EventTarget();
export const state = { phase: 'off', dlDone: 0, dlTotal: 0, done: 0, total: 0, error: '', why: '', msPerTrack: 0, decodeMs: 0, rate: 0, workers: 0, decodeMode: '', modelId: '', fake: false };
const emit = () => events.dispatchEvent(new Event('change'));
/* pacing multiplier (1 = normal); the end-to-end tests set 0 through localStorage to run at full speed */
const pace = () => { try { const v = localStorage.getItem('gatefold.ml.pace'); return v == null ? 1 : +v; } catch { return 1; } };

export const keyOf = (t) => { const p = String((t && (t.absolutePath || t.path)) || '').toLowerCase(); return p ? p + (t.subsong ? '|' + t.subsong : '') : ''; };
export const handleOfRec = (r) => (r.s ? `${r.p}|subsong:${r.s}` : r.p);
const sample = (arr, n) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
const pathOf = (t) => t.handle || (t.subsong ? `${t.absolutePath}|subsong:${t.subsong}` : t.absolutePath || t.path);

/* ---------------------------------------------------------------- the store */
const recs = new Map();            // key → record (only those of the current model)
let M = null;                      // manifest
let mu = null, muMu = 0, muVer = 0, muCount = 0;
const moodIdx = [];                // per MOODS: [headId, classIndex]

function recompute() {
  const list = [...recs.values()].filter((r) => r.e);
  if (!list.length) { mu = null; return; }
  const D = list[0].e.length;
  const m = new Float64Array(D);
  for (const r of list) { const q = r.q, e = r.e; for (let i = 0; i < D; i++) m[i] += e[i] * q; }
  mu = Float32Array.from(m, (v) => v / list.length);
  muMu = 0; for (let i = 0; i < D; i++) muMu += mu[i] * mu[i];
  for (const r of list) stats(r);
  muVer++; muCount = list.length;
}
function stats(r) {
  const e = r.e, q = r.q; let am = 0, aa = 0;
  for (let i = 0; i < e.length; i++) { am += e[i] * mu[i]; aa += e[i] * e[i]; }
  r._am = am * q; r._n = Math.sqrt(Math.max(1e-9, aa * q * q - 2 * r._am + muMu)); r._v = muVer;
}
const fresh = (r) => { if (r._v !== muVer && mu) stats(r); return r; };
function maybeRecompute() { const n = recs.size; if (!mu || n > muCount * 1.1 + 20) recompute(); }

/** a target: what the radio steers towards — a track's sound, possibly blended with others */
export function target(r) {
  if (!r || !r.e) return null;
  const f = Float32Array.from(r.e, (v) => v * r.q);
  return { f, m: Float32Array.from(r.m, (v) => v / 255), _v: -1 };
}
export function blend(T, r, k) {
  if (!T) return target(r);
  if (!r || !r.e) return T;
  const f = T.f.map((v, i) => v * (1 - k) + r.e[i] * r.q * k), m = T.m.map((v, i) => v * (1 - k) + (r.m[i] / 255) * k);
  return { f, m, _v: -1 };
}
function tstats(T) {
  if (T._v === muVer) return T;
  let fm = 0, ff = 0; for (let i = 0; i < T.f.length; i++) { fm += T.f[i] * mu[i]; ff += T.f[i] * T.f[i]; }
  T._fm = fm; T._n = Math.sqrt(Math.max(1e-9, ff - 2 * fm + muMu)); T._v = muVer;
  return T;
}
/** cosine of the centred embeddings */
export function cosine(T, r) {
  if (!mu || !T || !r || !r.e) return 0;
  tstats(T); fresh(r);
  const f = T.f, e = r.e; let d = 0;
  for (let i = 0; i < e.length; i++) d += f[i] * e[i];
  return (d * r.q - T._fm - r._am + muMu) / (T._n * r._n);
}
export function moodDistance(T, r) {
  let s = 0; for (let i = 0; i < MW.length; i++) s += MW[i] * Math.abs(T.m[i] - r.m[i] / 255);
  return s / MWS;
}
/** 0 = the same sound; ~0.5 related; ≥ 1 clearly different */
export function distance(T, r) {
  if (!T || !r || !r.e) return 1;
  return 0.7 * (1 - cosine(T, r)) + 1.1 * moodDistance(T, r);
}
/** the `n` closest analysed tracks; filter(rec) → false excludes */
export function nearest(T, n = 50, filter = null) {
  if (!T || !mu) return [];
  const out = [];
  for (const r of recs.values()) {
    if (!r.e || (filter && !filter(r))) continue;
    out.push({ r, d: distance(T, r) });
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, n);
}

export const get = (t) => { const r = recs.get(keyOf(t)); return r && r.e ? fresh(r) : null; };
export const ready = () => state.phase === 'ready' || state.phase === 'indexing' || state.phase === 'paused';
export const count = () => muCount;
export const queued = () => Q.size + inflight.size;
export const all = () => [...recs.values()].filter((r) => r.e);
export const moodNames = () => MOODS.map((x) => x[0]);
export const mood = (r, name) => { const i = MOODS.findIndex((x) => x[0] === name); return r && r.m && i >= 0 ? r.m[i] / 255 : 0; };
/** the share of the track's patches the mood wins (0…1), or null for records made before it was kept */
export const moodShare = (r, name) => { const i = MOODS.findIndex((x) => x[0] === name); return r && r.mq && i >= 0 ? r.mq[i] / 255 : null; };
export const hasMood = (name) => { const i = MOODS.findIndex((x) => x[0] === name); return i >= 0 && !!moodIdx[i]; };

/* Discogs styles: «Rock---Doom Metal» → genre «Rock», style «Doom Metal» */
export const styleNames = () => ((M && M.effnet.classes) || []).map((c) => String(c).split('---').pop());
export function topStyles(r, n = 3, min = 0.12) {
  if (!r || !r.st) return [];
  const names = (M && M.effnet.classes) || [];
  return [...r.st].map((v, i) => ({ i, v: v / 255 })).filter((x) => x.v >= min).sort((a, b) => b.v - a.v).slice(0, n)
    .map((x) => ({ name: String(names[x.i] || '').split('---').pop(), genre: String(names[x.i] || '').split('---')[0], p: x.v, i: x.i }));
}

/* The styles to *show* for a track. The network's raw top styles are dominated by broad labels
   («Heavy Metal», «Rock») that fit half the library and say little. What is shown instead:
   · the album's average blended in — Discogs labels whole releases, which is what the network
     learnt, and one 2-minute track can wander (a keyboard intro is not «Gothic Metal»);
   · each style weighed by how much more likely it is here than in the rest of your library
     (p · √(p / library average)), so the specific style wins over the generic one;
   · a style your own genre tag names counts extra. */
let prior = null, priorN = -1, albumIdx = null, albumN = -1;
const nkey = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const albumKeyOfRec = (r) => nkey(r.aa || r.ar) + '|' + nkey(r.al);
function priors() {
  if (prior && Math.abs(recs.size - priorN) < Math.max(20, priorN * 0.05)) return prior;
  const acc = new Float64Array(400); let n = 0;
  for (const r of recs.values()) { if (!r.st) continue; n++; for (let i = 0; i < r.st.length; i++) acc[i] += r.st[i] / 255; }
  prior = n >= 30 ? Float32Array.from(acc, (v) => v / n) : null; priorN = recs.size;
  return prior;
}
function albumMean(r) {
  if (!albumIdx || albumN !== recs.size) {
    albumIdx = new Map(); albumN = recs.size;
    for (const x of recs.values()) { if (!x.st || !x.al) continue; const k = albumKeyOfRec(x); const l = albumIdx.get(k); if (l) l.push(x); else albumIdx.set(k, [x]); }
  }
  const l = r.al ? albumIdx.get(albumKeyOfRec(r)) : null;
  if (!l || l.length < 3) return null;
  const m = new Float32Array(r.st.length);
  for (const x of l) for (let i = 0; i < m.length; i++) m[i] += x.st[i] / 255 / l.length;
  return m;
}
export function describeStyles(r, n = 2, genreTag = '') {
  if (!r || !r.st || !M) return [];
  const names = M.effnet.classes || [];
  const alb = albumMean(r), pr = priors();
  const tag = nkey(genreTag);
  const out = [];
  for (let i = 0; i < r.st.length; i++) {
    const own = r.st[i] / 255, p = alb ? 0.45 * own + 0.55 * alb[i] : own;
    if (p < 0.08) continue;
    const name = String(names[i] || '').split('---').pop();
    let score = p * Math.sqrt(p / ((pr ? pr[i] : 0.06) + 0.03));
    const nm = nkey(name);
    if (tag && nm && (tag.includes(nm) || (nm === 'thrash' && tag.includes('thrash')))) score *= 1.6;
    out.push({ i, name, genre: String(names[i] || '').split('---')[0], p, own, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, n);
}
/** the styles present in the analysed library: [{ i, name, genre, n }] (tracks whose top style it is) */
export function libraryStyles() {
  const names = (M && M.effnet.classes) || [];
  const cnt = new Map();
  for (const r of recs.values()) { if (!r.st) continue; for (const s of describeStyles(r, 2)) cnt.set(s.i, (cnt.get(s.i) || 0) + 1); }
  return [...cnt].map(([i, n]) => ({ i, n, name: String(names[i]).split('---').pop(), genre: String(names[i]).split('---')[0] })).sort((a, b) => b.n - a.n);
}

/* ---------------------------------------------------------------- the network (workers) */
/* «Maximum» speed runs several networks side by side (one per spare core, up to 3); otherwise one */
const SPEED = {
  //            pause after each track × the work done (while in use / when away)   wait for input pauses   workers
  gentle:  { active: 6, away: 2, idleWait: true, battery: true, pool: 1, ahead: 2 },
  normal:  { active: 3, away: 1, idleWait: true, battery: true, pool: 1, ahead: 2 },
  fast:    { active: 1, away: 0.25, idleWait: true, battery: true, pool: 1, ahead: 2 },
  max:     { active: 0, away: 0, idleWait: false, battery: false, pool: 3, ahead: 4 },
};
const speed = () => SPEED[settings.soundSpeed] || SPEED.normal;
const poolSize = () => Math.max(1, Math.min(speed().pool, (navigator.hardwareConcurrency || 4) - 2));
const workers = [];                // { w, reqs: Map, busy }
let seq = 0;
function spawn(bundle, copy) {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const x = { w, reqs: new Map(), busy: 0 };
  w.onmessage = (e) => { const r = x.reqs.get(e.data.id); if (!r) return; x.reqs.delete(e.data.id); x.busy = x.reqs.size; if (e.data.type === 'error') r.rej(new Error(e.data.error)); else r.res(e.data); };
  w.onerror = (e) => { log('ml worker', e.message || e); for (const r of x.reqs.values()) r.rej(new Error(e.message || 'worker')); x.reqs.clear(); x.busy = 0; };
  workers.push(x);
  const ortFile = bundle.manifest.ort.file;
  const buf = (b) => (copy ? b.slice(0) : b);
  const wasm = buf(bundle.models[ortFile]);
  const models = {}; for (const [k, v] of Object.entries(bundle.models)) if (k !== ortFile) models[k] = buf(v);
  return send(x, { type: 'init', manifest: bundle.manifest, wasm, models }, [wasm, ...Object.values(models)]);
}
function send(x, msg, transfer = []) {
  return new Promise((res, rej) => { const id = ++seq; x.reqs.set(id, { res, rej }); x.busy = x.reqs.size; x.w.postMessage({ ...msg, id }, transfer); });
}
/** to the least busy worker */
const post = (msg, transfer) => send(workers.reduce((a, b) => (b.busy < a.busy ? b : a)), msg, transfer);
let growing = null;
/** as many workers as the speed asks for (more read the models again from disk, fewer are let go) */
function fitPool() {
  const want = poolSize();
  while (workers.length > want) { const i = workers.findIndex((x) => !x.busy); if (i < 1) break; workers.splice(i, 1)[0].w.terminate(); }
  if (workers.length < want && !growing && running) {
    growing = Models.load(() => {}).then(async (bundle) => { while (running && workers.length < poolSize()) await spawn(bundle, workers.length < poolSize() - 1); })
      .catch((e) => log('ml pool', e)).finally(() => { growing = null; signal(); });
  }
}

/* Two stages that overlap: foobar2000 decodes the next tracks (one at a time on its own worker
   thread) while the network analyses the current one.
   How to decode is measured once a week: foobar2000 resampling to 16 kHz (its resampler runs at
   the highest quality, which can cost more than the decoding), or the file's own rate with the
   resampling done by the network's worker. Whichever keeps foobar2000 busy for less wins. */
const DEC_KEY = 'gatefold.ml.decode';
let decRate = SR;                  // SR: foobar2000 resamples; 0: native rate, resampled in the worker
function loadDecodeMode() {
  try { const o = JSON.parse(localStorage.getItem(DEC_KEY) || 'null'); if (o && Date.now() - o.at < 7 * 864e5) { decRate = o.rate; return true; } } catch {}
  return false;
}
async function calibrate(sampleTracks) {
  const time = async (t, rate) => {
    const dur = +t.duration || 0; const s = Math.max(0, dur * 0.5 - PIECE / 2);
    const t0 = performance.now(); const x = await decode(pathOf(t), s, s + PIECE, rate).catch(() => null);
    return x && x.length > 1000 ? performance.now() - t0 : null;
  };
  const a = [], b = [];
  for (let i = 0; i + 1 < sampleTracks.length && a.length < 3; i += 2) {        // different files for each mode: no disk-cache bias
    const x = await time(sampleTracks[i], SR), y = await time(sampleTracks[i + 1], 0);
    if (x != null && y != null) { a.push(x); b.push(y); }
  }
  if (a.length < 2) return;
  const med = (v) => v.sort((p, q) => p - q)[v.length >> 1];
  decRate = med(b) < med(a) * 0.8 ? 0 : SR;                                   // native only when clearly faster
  state.decodeMode = decRate ? 'foobar' : 'native';
  try { localStorage.setItem(DEC_KEY, JSON.stringify({ rate: decRate, at: Date.now(), host: Math.round(med(a)), native: Math.round(med(b)) })); } catch {}
  log('ml decode mode', state.decodeMode, 'foobar2000 16 kHz', Math.round(med(a)), 'ms', 'native', Math.round(med(b)), 'ms');
}

/** decode the pieces of a track (requested together: foobar2000 queues them without round trips) */
async function decodeJob(job) {
  const t = job.q.t, path = pathOf(t), dur = +t.duration || 0;
  // two long pieces rather than many short ones: every piece costs foobar2000 a file open and a seek;
  // the patches do not overlap (Essentia's 50 % overlap adds work, not information)
  const starts = dur > 60 ? [0.3, 0.65].map((f) => Math.max(0, dur * f - PIECE / 2)) : [0];
  const t0 = performance.now();
  const xs = await Promise.all(starts.map((s) => decode(path, s, s + (dur > 60 ? PIECE : Math.min(60, dur || 60)), decRate).catch(() => null)));
  const ms = performance.now() - t0;
  state.decodeMs = state.decodeMs ? state.decodeMs * 0.85 + ms * 0.15 : ms;
  const ok = xs.filter((x) => x && x.length >= (x.rate || SR) * 2.2);
  return { job, pieces: ok, rates: ok.map((x) => x.rate || decRate || SR), decMs: ms };
}
/** run the network on decoded pieces → a record (or a «bad» one when the file could not be read) */
async function infer({ job, pieces, rates }) {
  const t = job.q.t, k = job.k;
  const base = { k, v: state.modelId, p: t.absolutePath || t.path || '', s: t.subsong || 0, ar: t.artist || '', aa: t.albumArtist || '', al: t.album || '', ti: t.title || '', du: +t.duration || 0, at: Date.now() };
  if (!pieces.length) return { rec: { ...base, bad: 1 }, ms: 0 };
  const res = await post({ type: 'analyze', pieces, rates, hop: HOP }, pieces.map((p) => p.buffer));
  if (!res.emb) return { rec: { ...base, bad: 1 }, ms: res.ms || 0 };
  state.msPerTrack = state.msPerTrack ? state.msPerTrack * 0.8 + res.ms * 0.2 : res.ms;
  let mx = 0; for (const v of res.emb) mx = Math.max(mx, Math.abs(v));
  const q = mx / 127 || 1;
  const m = new Uint8Array(MOODS.length);
  const mq = new Uint8Array(MOODS.length);         // share of the patches the mood wins (see worker.js)
  MOODS.forEach((x, i) => {
    const hi = moodIdx[i]; const out = hi && res.heads[hi[0]]; const sh = hi && res.share && res.share[hi[0]];
    m[i] = out ? Math.round(Math.max(0, Math.min(1, out[hi[1]])) * 255) : 128;
    mq[i] = sh ? Math.round(Math.max(0, Math.min(1, sh[hi[1]])) * 255) : 128;
  });
  return { rec: { ...base, e: Int8Array.from(res.emb, (v) => Math.round(v / q)), q, st: res.styles ? Uint8Array.from(res.styles, (v) => Math.round(Math.max(0, Math.min(1, v)) * 255)) : null, m, mq: res.share ? mq : undefined }, ms: res.ms };
}

/* ---------------------------------------------------------------- the indexer */
const Q = new Map();               // key → { t, pri, waiters }   waiting
const inflight = new Map();        // key → job                    being decoded / decoded, not analysed yet
const decoded = [];                // [{ job, pieces, decMs }]     ready for the network
let running = false, wake = null, pending = [], saveT = 0, libKeys = null;
const doneAt = [];                 // completion times of background tracks → throughput and time left
const signal = () => { if (wake) { const w = wake; wake = null; w(); } };
const flush = () => { clearTimeout(saveT); const b = pending; pending = []; if (b.length) IDB.putMany(STORE, b.map(({ _am, _n, _v, ...r }) => r)); };

export function prioritize(tracks, pri = 20) {
  if (!running && state.phase === 'off') return;
  for (const t of tracks || []) {
    const k = keyOf(t); if (!k) continue;
    const r = recs.get(k); if (r && (r.e || r.bad)) continue;
    const f = inflight.get(k); if (f) { f.q.pri = Math.max(f.q.pri, pri); continue; }
    const q = Q.get(k);
    if (q) q.pri = Math.max(q.pri, pri); else Q.set(k, { t, pri, waiters: [] });
  }
  signal();
}
/** analyse this track now (ahead of everything) and resolve with its record, or null after `ms` */
export function analyzeNow(t, ms = 15000) {
  const r = get(t); if (r) return Promise.resolve(r);
  const k = keyOf(t); if (!k || !ready()) return Promise.resolve(null);
  if (recs.get(k) && recs.get(k).bad) return Promise.resolve(null);
  return new Promise((res) => {
    const f = inflight.get(k);
    let q = f ? f.q : Q.get(k);
    if (!q) Q.set(k, (q = { t, pri: 100, waiters: [] })); else q.pri = 100;
    q.waiters.push(res);
    setTimeout(() => res(null), ms);
    signal();
  });
}
function next(minPri = -Infinity) {
  let best = null;
  for (const [k, q] of Q) if (q.pri >= minPri && (!best || q.pri > best.q.pri)) { best = { k, q }; if (q.pri >= 100) break; }
  if (best) Q.delete(best.k);
  return best;
}
const urgent = () => { for (const q of Q.values()) if (q.pri >= 100) return true; return false; };
async function onBattery() {
  try { const b = navigator.getBattery && await navigator.getBattery(); return !!(b && b.charging === false); } catch { return false; }
}
/** keep a few tracks decoding / decoded ahead of the network(s) */
function prefetch(minPri) {
  while (running && inflight.size < speed().ahead + busyJobs && Q.size) {
    const job = next(minPri); if (!job) return;
    inflight.set(job.k, job);
    decodeJob(job).then((d) => { decoded.push(d); signal(); }, () => { decoded.push({ job, pieces: [], decMs: 0 }); signal(); });
  }
}
function takeDecoded() {
  if (!decoded.length) return null;
  let i = 0;                                       // the most urgent decoded one first
  for (let j = 1; j < decoded.length; j++) if (decoded[j].job.q.pri > decoded[i].job.q.pri) i = j;
  return decoded.splice(i, 1)[0];
}
const waitWake = (ms) => new Promise((r) => { wake = r; if (ms) setTimeout(r, ms); });

let busyJobs = 0, nextAt = 0;
async function loop() {
  while (running) {
    const paused = settings.soundPaused, sp = speed();
    if (paused && !urgent() && !decoded.some((d) => d.job.q.pri >= 50)) { setPhase('paused'); await waitWake(30000); continue; }
    if (!Q.size && !inflight.size) { setPhase(busyJobs ? 'indexing' : 'ready'); await waitWake(60000); continue; }
    fitPool();
    // every network busy → wait for one
    if (busyJobs >= workers.length) { await waitWake(5000); continue; }
    // background work waits for mains power, the pacing pause and a pause in the user's input; urgent work does not
    if (!urgent() && !paused && !decoded.some((d) => d.job.q.pri >= 50)) {
      if (sp.battery && await onBattery()) { state.why = 'battery'; setPhase('paused'); await sleep(60000); continue; }
      state.why = '';
      const wait = nextAt - performance.now();
      if (wait > 0) { await waitWake(wait); continue; }
      if (sp.idleWait && pace()) await slot('low');
    }
    if (!running) break;
    prefetch(paused ? 50 : -Infinity);
    if (urgent() && inflight.size >= sp.ahead) { const j = next(100); if (j) { inflight.set(j.k, j); decodeJob(j).then((d) => { decoded.push(d); signal(); }); } }
    const item = takeDecoded();
    if (!item) { await waitWake(20000); continue; }
    setPhase(paused ? 'paused' : 'indexing');
    busyJobs++;
    run(item).finally(() => { busyJobs--; signal(); });
  }
}
async function run(item) {
  const job = item.job;
  let out = { rec: null, ms: 0 };
  try { out = await infer(item); } catch (e) { log('ml analyze', e.message || e); state.error = String(e.message || e); }
  inflight.delete(job.k);
  const rec = out.rec;
  if (rec) {
    recs.set(rec.k, rec); pending.push(rec);
    if (rec.e) { if (mu) stats(rec); maybeRecompute(); }
    if (libKeys && libKeys.has(rec.k) && !job.q.redo) state.done++;
    clearTimeout(saveT); saveT = setTimeout(flush, 4000); if (pending.length >= 50) flush();
  }
  for (const w of job.q.waiters) w(rec && rec.e ? rec : null);
  prefetch(settings.soundPaused ? 50 : -Infinity);       // the next decodes run while we rest
  if (job.q.pri < 50) { doneAt.push(performance.now()); if (doneAt.length > 80) doneAt.shift(); }
  state.rate = doneAt.length > 4 ? (doneAt.length - 1) / ((doneAt[doneAt.length - 1] - doneAt[0]) / 1000) : 0;   // tracks per second
  state.workers = workers.length;
  emit();
  if (job.q.pri >= 100) return;
  // pacing by the work actually done — the network's time plus foobar2000's share of decoding (its
  // waiting is not work). «Normal»: busy ≤ ~25 % of one core while the computer is in use, ≤ ~50 %
  // when nobody is at it; «Maximum»: no pauses at all
  const sp = speed();
  const cpu = out.ms + Math.min(item.decMs, 40 * item.pieces.length);
  const away = document.visibilityState === 'hidden' || userIdleFor() > 30000;
  const k = job.q.pri >= 50 ? Math.min(0.5, sp.active) : away ? sp.away : sp.active;
  nextAt = Math.max(nextAt, performance.now()) + Math.min(20000, cpu * k * pace()) / Math.max(1, workers.length);
}
function setPhase(p) { if (state.phase !== p) { state.phase = p; emit(); } }

async function scanLibrary() {
  let r = null;
  for (const query of ['ALL', '%path% PRESENT']) { r = await call('library.query', { query, limit: 1000000, fields: FIELDS }); if (ok(r) && (r.tracks || []).length) break; }
  const tracks = (ok(r) && r.tracks) || [];
  libKeys = new Set();
  let done = 0;
  for (const t of tracks) {
    if ((+t.duration || 0) && t.duration < 8) continue;
    const k = keyOf(t); if (!k || libKeys.has(k)) continue;
    libKeys.add(k);
    const x = recs.get(k);
    if (x && (x.e || x.bad)) {
      done++;
      // made before the per-patch shares were kept, and possibly instrumental: look again, after
      // everything new (only these need the voice share; see sound-ui.js, «Instrumental»)
      if (x.e && !x.mq && mood(x, 'instrumental') >= 0.5 && !Q.has(k)) Q.set(k, { t, pri: -1, waiters: [], redo: true });
      continue;
    }
    if (!Q.has(k)) Q.set(k, { t, pri: 0, waiters: [] });
  }
  state.total = libKeys.size; state.done = done;
  emit(); signal();
  return tracks;
}

/* ---------------------------------------------------------------- lifecycle */
let starting = null;
export function start() {
  if (starting) return starting;
  starting = (async () => {
    state.error = '';
    try {
      const have = await Models.present();
      setPhase(have ? 'loading' : 'downloading');
      let refresh = false;
      try { refresh = Date.now() - (+localStorage.getItem('gatefold.ml.checked') || 0) > 7 * 864e5; } catch {}
      const bundle = await Models.load((d, t) => { state.dlDone = d; state.dlTotal = t; emit(); }, { refresh });
      try { localStorage.setItem('gatefold.ml.checked', String(Date.now())); } catch {}
      setPhase('loading');
      M = bundle.manifest; state.modelId = bundle.id + '.' + SAMPLING; state.fake = !!M.fake;
      MOODS.forEach(([, head, cls], i) => { const h = M.heads.find((x) => x.id === head); const ci = h ? h.classes.indexOf(cls) : -1; moodIdx[i] = h && ci >= 0 ? [head, ci] : null; });
      workers.length = 0;
      await spawn(bundle, false);
      recs.clear();
      const stale = [];
      await IDB.eachBatch(STORE, 1500, (rows) => { for (const r of rows) { if (r.v === state.modelId) recs.set(r.k, r); else stale.push(r.k); } });
      if (stale.length) IDB.delMany(STORE, stale);
      recompute();
      running = true; setPhase('ready');
      if (loadDecodeMode()) state.decodeMode = decRate ? 'foobar' : 'native';
      setTimeout(async () => {
        try {
          const tracks = await scanLibrary();
          if (!loadDecodeMode() && tracks.length > 8) await calibrate(sample(tracks.filter((t) => (+t.duration || 0) > 40), 8));
        } catch (e) { log('ml scan', e); }
        loop();
      }, 1500);
    } catch (e) {
      log('ml start', e); state.error = String((e && e.message) || e); setPhase('error');
      stopWorker();
    } finally { starting = null; }
  })();
  return starting;
}
function stopWorker() { running = false; signal(); for (const x of workers.splice(0)) { x.w.terminate(); for (const r of x.reqs.values()) r.rej(new Error('stopped')); } busyJobs = 0; nextAt = 0; }
export async function enable() { setSetting('soundAI', true); return start(); }
export function disable() { flush(); setSetting('soundAI', false); stopWorker(); Q.clear(); inflight.clear(); decoded.length = 0; setPhase('off'); }
export function pause(p) { setSetting('soundPaused', !!p); signal(); emit(); }
export function setSpeed(v) { setSetting('soundSpeed', v); nextAt = 0; fitPool(); signal(); emit(); }
/** forget everything: the analysis results and the downloaded models */
export async function removeAll() { disable(); recs.clear(); mu = null; muCount = 0; await IDB.clearStore(STORE); await Models.remove(); state.done = 0; emit(); }
export async function rescan() { if (running) await scanLibrary(); }

export function init() {
  on('playback:trackChanged', (d) => { if (d && running) prioritize([normTrack(d)], 60); });
  if (settings.soundAI) setTimeout(() => start(), pace() ? 8000 : 300);    // after the interface has settled
}
