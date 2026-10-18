/*
 * Gatefold · viz.js — spectrum, beat reaction, waveform seek.
 * Cost model: nothing runs unless something visible needs it.
 *   - spectrum subscription only while playing AND window visible AND
 *     (visualizer on screen OR beat reaction enabled)
 *   - one rAF loop shared by spectrum and progress, stopped when idle
 *   - beat writes only `transform`/`opacity` (compositor-only properties)
 */
import { call, on, ok, log } from './bridge.js';
import { settings } from './settings.js';
import { onPalette, current } from './theme.js';

const $ = (id) => document.getElementById(id);
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------- spectrum
const spec = { subscribed: false, raw: null, bars: new Float32Array(64), peaks: new Float32Array(64), agc: 1, bassAvg: 0, beat: 0, lastData: 0 };
let colors = { a: '#8fb4ff', b: '#c49bff', dim: 'rgba(255,255,255,.12)' };

onPalette((p) => {
  colors = { a: p.accent.hex, b: p.accent2.hex, dim: p.dark ? 'rgba(255,255,255,.13)' : 'rgba(0,0,0,.13)', text3: p.text3.hex };
  waveDirty = true;
});

function normalize(arr) {
  const n = arr.length;
  const out = new Float32Array(n);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) { const v = +arr[i] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (mn < 0) {                       // decibels
    for (let i = 0; i < n; i++) out[i] = clamp((arr[i] + 72) / 66, 0, 1);
  } else if (mx <= 1.0001) {          // linear magnitude 0..1 → perceptual curve
    for (let i = 0; i < n; i++) out[i] = Math.pow(clamp(arr[i], 0, 1), 0.55);
  } else {                            // unknown scale → automatic gain control
    spec.agc = Math.max(spec.agc * 0.996, mx, 1e-6);
    for (let i = 0; i < n; i++) out[i] = Math.pow(arr[i] / spec.agc, 0.6);
  }
  return out;
}

on('audio:spectrum', (d) => {
  const s = d.spectrum || d.data || d.bands;
  if (!s || !s.length) return;
  spec.raw = normalize(s);
  spec.lastData = performance.now();
  kick();
});

/*
 * Live PCM instead of host-side FFT.
 * audio.subscribeSpectrum makes the component run the FFT (≥ 8192 points for this
 * many bands) and serialise JSON on foobar's main thread 60× a second — the one
 * load that remained during playback. audio.subscribeStream instead copies the
 * played samples into a ring buffer shared with the page (no JSON); the FFT runs
 * in js/spectrum-worker.js, as often as the display refreshes. If the stream is
 * unavailable (experimental API) or silent, the old subscription is used.
 */
const BANDS = 56, FFT_N = 4096, SID = 'aurora-viz';
const stream = { on: false, buf: null, f32: null, u32: null, ch: 2, sr: 44100, epoch: -1, lastWrite: -1, lastNew: 0, pending: false, worker: null, mode: 'none', broken: false, armed: 0 };
let wantSpec = false;

function streamWorker() {
  if (stream.worker === null) {
    try {
      stream.worker = new Worker(new URL('./spectrum-worker.js', import.meta.url));
      stream.worker.onmessage = (e) => { stream.pending = false; spec.raw = e.data; spec.lastData = performance.now(); };
      stream.worker.onerror = (e) => { log('spectrum worker failed', e.message); stream.worker = false; fallbackToHost('worker'); };
    } catch { stream.worker = false; }
  }
  return stream.worker || null;
}
try {
  window.chrome?.webview?.addEventListener('sharedbufferreceived', (e) => {
    let d = e.additionalData; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = {}; } }
    if (!d || d.purpose !== 'audio.subscribeStream' || (d.subscriptionId && d.subscriptionId !== SID)) return;
    const b = e.getBuffer();
    stream.buf = b; stream.f32 = new Float32Array(b); stream.u32 = new Uint32Array(b, 0, 16);
    stream.ch = d.channels || 2; stream.sr = d.sampleRate || 44100; stream.epoch = d.epoch; stream.lastWrite = -1;
    if (stream.mode === 'stream' && !stream.ok) log('spectrum: live PCM stream', stream.sr + ' Hz', stream.ch + ' ch');
    stream.ok = true;
    kick();
  });
} catch { /* not in WebView2 */ }

