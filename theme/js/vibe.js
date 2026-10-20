/*
 * Gatefold · vibe.js — how a track sounds, as a handful of numbers.
 *
 * Tags say «metal» for both a slow, sad gothic doom song and a frantic mathcore one. To keep the
 * radio in one mood, Gatefold listens: two 12-second pieces of the track (at 30 % and 60 %) are
 * decoded by foobar2000 (audio.decodePcm, mono, 11 kHz) and measured:
 *   energy     — how loud it sits (mean frame RMS, dBFS)
 *   dynamics   — how much the loudness moves (spread of frame RMS, dB)
 *   bright     — spectral centroid: dark, warm sound vs harsh, bright distortion
 *   attack     — onsets per second (spectral-flux peaks): how busy the drums and riffs are
 *   flux       — average spectral change: smooth pads vs constant chaos
 *   calm       — share of frames quieter than the track's own average
 *   tempo      — the strongest period of the onset envelope, 60–200 BPM
 * The numbers are kept per file in IndexedDB, so every track is listened to once.
 */
import { call, ok, on, log } from './bridge.js';
import * as IDB from './idb.js';

const STORE = 'vibe.v1';
const SR = 11025, N = 1024, HOP = 512, PIECE = 12;
const cache = new Map();
let loaded = null, saveT = 0;
const load = () => (loaded ||= IDB.kvGet(STORE, null).then((o) => { if (o) for (const [k, v] of Object.entries(o)) cache.set(k, v); }));
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => IDB.kvSet(STORE, Object.fromEntries(cache)), 2000); };

/* ---------------------------------------------------------------- decoding through the bridge */
const waiting = new Map();     // taskId → { resolve, buf, info }
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
      const cap = new DataView(buffer).getUint32(24, true);
      w.pcm = new Float32Array(new Float32Array(buffer, 64, Math.min(info.frames, cap)));   // copy: the shared buffer is read-only
    } catch (err) { log('vibe buffer', err); }
    try { wv.releaseBuffer && wv.releaseBuffer(buffer); } catch {}
    if (w.ready) { waiting.delete(info.taskId); w.resolve(w.pcm || null); }
  });
  on('audio:pcmReady', (d) => { const w = waiting.get(d.taskId); if (!w) return; w.ready = true; if (w.pcm) { waiting.delete(d.taskId); w.resolve(w.pcm); } });
  on('audio:pcmFailed', (d) => { const w = waiting.get(d.taskId); if (w) { waiting.delete(d.taskId); w.resolve(null); } });
}
async function decode(path, start, end) {
  wire();
  const r = await call('audio.decodePcm', { path, start, end, sampleRate: SR, mono: true });
  if (!ok(r) || !r.taskId) return null;
  return new Promise((resolve) => {
    waiting.set(r.taskId, { resolve, pcm: null, ready: false });
    setTimeout(() => { if (waiting.has(r.taskId)) { waiting.delete(r.taskId); call('audio.cancelDecodePcm', { taskId: r.taskId }); resolve(null); } }, 20000);
  });
}

