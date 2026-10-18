/*
 * Gatefold · spectrum-worker.js — FFT of the live PCM stream, off every UI thread.
 * In: { pcm: Float32Array(N) mono, sampleRate, bands }  Out: Float32Array(bands) in 0..1
 * Hann window, radix-2 complex FFT of the real signal, power summed per
 * log-spaced band (30 Hz – 16 kHz), interpolated for bands narrower than a bin,
 * dB → 0..1 with a gentle +3 dB/octave tilt (music is pink; without it the top
 * end would look dead next to the bass).
 */
let N = 0, rev = null, cosT = null, sinT = null, hann = null, re = null, im = null;
function setup(n) {
  N = n;
  const bits = Math.log2(n) | 0;
  rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  cosT = new Float32Array(n / 2); sinT = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / n); sinT[i] = -Math.sin(2 * Math.PI * i / n); }
  hann = new Float32Array(n);
  for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  re = new Float32Array(n); im = new Float32Array(n);
}
function fft() {
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * cosT[k] - im[b] * sinT[k];
        const ti = re[b] * sinT[k] + im[b] * cosT[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}
let edgesFor = '', edges = null;
function bandEdges(bands, sr) {
  const key = bands + '/' + sr + '/' + N;
  if (key === edgesFor) return edges;
  const lo = 30, hi = Math.min(16000, sr / 2 - 1);
  edges = new Float32Array(bands + 1);
  for (let i = 0; i <= bands; i++) edges[i] = lo * Math.pow(hi / lo, i / bands) * N / sr; // in bins
  edgesFor = key;
  return edges;
}
const out = new Map();
self.onmessage = (e) => {
  const { pcm, sampleRate, bands } = e.data;
  if (pcm.length !== N) setup(pcm.length);
  for (let i = 0; i < N; i++) { const j = rev[i]; re[j] = pcm[i] * hann[i]; im[j] = 0; }
  fft();
  const ed = bandEdges(bands, sampleRate);
  let res = out.get(bands); if (!res) out.set(bands, res = new Float32Array(bands));
  const norm = 4 / (N * N); // Hann coherent gain 0.5, one-sided spectrum
  const pw = (k) => { k = Math.max(1, Math.min(N / 2 - 1, k)); return (re[k] * re[k] + im[k] * im[k]) * norm; };
  for (let b = 0; b < bands; b++) {
    const a = ed[b], z = ed[b + 1];
    let p = 0;
    if (z - a < 1) {                         // narrower than a bin: interpolate
      const c = (a + z) / 2, k = Math.floor(c), f = c - k;
      p = pw(k) * (1 - f) + pw(k + 1) * f;
    } else {
      for (let k = Math.floor(a); k < Math.ceil(z); k++) p = Math.max(p, pw(k));
    }
    const hz = ((a + z) / 2) * sampleRate / N;
    const db = 10 * Math.log10(p + 1e-12) + 3 * Math.log2(Math.max(hz, 30) / 1000);
    res[b] = Math.min(1, Math.max(0, (db + 66) / 60));
  }
  const copy = res.slice();
  self.postMessage(copy, [copy.buffer]);
};