/** Copy the newest FFT_N frames (mono) out of the ring; null when nothing new or mid-write. */
function readStream() {
  const u = stream.u32, f = stream.f32;
  if (!u || !f) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const s1 = u[7];                       // seq: odd while the host writes
    if (s1 & 1) return null;
    const cap = u[6], written = u[8], slot = u[15], ch = stream.ch;
    if (written === stream.lastWrite || !cap) return null;
    const out = new Float32Array(FFT_N);
    const inv = 1 / ch;
    for (let i = 0; i < FFT_N; i++) {
      let s = (slot - FFT_N + i) % cap; if (s < 0) s += cap;
      const base = 16 + s * ch;            // 64-byte header = 16 floats
      let v = 0; for (let c = 0; c < ch; c++) v += f[base + c];
      out[i] = v * inv;
    }
    if (u[7] !== s1) continue;             // overwritten while copying → once more
    stream.lastWrite = written;
    return out;
  }
  return null;
}
function pumpStream() {
  if (stream.mode !== 'stream' || !stream.ok || stream.pending) return;
  const pcm = readStream();
  const now = performance.now();
  if (pcm) {
    stream.lastNew = now;
    const w = streamWorker(); if (!w) return;
    stream.pending = true;
    w.postMessage({ pcm, sampleRate: stream.sr, bands: BANDS }, [pcm.buffer]);
  } else if (now - stream.lastNew > 250) spec.raw = null; // paused / gap → bars fall
}

async function fallbackToHost(why) {
  if (stream.mode === 'host') return;
  log('spectrum: falling back to host FFT (' + why + ')');
  stream.broken = true;
  if (stream.mode === 'stream') call('audio.unsubscribeStream', { subscriptionId: SID });
  stream.mode = 'none'; stream.ok = false;
  if (wantSpec) await subscribeHost();
}
async function subscribeHost() {
  const r = await call('audio.subscribeSpectrum', { bands: BANDS, fftSize: 2048, fps: 60 });
  spec.subscribed = ok(r);
  stream.mode = spec.subscribed ? 'host' : 'none';
  if (!spec.subscribed) log('spectrum unavailable', r.error);
}

export async function updateSpectrumSubscription(want) {
  wantSpec = want;
  if (want && stream.mode === 'none') {
    if (!stream.broken && window.chrome?.webview) {
      const r = await call('audio.subscribeStream', { subscriptionId: SID, interval: 0.016, bufferSeconds: 1 });
      if (ok(r)) {
        stream.mode = 'stream'; spec.subscribed = true; stream.armed = performance.now();
        // the buffer arrives with the first played chunk; nothing within 3 s of playing → host FFT
        setTimeout(() => { if (stream.mode === 'stream' && !stream.ok && wantSpec && prog.playing) fallbackToHost('no shared buffer'); }, 3000);
        return;
      }
      fallbackToHost(r.code || r.error || 'subscribeStream failed');
      return;
    }
    await subscribeHost();
  } else if (!want && stream.mode !== 'none') {
    const m = stream.mode;
    stream.mode = 'none'; spec.subscribed = false; spec.raw = null; stream.ok = false; stream.pending = false; stream.u32 = stream.f32 = stream.buf = null;
    if (m === 'stream') await call('audio.unsubscribeStream', { subscriptionId: SID });
    else await call('audio.unsubscribeSpectrum', {});
  }
}
export const spectrumMode = () => stream.mode;
export const spectrumBars = () => spec.bars;
/** Smoothed signals for optional effects: bars (0..1), beat envelope, band energies. */
export function signals() {
  const b = spec.bars, n = b.length || 1;
  const avg = (a, z) => { let s = 0, k = 0; for (let i = Math.floor(a * n); i < Math.max(Math.floor(a * n) + 1, Math.floor(z * n)); i++) { s += b[i] || 0; k++; } return k ? s / k : 0; };
  return { bars: b, beat: spec.beat, bass: avg(0, 0.12), voice: avg(0.3, 0.62), high: avg(0.7, 1), level: avg(0, 1), live: performance.now() - spec.lastData < 400 };
}

