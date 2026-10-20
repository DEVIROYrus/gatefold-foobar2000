/*
 * Gatefold · ml/sound.js — every track of the library, listened to by a neural network.
 *
 * The way streaming services describe music: Discogs-EffNet (trained on millions of tracks with
 * 400 Discogs styles) turns ~2-second mel patches into a 1280-number embedding — tracks that sound
 * alike get nearby embeddings — plus style probabilities; small heads on top estimate moods
 * (aggressive, relaxed, sad, happy, party), danceability, voice/instrumental, acoustic/electronic.
 * Three 6-second pieces of each track (at ¼, ½ and ¾) are decoded by foobar2000 at 16 kHz and
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
const STORE = 'sound', PIECE = 6;
const FIELDS = ['handle', 'absolutePath', 'subsong', 'title', 'artist', 'albumArtist', 'album', 'duration'];

export const events = new EventTarget();
export const state = { phase: 'off', dlDone: 0, dlTotal: 0, done: 0, total: 0, error: '', why: '', msPerTrack: 0, wall: 0, modelId: '', fake: false };
const emit = () => events.dispatchEvent(new Event('change'));
/* pacing multiplier (1 = normal); the end-to-end tests set 0 through localStorage to run at full speed */
const pace = () => { try { const v = localStorage.getItem('gatefold.ml.pace'); return v == null ? 1 : +v; } catch { return 1; } };

export const keyOf = (t) => { const p = String((t && (t.absolutePath || t.path)) || '').toLowerCase(); return p ? p + (t.subsong ? '|' + t.subsong : '') : ''; };
export const handleOfRec = (r) => (r.s ? `${r.p}|subsong:${r.s}` : r.p);
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
export const queued = () => Q.size;
export const all = () => [...recs.values()].filter((r) => r.e);
export const moodNames = () => MOODS.map((x) => x[0]);
export const mood = (r, name) => { const i = MOODS.findIndex((x) => x[0] === name); return r && r.m && i >= 0 ? r.m[i] / 255 : 0; };
export const hasMood = (name) => { const i = MOODS.findIndex((x) => x[0] === name); return i >= 0 && !!moodIdx[i]; };

/* Discogs styles: «Rock---Doom Metal» → genre «Rock», style «Doom Metal» */
export const styleNames = () => ((M && M.effnet.classes) || []).map((c) => String(c).split('---').pop());
export function topStyles(r, n = 3, min = 0.12) {
  if (!r || !r.st) return [];
  const names = (M && M.effnet.classes) || [];
  return [...r.st].map((v, i) => ({ i, v: v / 255 })).filter((x) => x.v >= min).sort((a, b) => b.v - a.v).slice(0, n)
    .map((x) => ({ name: String(names[x.i] || '').split('---').pop(), genre: String(names[x.i] || '').split('---')[0], p: x.v, i: x.i }));
}
/** the styles present in the analysed library: [{ i, name, genre, n }] (tracks whose top style it is) */
export function libraryStyles() {
  const names = (M && M.effnet.classes) || [];
  const cnt = new Map();
  for (const r of recs.values()) { if (!r.st) continue; for (const s of topStyles(r, 2, 0.2)) cnt.set(s.i, (cnt.get(s.i) || 0) + 1); }
  return [...cnt].map(([i, n]) => ({ i, n, name: String(names[i]).split('---').pop(), genre: String(names[i]).split('---')[0] })).sort((a, b) => b.n - a.n);
}

