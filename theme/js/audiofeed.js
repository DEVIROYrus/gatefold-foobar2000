/*
 * Gatefold · audiofeed.js — what foobar2000 plays, for the visualisers (milkdrop.js, aura.js).
 *
 * One subscription to the component's shared PCM ring (audio.subscribeStream) for every visualiser on
 * the page, opened while at least one of them is on screen. Subscribing and unsubscribing go one after
 * the other (a Canvas opening while Now Playing's backdrop stops must not end with no sound), and each
 * frame gets:
 *   · the newest 1024 samples as MilkDrop wants them (0…255 around 128), left, right and mixed;
 *   · a 2048-point spectrum in 64 bands spaced like hearing, smoothed (rise fast, fall slowly);
 *   · bass / mid / treble levels normalised to the music's own loudness (a quiet master moves the
 *     picture as much as a loud one), and a beat envelope from the bass's spectral flux against its
 *     recent average.
 */
import { call, ok, log } from './bridge.js';

const SID = 'gatefold-visual';
const pcm = { f32: null, u32: null, ch: 2, sr: 44100, ok: false, users: 0, want: false, busy: null, last: 0 };
try {
  window.chrome?.webview?.addEventListener('sharedbufferreceived', (e) => {
    let d = e.additionalData; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = {}; } }
    if (!d || d.purpose !== 'audio.subscribeStream' || d.subscriptionId !== SID) return;
    const b = e.getBuffer();
    pcm.f32 = new Float32Array(b); pcm.u32 = new Uint32Array(b, 0, 16); pcm.ch = d.channels || 2; pcm.sr = d.sampleRate || 44100; pcm.ok = true;
  });
} catch { /* not in WebView2 */ }

/** a visualiser comes on screen (true) or goes (false) */
export function listen(on) {
  pcm.users = Math.max(0, pcm.users + (on ? 1 : -1));
  reconcile();
}
async function reconcile() {
  if (pcm.busy) return;                                   // the running step looks again when it is done
  const want = pcm.users > 0;
  if (want === pcm.want) return;
  pcm.want = want;
  pcm.busy = (async () => {
    if (want) {
      const r = await call('audio.subscribeStream', { subscriptionId: SID, interval: 0.016, bufferSeconds: 0.5 });
      if (!ok(r)) log('visuals: no PCM stream', r.code || r.error);
    } else {
      pcm.ok = false; pcm.f32 = pcm.u32 = null;
      await call('audio.unsubscribeStream', { subscriptionId: SID });
    }
  })();
  await pcm.busy; pcm.busy = null;
  reconcile();
}

