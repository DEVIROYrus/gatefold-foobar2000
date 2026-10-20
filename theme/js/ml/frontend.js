/*
 * Gatefold · ml/frontend.js — audio → the mel spectrogram patches Discogs-EffNet was trained on.
 *
 * Bit-for-bit the front end of Essentia's TensorflowInputMusiCNN (checked by tools/ml/build_assets.py
 * and tests/ml_frontend.mjs): 16 kHz mono, 512-sample Hann frames every 256 samples, power
 * spectrum → 96 Slaney mel bands → log10(1 + 10000·x); 128 frames (≈ 2 s) make one patch.
 */
import { WINDOW, MEL } from './melbank.js';

export const SR = 16000, FRAME = 512, HOP = 256, BANDS = 96, PATCH = 128;

/* 512-point real FFT as a 256-point complex FFT + split (twiddles precomputed once) */
const NC = FRAME / 2;
const REV = new Uint16Array(NC);
for (let i = 0, j = 0; i < NC; i++) {
  REV[i] = j;
  let bit = NC >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
}
const TW_R = new Float64Array(NC / 2), TW_I = new Float64Array(NC / 2);
for (let k = 0; k < NC / 2; k++) { TW_R[k] = Math.cos((-2 * Math.PI * k) / NC); TW_I[k] = Math.sin((-2 * Math.PI * k) / NC); }
const SP_R = new Float64Array(NC + 1), SP_I = new Float64Array(NC + 1);
for (let k = 0; k <= NC; k++) { SP_R[k] = Math.cos((-2 * Math.PI * k) / FRAME); SP_I[k] = Math.sin((-2 * Math.PI * k) / FRAME); }
const re = new Float64Array(NC), im = new Float64Array(NC);
const power = new Float64Array(NC + 1);

/** |FFT(x·window)|² for bins 0…256, into `power` */
function powerSpectrum(x, off) {
  for (let i = 0; i < NC; i++) { const r = REV[i]; re[i] = x[off + 2 * r] * WINDOW[2 * r]; im[i] = x[off + 2 * r + 1] * WINDOW[2 * r + 1]; }
  for (let len = 2; len <= NC; len <<= 1) {
    const half = len >> 1, step = NC / len;
    for (let i = 0; i < NC; i += len) {
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half, wr = TW_R[k * step], wi = TW_I[k * step];
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
  // split the packed complex result into the real signal's spectrum
  for (let k = 0; k <= NC; k++) {
    const k1 = k % NC, k2 = (NC - k) % NC;
    const ar = re[k1], ai = im[k1], br = re[k2], bi = -im[k2];          // Z[k], conj(Z[N-k])
    const er = (ar + br) / 2, ei = (ai + bi) / 2;                          // even part
    const or = (ai - bi) / 2, oi = -(ar - br) / 2;                         // odd part (÷ i)
    const tr = or * SP_R[k] - oi * SP_I[k], ti = or * SP_I[k] + oi * SP_R[k];
    const R = er + tr, I = ei + ti;
    power[k] = R * R + I * I;
  }
}

/** mono 16 kHz samples → log-mel frames (Float32Array frames×96); `centered` pads half a frame in front */
export function melFrames(x, centered = false) {
  if (centered) { const y = new Float32Array(x.length + FRAME / 2); y.set(x, FRAME / 2); x = y; }
  const n = x.length >= FRAME ? 1 + Math.floor((x.length - FRAME) / HOP) : 0;
  const out = new Float32Array(n * BANDS);
  for (let f = 0; f < n; f++) {
    powerSpectrum(x, f * HOP);
    for (let b = 0; b < BANDS; b++) {
      const [start, w] = MEL[b];
      let s = 0;
      for (let i = 0; i < w.length; i++) s += w[i] * power[start + i];
      out[f * BANDS + b] = Math.log10(1 + 10000 * s);
    }
  }
  return { data: out, frames: n };
}

/** frames → patches of 128 frames every `hop` frames (Float32Array patches×128×96) */
export function patches(mel, hop) {
  const n = mel.frames >= PATCH ? 1 + Math.floor((mel.frames - PATCH) / hop) : 0;
  const out = new Float32Array(n * PATCH * BANDS);
  for (let p = 0; p < n; p++) out.set(mel.data.subarray(p * hop * BANDS, (p * hop + PATCH) * BANDS), p * PATCH * BANDS);
  return { data: out, count: n };
}

/* ---------------------------------------------------------------- resampling to 16 kHz
 * For files decoded at their own rate (foobar2000's resampler runs at its highest quality, which
 * can cost more than the decoding itself): a polyphase windowed-sinc low-pass at 95 % of the lower
 * Nyquist frequency, 24 zero crossings, Blackman window. 44.1 kHz → 16 kHz has 160 phases
 * (gcd 100), 48 kHz → 16 kHz one; each phase's taps are precomputed, so the inner loop is a plain
 * multiply-add. Within the mel range (≤ 8 kHz) it agrees with Essentia's own resampling
 * (embedding cosine ≥ 0.999). */
const ZC = 24, CUT = 0.95;
const banks = new Map();
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
function bankFor(from, to) {
  const key = from + '>' + to;
  let b = banks.get(key);
  if (b) return b;
  const g = gcd(from, to), L = to / g, M = from / g;
  if (L > 2000) return null;                           // an odd rate: the generic path
  const w = (CUT * Math.min(from, to)) / from;         // cut-off relative to the input rate (2·fc/from)
  const half = ZC / w, K = Math.ceil(half), T = 2 * K;
  const taps = new Float32Array(L * T);
  for (let p = 0; p < L; p++) {
    const frac = p / L;
    for (let t = 0; t < T; t++) {
      const d = t - K + 1 - frac;                      // input index − output position
      const ad = Math.abs(d);
      if (ad > half) continue;
      const x = Math.PI * w * d, sinc = d === 0 ? 1 : Math.sin(x) / x, u = ad / half;
      taps[p * T + t] = w * sinc * (0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u));
    }
  }
  b = { L, M, K, T, taps };
  banks.set(key, b);
  return b;
}
export function resample(x, from, to = SR) {
  if (!from || from === to) return x;
  const b = bankFor(from, to);
  if (!b) {                                            // nearest-phase fallback for unusual rates
    const r = Math.round(from / 50) * 50; return r !== from && bankFor(r, to) ? resample(x, r, to) : x;
  }
  const { L, M, K, T, taps } = b, n = Math.floor((x.length * L) / M), out = new Float32Array(n), N = x.length;
  for (let j = 0; j < n; j++) {
    const pos = j * M, base = Math.floor(pos / L), p = pos - base * L, o = p * T, i0 = base - K + 1;
    let s = 0;
    if (i0 >= 0 && i0 + T <= N) for (let t = 0; t < T; t++) s += x[i0 + t] * taps[o + t];
    else for (let t = 0; t < T; t++) { const i = i0 + t; if (i >= 0 && i < N) s += x[i] * taps[o + t]; }
    out[j] = s;
  }
  return out;
}