function stepSpectrum() {
  const raw = spec.raw;
  const n = raw ? raw.length : 0;
  if (spec.bars.length !== n && n) { spec.bars = new Float32Array(n); spec.peaks = new Float32Array(n); }
  let active = false;
  for (let i = 0; i < spec.bars.length; i++) {
    const v = raw ? raw[i] : 0;
    const b = spec.bars[i];
    spec.bars[i] = v > b ? b + (v - b) * 0.55 : b * 0.86 + v * 0.14; // fast attack, slow release
    spec.peaks[i] = Math.max(spec.peaks[i] - 0.009, spec.bars[i]);
    if (spec.bars[i] > 0.004 || spec.peaks[i] > 0.004) active = true;
  }
  // bass onset → beat envelope
  const k = Math.max(3, Math.round(spec.bars.length * 0.07));
  let bass = 0; for (let i = 0; i < k; i++) bass += spec.bars[i]; bass /= k;
  spec.bassAvg = spec.bassAvg * 0.94 + bass * 0.06;
  const onset = Math.max(0, bass - spec.bassAvg * 1.08);
  spec.beat = Math.max(spec.beat * 0.86, onset * 2.4);
  return active || spec.beat > 0.002;
}

const viz = $('viz');
let vctx = null, vw = 0, vh = 0;
function sizeViz() {
  if (!viz) return;
  const r = viz.getBoundingClientRect();
  const d = dpr();
  vw = Math.max(1, Math.round(r.width * d)); vh = Math.max(1, Math.round(r.height * d));
  if (viz.width !== vw || viz.height !== vh) { viz.width = vw; viz.height = vh; }
  vctx = viz.getContext('2d');
}
new ResizeObserver(() => { sizeViz(); waveDirty = true; }).observe(viz);

/**
 * Optional painters an interface skin can install (fun/skins.js). All null by default.
 *   spectrum(ctx, w, h, bars, peaks, dpr)      draws the Now Playing spectrum
 *   wave: { step, bw, bar(ctx, x, mid, bw, h, dpr, i) }   waveform seek-bar geometry
 *   colors(): { a, b, dim, text3 }             colours for the default painters
 *   beat(env) → CSS transform for the cover
 */
export const painters = { spectrum: null, wave: null, colors: null, beat: null };
const pal = () => (painters.colors ? { ...colors, ...painters.colors() } : colors);
export function repaint() { waveDirty = true; lastWaveX = -1; lastScale = 0; kick(); }

function drawSpectrum() {
  if (!vctx || !vw) sizeViz();
  const c = vctx; if (!c) return;
  c.clearRect(0, 0, vw, vh);
  if (painters.spectrum) { painters.spectrum(c, vw, vh, spec.bars, spec.peaks, dpr()); return; }
  const colors = pal();
  const n = spec.bars.length;
  const gap = Math.max(2, Math.round(vw / n * 0.28));
  const bw = (vw - gap * (n - 1)) / n;
  const g = c.createLinearGradient(0, vh, 0, 0);
  g.addColorStop(0, colors.b); g.addColorStop(1, colors.a);
  c.fillStyle = g;
  const r = Math.min(bw / 2, 4 * dpr());
  for (let i = 0; i < n; i++) {
    const h = Math.max(2 * dpr(), spec.bars[i] * vh * 0.94);
    const x = i * (bw + gap);
    c.beginPath(); c.roundRect(x, vh - h, bw, h, [r, r, 1, 1]); c.fill();
  }
  c.globalAlpha = 0.55; c.fillStyle = colors.a;
  for (let i = 0; i < n; i++) {
    const y = vh - spec.peaks[i] * vh * 0.94 - 3 * dpr();
    c.fillRect(i * (bw + gap), Math.max(0, y), bw, Math.max(1, dpr() * 1.5));
  }
  c.globalAlpha = 1;
}