/* ---------------------------------------------------------------- one frame of sound */
const N = 2048, BANDS = 64;
const TB = new Uint8Array(1024), TL = new Uint8Array(1024), TR = new Uint8Array(1024);
const re = new Float32Array(N), im = new Float32Array(N), mono = new Float32Array(N);
const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
const rev = new Uint16Array(N).map((_, i) => { let r = 0; for (let b = 0, x = i; b < 11; b++) { r = (r << 1) | (x & 1); x >>= 1; } return r; });
const COS = new Float32Array(N / 2).map((_, i) => Math.cos((2 * Math.PI * i) / N)), SIN = new Float32Array(N / 2).map((_, i) => -Math.sin((2 * Math.PI * i) / N));
function fft() {
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
      const a = i + j, b = a + half, tr = re[b] * COS[k] - im[b] * SIN[k], ti = re[b] * SIN[k] + im[b] * COS[k];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
/* band edges, log-spaced from 30 Hz to 16 kHz (for 44.1 kHz; recomputed for another rate) */
let edges = null, edgesFor = 0;
function bandEdges(sr) {
  if (edges && edgesFor === sr) return edges;
  edgesFor = sr; edges = new Uint16Array(BANDS + 1);
  for (let b = 0; b <= BANDS; b++) { const f = 30 * Math.pow(16000 / 30, b / BANDS); edges[b] = Math.max(1, Math.min(N / 2 - 1, Math.round((f / sr) * N))); }
  for (let b = 1; b <= BANDS; b++) if (edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;
  return edges;
}
export const F = {
  bands: new Float32Array(BANDS),       // 0…1, smoothed
  bass: 0, mid: 0, treb: 0, level: 0,   // 0…1 relative to the recent loudness
  beat: 0,                              // 0…1, jumps on a beat, decays
  beats: 0,                             // a count (a new beat: it changed)
  live: false,                          // real sound (not silence or the stand-in)
  time: { timeByteArray: TB, timeByteArrayL: TL, timeByteArrayR: TR },
};
const raw = new Float32Array(BANDS);
let gain = 1, agc = 0.05, fluxAvg = 0, fluxVar = 0, lastBeat = 0, prevLow = 0, synthT = 0;
/** read the newest audio and update F (call once per drawn frame) */
export function frame(playing, now = performance.now()) {
  const u = pcm.u32, f = pcm.f32;
  let got = false;
  if (playing && u && f && !(u[7] & 1) && u[6]) {
    const cap = u[6], slot = u[15], ch = pcm.ch;
    for (let i = 0; i < N; i++) {
      let s = (slot - N + i) % cap; if (s < 0) s += cap;
      const b = 16 + s * ch, l = f[b], r = ch > 1 ? f[b + 1] : l;
      mono[i] = (l + r) * 0.5;
      if (i >= N - 1024) { const k = i - (N - 1024); TL[k] = 128 + Math.max(-127, Math.min(127, l * 127 * gain)); TR[k] = 128 + Math.max(-127, Math.min(127, r * 127 * gain)); TB[k] = (TL[k] + TR[k]) >> 1; }
    }
    got = true;
  } else if (playing && !pcm.ok) {
    // no shared PCM (an older component): a soft pulse at 120 bpm keeps the visuals alive
    synthT += 1 / 60;
    for (let i = 0; i < N; i++) { const t = synthT + (i - N) / 44100, ph = t % 0.5; mono[i] = Math.sin(t * 2 * Math.PI * 55) * 0.25 + Math.sin(t * 2 * Math.PI * 62) * Math.exp(-ph * 10) * 0.5; }
    for (let k = 0; k < 1024; k++) TB[k] = TL[k] = TR[k] = 128 + mono[N - 1024 + k] * 100;
    got = true;
  }
  F.live = got && pcm.ok;
  if (!got) {
    TB.fill(128); TL.fill(128); TR.fill(128);
    for (let b = 0; b < BANDS; b++) F.bands[b] *= 0.9;
    F.bass *= 0.9; F.mid *= 0.9; F.treb *= 0.9; F.level *= 0.9; F.beat *= 0.9;
    return F;
  }
  // loudness of this window → the automatic gain for MilkDrop's waveform (a quiet master still moves it)
  let pk = 0.02; for (let i = N - 1024; i < N; i += 4) { const a = Math.abs(mono[i]); if (a > pk) pk = a; }
  gain += (Math.min(3, 0.9 / pk) - gain) * 0.05;
  for (let i = 0; i < N; i++) { re[i] = mono[i] * win[i]; im[i] = 0; }
  fft();
  const E = bandEdges(pcm.sr || 44100);
  let peak = 1e-6;
  for (let b = 0; b < BANDS; b++) {
    let s = 0; for (let k = E[b]; k < E[b + 1]; k++) s += re[k] * re[k] + im[k] * im[k];
    // power → a perceptual magnitude, with a gentle tilt so the treble is not drowned by the bass
    raw[b] = Math.sqrt(s / (E[b + 1] - E[b])) * (1 + b / 24);
    if (raw[b] > peak) peak = raw[b];
  }
  agc = Math.max(peak, agc * 0.995, 0.02);                // follows the loudness up at once, down slowly
  const lowNow = (raw[0] + raw[1] + raw[2] + raw[3] + raw[4] + raw[5]) / 6;
  for (let b = 0; b < BANDS; b++) {
    const v = Math.min(1, Math.pow(raw[b] / agc, 0.8));
    F.bands[b] += (v - F.bands[b]) * (v > F.bands[b] ? 0.55 : 0.12);
  }
  const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += F.bands[i]; return s / (b - a); };
  const sm = (k, v, up, down) => { F[k] += (v - F[k]) * (v > F[k] ? up : down); };
  sm('bass', avg(0, 10), 0.6, 0.12); sm('mid', avg(10, 38), 0.5, 0.1); sm('treb', avg(38, 64), 0.6, 0.15); sm('level', avg(0, 64), 0.4, 0.08);
  // a beat: the bass rising much faster than it has lately (spectral flux over its running mean + 1.6 σ)
  const flux = Math.max(0, lowNow - prevLow) / agc; prevLow = lowNow;
  fluxAvg += (flux - fluxAvg) * 0.05; fluxVar += ((flux - fluxAvg) ** 2 - fluxVar) * 0.05;
  if (flux > fluxAvg + 1.6 * Math.sqrt(fluxVar) && flux > 0.04 && now - lastBeat > 260) { lastBeat = now; F.beat = 1; F.beats++; }
  else F.beat *= 0.9;
  return F;
}