/* ---------------------------------------------------------------- the network (worker) */
let worker = null, seq = 0;
const reqs = new Map();
function post(msg, transfer = []) {
  return new Promise((res, rej) => { const id = ++seq; reqs.set(id, { res, rej }); worker.postMessage({ ...msg, id }, transfer); });
}
async function startWorker(bundle) {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => { const r = reqs.get(e.data.id); if (!r) return; reqs.delete(e.data.id); if (e.data.type === 'error') r.rej(new Error(e.data.error)); else r.res(e.data); };
  worker.onerror = (e) => { log('ml worker', e.message || e); for (const r of reqs.values()) r.rej(new Error(e.message || 'worker')); reqs.clear(); };
  const wasm = bundle.models[bundle.manifest.ort.file];
  const models = {}; for (const [k, v] of Object.entries(bundle.models)) if (k !== bundle.manifest.ort.file) models[k] = v;
  return post({ type: 'init', manifest: bundle.manifest, wasm, models }, [wasm, ...Object.values(models)]);
}

/** decode three pieces and run the network → a record (or a «bad» one when the file cannot be read) */
async function analyze(t) {
  const k = keyOf(t); if (!k) return null;
  const path = pathOf(t), dur = +t.duration || 0;
  const starts = dur > 30 ? [0.25, 0.5, 0.75].map((f) => Math.max(0, dur * f - PIECE / 2)) : [0];
  const pieces = [];
  for (const s of starts) {
    const x = await decode(path, s, s + (dur > 30 ? PIECE : Math.min(30, dur || 30)), SR);
    if (x && x.length >= SR * 2.2) pieces.push(x);
  }
  const base = { k, v: state.modelId, p: t.absolutePath || t.path || '', s: t.subsong || 0, ar: t.artist || '', aa: t.albumArtist || '', al: t.album || '', ti: t.title || '', du: dur, at: Date.now() };
  if (!pieces.length) return { ...base, bad: 1 };
  const res = await post({ type: 'analyze', pieces }, pieces.map((p) => p.buffer));
  if (!res.emb) return { ...base, bad: 1 };
  state.msPerTrack = state.msPerTrack ? state.msPerTrack * 0.8 + res.ms * 0.2 : res.ms;
  let mx = 0; for (const v of res.emb) mx = Math.max(mx, Math.abs(v));
  const q = mx / 127 || 1;
  const m = new Uint8Array(MOODS.length);
  MOODS.forEach((x, i) => { const hi = moodIdx[i]; const out = hi && res.heads[hi[0]]; m[i] = out ? Math.round(Math.max(0, Math.min(1, out[hi[1]])) * 255) : 128; });
  return { ...base, e: Int8Array.from(res.emb, (v) => Math.round(v / q)), q, st: res.styles ? Uint8Array.from(res.styles, (v) => Math.round(Math.max(0, Math.min(1, v)) * 255)) : null, m };
}

/* ---------------------------------------------------------------- the indexer */
const Q = new Map();               // key → { t, pri, waiters }
let running = false, wake = null, pending = [], saveT = 0, libKeys = null;
const signal = () => { if (wake) { const w = wake; wake = null; w(); } };
const flush = () => { clearTimeout(saveT); const b = pending; pending = []; if (b.length) IDB.putMany(STORE, b.map(({ _am, _n, _v, ...r }) => r)); };