// beat → cover breathing
const npArt = $('npArt'), halo = $('npHalo');
let lastScale = 1;
function applyBeat() {
  if (!settings.beatReact) { if (lastScale !== 1) { npArt.style.transform = ''; halo.style.opacity = ''; lastScale = 1; } return; }
  const s = 1 + Math.min(0.03, spec.beat * 0.07);
  if (Math.abs(s - lastScale) > 0.0008) {
    npArt.style.transform = painters.beat ? painters.beat(spec.beat) : `scale(${s.toFixed(4)})`;
    halo.style.opacity = (0.3 + Math.min(0.45, spec.beat * 1.1)).toFixed(3);
    lastScale = s;
  }
}

// ---------------------------------------------------------------- progress + waveform
const seek = $('seek'), wave = $('wave'), fill = $('seekFill'), knob = $('seekKnob');
const prog = { pos: 0, dur: 0, t0: 0, playing: false, hover: -1, dragFrac: -1 };
let wctx = null, ww = 0, wh = 0, waveData = null, waveDirty = true, waveLayers = null, lastWaveX = -1;

export function setProgress(pos, dur, playing) {
  prog.pos = pos; if (dur != null) prog.dur = dur; prog.t0 = performance.now();
  if (playing != null) prog.playing = playing;
  kick();
}
export function getPosition() {
  return prog.playing ? prog.pos + (performance.now() - prog.t0) / 1000 : prog.pos;
}
export const progressState = prog;

export function setHover(frac) { prog.hover = frac; lastWaveX = -1; kick(); }
export function setDrag(frac) { prog.dragFrac = frac; lastWaveX = -1; kick(); }

function sizeWave() {
  const r = seek.getBoundingClientRect(), d = dpr();
  ww = Math.max(1, Math.round(r.width * d)); wh = Math.max(1, Math.round(r.height * d));
  if (wave.width !== ww || wave.height !== wh) { wave.width = ww; wave.height = wh; }
  wctx = wave.getContext('2d');
}
new ResizeObserver(() => { waveDirty = true; lastWaveX = -1; kick(); }).observe(seek);

function buildWaveLayers() {
  sizeWave();
  if (!waveData || !ww) return null;
  const P = painters.wave, colors = pal();
  const d = dpr(), step = Math.round((P?.step || 3) * d), bw = Math.max(1, Math.round((P?.bw || 2) * d));
  const bars = Math.floor(ww / step);
  const vals = new Float32Array(bars);
  for (let i = 0; i < bars; i++) {
    const a = Math.floor(i / bars * waveData.length), b = Math.max(a + 1, Math.floor((i + 1) / bars * waveData.length));
    let m = 0; for (let j = a; j < b; j++) m = Math.max(m, waveData[j]);
    vals[i] = m;
  }
  const mk = (col) => {
    const cv = document.createElement('canvas'); cv.width = ww; cv.height = wh;
    const c = cv.getContext('2d'); c.fillStyle = col;
    const mid = wh / 2;
    for (let i = 0; i < bars; i++) {
      const h = Math.max(d * 1.5, vals[i] * (wh * 0.9));
      if (P?.bar) P.bar(c, i * step, mid, bw, h, d, i);
      else { c.beginPath(); c.roundRect(i * step, mid - h / 2, bw, h, bw / 2); c.fill(); }
    }
    return cv;
  };
  const played = (() => {
    const cv = mk('#000'); const c = cv.getContext('2d');
    c.globalCompositeOperation = 'source-in';
    const g = c.createLinearGradient(0, 0, ww, 0); g.addColorStop(0, colors.b); g.addColorStop(1, colors.a);
    c.fillStyle = g; c.fillRect(0, 0, ww, wh); return cv;
  })();
  return { played, rest: mk(colors.dim), hover: mk(colors.text3 || colors.dim) };
}