/* ---------------------------------------------------------------- measuring */
const HANN = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
function fftMag(re) {        // in-place radix-2, returns |X| for bins 0..N/2
  const n = re.length, im = new Float32Array(n);
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  const out = new Float32Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) out[k] = Math.hypot(re[k], im[k]);
  return out;
}
/** pieces of mono PCM at SR → raw measurements */
export function measure(pieces) {
  const rmsDb = [], flux = [], cent = [];
  for (const x of pieces) {
    let prev = null;
    for (let s = 0; s + N <= x.length; s += HOP) {
      const fr = new Float32Array(N); let e = 0;
      for (let i = 0; i < N; i++) { const v = x[s + i]; e += v * v; fr[i] = v * HANN[i]; }
      const rms = Math.sqrt(e / N);
      rmsDb.push(20 * Math.log10(rms + 1e-9));
      const mag = fftMag(fr);
      let num = 0, den = 0;
      for (let k = 1; k < mag.length; k++) { num += k * mag[k]; den += mag[k]; }
      cent.push(den > 1e-6 ? (num / den) * (SR / N) : 0);
      if (prev) { let f = 0, tot = 0; for (let k = 1; k < mag.length; k++) { const d = mag[k] - prev[k]; if (d > 0) f += d; tot += mag[k]; } flux.push(tot > 1e-6 ? f / tot : 0); }
      else flux.push(0);
      prev = mag;
    }
  }
  const n = rmsDb.length;
  if (n < 40) return null;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const audible = rmsDb.filter((v) => v > -60);
  const loud = audible.length ? mean(audible) : -60;
  const sorted = [...audible].sort((a, b) => a - b);
  const dyn = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)] : 0;
  const calm = audible.length ? audible.filter((v) => v < loud).length / audible.length : 0.5;
  const weighted = cent.reduce((s, c, i) => s + c * Math.max(0, rmsDb[i] + 60), 0) / Math.max(1e-6, rmsDb.reduce((s, v) => s + Math.max(0, v + 60), 0));
  // onsets: flux peaks above a moving median
  const fps = SR / HOP;
  let onsets = 0;
  for (let i = 2; i < flux.length - 2; i++) {
    const win = flux.slice(Math.max(0, i - 8), i + 8).sort((a, b) => a - b);
    const thr = win[win.length >> 1] * 1.5 + 0.02;
    if (flux[i] > thr && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]) onsets++;
  }
  const attack = onsets / (n / fps);
  // tempo: autocorrelation of the flux envelope, 60–200 BPM, mildly preferring 70–140
  let best = 0, bestLag = 0;
  const env = flux.map((v) => Math.max(0, v - mean(flux)));
  for (let lag = Math.round(fps * 60 / 200); lag <= Math.round(fps * 60 / 60); lag++) {
    let s = 0; for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    const bpm = (60 * fps) / lag; s *= bpm >= 70 && bpm <= 140 ? 1 : 0.85;
    if (s > best) { best = s; bestLag = lag; }
  }
  const tempo = bestLag ? (60 * fps) / bestLag : 0;
  return { loud, dyn, bright: weighted, attack, flux: mean(flux), calm, tempo };
}
/** raw measurements → a 0…1 vector the distance works on */
export function vector(m) {
  const c = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return [c(m.loud, -32, -8), c(m.dyn, 3, 22), c(m.bright, 500, 2600), c(m.attack, 0.8, 7), c(m.flux, 0.04, 0.32), c(m.calm, 0.3, 0.7), m.tempo];
}
const W = [0.6, 0.9, 1.3, 1.6, 1.4, 0.7];
/** 0 = same feel; ~1 = clearly different; tempo compared octave-free */
export function distance(a, b) {
  if (!a || !b) return 1;
  let s = 0, w = 0;
  for (let i = 0; i < W.length; i++) { s += W[i] * (a[i] - b[i]) ** 2; w += W[i]; }
  let t = 0;
  if (a[6] && b[6]) { const r = Math.abs(Math.log2(a[6] / b[6])); t = Math.min(r, Math.abs(r - 1)); }   // 70 vs 140 BPM is close
  s += 0.5 * (t * 2) ** 2; w += 0.5;
  return Math.sqrt(s / w) * 2.2;
}

/** the vector of a track (cached), or null when it cannot be decoded */
export async function of(t) {
  await load();
  const key = String(t.absolutePath || t.path || t.handle || '').toLowerCase() + (t.subsong ? '|' + t.subsong : '');
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  const path = t.handle || (t.subsong ? `${t.absolutePath}|subsong:${t.subsong}` : t.absolutePath || t.path);
  const dur = +t.duration || 0;
  const at = (f) => Math.max(0, Math.min(Math.max(0, dur - PIECE - 1), dur * f));
  const ps = [];
  for (const f of dur > 50 ? [0.3, 0.6] : [0]) {
    const s = at(f); const x = await decode(path, s, s + PIECE);
    if (x && x.length > SR * 3) ps.push(x);
  }
  const m = ps.length ? measure(ps) : null;
  const v = m ? vector(m).map((x) => Math.round(x * 1000) / 1000) : null;
  cache.set(key, v); save();
  return v;
}
export const known = (t) => cache.has(String(t.absolutePath || t.path || t.handle || '').toLowerCase() + (t.subsong ? '|' + t.subsong : ''));