export function prioritize(tracks, pri = 20) {
  if (!running && state.phase === 'off') return;
  for (const t of tracks || []) {
    const k = keyOf(t); if (!k) continue;
    const r = recs.get(k); if (r && (r.e || r.bad)) continue;
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
    let q = Q.get(k);
    if (!q) Q.set(k, (q = { t, pri: 100, waiters: [] })); else q.pri = 100;
    q.waiters.push(res);
    setTimeout(() => res(null), ms);
    signal();
  });
}
function next() {
  let best = null;
  for (const [k, q] of Q) if (!best || q.pri > best.q.pri) { best = { k, q }; if (q.pri >= 100) break; }
  if (best) Q.delete(best.k);
  return best;
}
async function onBattery() {
  try { const b = navigator.getBattery && await navigator.getBattery(); return !!(b && b.charging === false); } catch { return false; }
}
async function loop() {
  while (running) {
    if (settings.soundPaused && ![...Q.values()].some((q) => q.pri >= 50)) { setPhase('paused'); await new Promise((r) => { wake = r; }); continue; }
    if (!Q.size) { setPhase('ready'); await new Promise((r) => { wake = r; setTimeout(r, 60000); }); continue; }
    const job = next(); if (!job) continue;
    if (job.q.pri < 50) {
      if (await onBattery()) { Q.set(job.k, job.q); state.why = 'battery'; setPhase('paused'); await sleep(60000); continue; }
      state.why = '';
      if (pace()) await slot('low');                       // wait for a pause in the user's input
    }
    if (!running) break;
    setPhase(settings.soundPaused ? 'paused' : 'indexing');
    const t0 = performance.now();
    let rec = null;
    try { rec = await analyze(job.q.t); } catch (e) { log('ml analyze', e.message || e); state.error = String(e.message || e); }
    const ms = performance.now() - t0;
    if (rec) {
      recs.set(rec.k, rec); pending.push(rec);
      if (rec.e) { if (mu) stats(rec); maybeRecompute(); }
      if (libKeys && libKeys.has(rec.k)) state.done++;
      clearTimeout(saveT); saveT = setTimeout(flush, 4000); if (pending.length >= 25) flush();
    }
    for (const w of job.q.waiters) w(rec && rec.e ? rec : null);
    emit();
    if (job.q.pri >= 100) continue;
    // pacing: busy ≤ ~25 % of one core while the computer is in use, ≤ ~50 % when nobody is at it
    const away = document.visibilityState === 'hidden' || userIdleFor() > 30000;
    await sleep(Math.min(20000, ms * (job.q.pri >= 50 ? 0.5 : away ? 1 : 3) * pace()));
    const wall = performance.now() - t0;
    if (job.q.pri < 50) state.wall = state.wall ? state.wall * 0.9 + wall * 0.1 : wall;
  }
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
    if (x && (x.e || x.bad)) { done++; continue; }
    if (!Q.has(k)) Q.set(k, { t, pri: 0, waiters: [] });
  }
  state.total = libKeys.size; state.done = done;
  emit(); signal();
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
      M = bundle.manifest; state.modelId = bundle.id; state.fake = !!M.fake;
      MOODS.forEach(([, head, cls], i) => { const h = M.heads.find((x) => x.id === head); const ci = h ? h.classes.indexOf(cls) : -1; moodIdx[i] = h && ci >= 0 ? [head, ci] : null; });
      await startWorker(bundle);
      recs.clear();
      const stale = [];
      for (const r of await IDB.getAll(STORE)) { if (r.v === state.modelId) recs.set(r.k, r); else stale.push(r.k); }
      if (stale.length) IDB.delMany(STORE, stale);
      recompute();
      running = true; setPhase('ready');
      loop();
      setTimeout(() => scanLibrary().catch((e) => log('ml scan', e)), 1500);
    } catch (e) {
      log('ml start', e); state.error = String((e && e.message) || e); setPhase('error');
      stopWorker();
    } finally { starting = null; }
  })();
  return starting;
}
function stopWorker() { running = false; signal(); if (worker) { worker.terminate(); worker = null; } for (const r of reqs.values()) r.rej(new Error('stopped')); reqs.clear(); }
export async function enable() { setSetting('soundAI', true); return start(); }
export function disable() { flush(); setSetting('soundAI', false); stopWorker(); Q.clear(); setPhase('off'); }
export function pause(p) { setSetting('soundPaused', !!p); signal(); emit(); }
/** forget everything: the analysis results and the downloaded models */
export async function removeAll() { disable(); recs.clear(); mu = null; muCount = 0; await IDB.clearStore(STORE); await Models.remove(); state.done = 0; emit(); }
export async function rescan() { if (running) await scanLibrary(); }

export function init() {
  on('playback:trackChanged', (d) => { if (d && running) prioritize([normTrack(d)], 60); });
  if (settings.soundAI) setTimeout(() => start(), pace() ? 8000 : 300);    // after the interface has settled
}