function drawProgress() {
  const frac = prog.dragFrac >= 0 ? prog.dragFrac : (prog.dur > 0 ? clamp(getPosition() / prog.dur, 0, 1) : 0);
  if (seek.classList.contains('wave')) {
    if (waveDirty) { waveLayers = buildWaveLayers(); waveDirty = false; lastWaveX = -1; }
    if (!waveLayers) return;
    const x = Math.round(frac * ww);
    if (x === lastWaveX) return;      // nothing visible changed → no repaint
    lastWaveX = x;
    const c = wctx;
    c.clearRect(0, 0, ww, wh);
    c.drawImage(waveLayers.rest, 0, 0);
    if (prog.hover >= 0) { const hx = Math.round(prog.hover * ww); if (hx > x) c.drawImage(waveLayers.hover, x, 0, hx - x, wh, x, 0, hx - x, wh); }
    if (x > 0) c.drawImage(waveLayers.played, 0, 0, x, wh, 0, 0, x, wh);
  } else {
    fill.style.transform = `scaleX(${frac.toFixed(5)})`;
    knob.style.transform = `translateX(${(frac * seek.clientWidth).toFixed(1)}px)`;
  }
}

function toPeaks(w) {
  if (!w) return null;
  if (w.peaks) w = w.peaks;
  if (w.data) w = w.data;
  if (!Array.isArray(w) || !w.length) return null;
  let out;
  if (Array.isArray(w[0])) {                    // per-channel arrays
    const len = w[0].length; out = new Float32Array(len);
    for (const ch of w) for (let i = 0; i < len; i++) out[i] = Math.max(out[i], Math.abs(+ch[i] || 0));
  } else if (typeof w[0] === 'object') {        // {min,max} pairs
    out = Float32Array.from(w, (p) => Math.max(Math.abs(+p.min || 0), Math.abs(+p.max || 0), Math.abs(+p.peak || 0), Math.abs(+p.rms || 0)));
  } else out = Float32Array.from(w, (v) => Math.abs(+v || 0));
  let mx = 0; for (const v of out) mx = Math.max(mx, v);
  if (mx > 0) for (let i = 0; i < out.length; i++) out[i] = Math.pow(out[i] / mx, 0.8);
  return out;
}

let waveTask = null, waveFor = '';
on('audio:fullWaveformReady', (d) => {
  if ((waveTask && d.taskId === waveTask) || (d.path && waveFor && d.path === waveFor)) {
    waveData = toPeaks(d.waveform); waveDirty = true; showWave(!!waveData);
  }
});
on('audio:fullWaveformFailed', (d) => { if (d.taskId === waveTask) showWave(false); });

function showWave(onOff) { seek.classList.toggle('wave', !!onOff && settings.waveformSeek); waveDirty = true; lastWaveX = -1; kick(); }

export async function loadWaveform(track) {
  waveData = null; waveTask = null; showWave(false);
  if (!settings.waveformSeek || !track || !track.path || /^https?:/i.test(track.path)) return;
  waveFor = track.handle || track.path;
  const r = await call('audio.generateFullWaveform', { path: waveFor, resolution: 1600, method: 'peak', scale: 'linear', preferCache: true });
  if (!ok(r)) { log('waveform unavailable', r.error); return; }
  if (r.status === 'ready' && r.waveform) { waveData = toPeaks(r.waveform); showWave(!!waveData); }
  else waveTask = r.taskId || null;
}
export function refreshWaveVisibility() { showWave(!!waveData); }
export const waveform = () => waveData;

// ---------------------------------------------------------------- shared rAF loop
let raf = 0;
export const vizState = { nowVisible: false, windowVisible: true, extra: new Set() }; // extra: other consumers that need the spectrum
function frame() {
  raf = 0;
  let again = false;
  if (vizState.windowVisible) {
    drawProgress();
    if (prog.playing) again = true;
    const needSpec = spec.subscribed || spec.beat > 0.002;
    if (needSpec) {
      pumpStream();
      const live = stepSpectrum();
      if (vizState.nowVisible && settings.visualizer) drawSpectrum();
      if (vizState.nowVisible) applyBeat();
      if (live || prog.playing) again = true;
    }
  }
  if (again) raf = requestAnimationFrame(frame);
}
export function kick() { if (!raf) raf = requestAnimationFrame(frame); }
export function resizeAll() { sizeViz(); waveDirty = true; lastWaveX = -1; kick(); }
