/*
 * Gatefold · loudness-core.js — loudness as ITU-R BS.1770-4 / EBU R128 measure it, and the
 * ReplayGain 2.0 values that follow from it. Pure maths, no DOM: used by the worker
 * (loudness-worker.js), by loudness.js for whole albums, and by the tests in Node.
 *
 *   K-weighting   a high shelf (+4 dB above ~1.7 kHz, the head) and a high-pass (~38 Hz),
 *                 both as biquads derived for the actual sample rate (not only 48 kHz)
 *   blocks        400 ms, overlapping by 75 % (one every 100 ms); mean square per channel,
 *                 weighted 1.0 (L, R, C) or 1.41 (surrounds); LFE is left out
 *   gating        absolute −70 LUFS, then relative −10 LU below the mean of what is left
 *   album         the same gating over the blocks of every track at once — not an average
 *                 of the track values — so a quiet interlude counts for exactly its length
 *   true peak     4× oversampling (windowed-sinc polyphase) around the loudest samples
 *   mono          measured as dual mono (+3 dB): a mono file plays from both speakers
 *
 * Blocks are kept as a histogram (0.1 LU bins, with their summed power), so an album's
 * gating can be redone from the tracks' histograms without the audio.
 */
export const REF_LUFS = -18;                  // ReplayGain 2.0 reference loudness
const BIN = 0.1, LO = -70, HI = 10, NB = Math.round((HI - LO) / BIN);
const lufs = (power) => -0.691 + 10 * Math.log10(power);

/* ---------------------------------------------------------------- K-weighting */
export function kCoefs(fs) {
  // the BS.1770 filters re-derived for fs (the constants of libebur128 / pyloudnorm)
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

/** channel weights for `n` channels in WAVE order (L R C LFE Ls Rs …) */
export function weights(n) {
  if (n === 1) return [2];                       // dual mono
  if (n <= 3) return Array(n).fill(1);
  const w = Array(n).fill(1);
  if (n >= 6) { w[3] = 0; for (let c = 4; c < n; c++) w[c] = 1.41; }   // 5.1 / 7.1: LFE out, surrounds 1.41
  else if (n === 4) { w[2] = 1.41; w[3] = 1.41; }                        // quad
  else if (n === 5) { w[3] = 1.41; w[4] = 1.41; }                        // 5.0
  return w;
}

/* ---------------------------------------------------------------- true peak */
const TP_TAPS = 12, TP_PH = 4;
const TP = (() => {
  // phase p (1…3) of a 4× interpolator: value at n + p/4 from x[n-5 … n+6]
  const besselI0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  const beta = 6, half = TP_TAPS / 2, out = [];
  for (let p = 1; p < TP_PH; p++) {
    const h = new Float64Array(TP_TAPS);
    for (let k = 0; k < TP_TAPS; k++) {
      const t = (k - (half - 1)) - p / TP_PH;         // distance from the interpolated point
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const r = t / half;
      h[k] = Math.abs(r) >= 1 ? 0 : sinc * besselI0(beta * Math.sqrt(1 - r * r)) / besselI0(beta);
    }
    let s = 0; for (const v of h) s += v; for (let k = 0; k < TP_TAPS; k++) h[k] /= s;   // unity DC gain
    out.push(h);
  }
  return out;
})();

/* ---------------------------------------------------------------- histogram */
export const newHist = () => ({ n: new Float64Array(NB), p: new Float64Array(NB) });
function histAdd(H, power) {
  const L = lufs(power);
  if (!(L >= LO)) return;                          // absolute gate (and silence, NaN)
  const i = Math.min(NB - 1, Math.floor((L - LO) / BIN));
  H.n[i] += 1; H.p[i] += power;
}
export function histMerge(list) {
  const H = newHist();
  for (const h of list) { if (!h) continue; for (let i = 0; i < NB; i++) { H.n[i] += h.n[i]; H.p[i] += h.p[i]; } }
  return H;
}
/** gated integrated loudness of a histogram, LUFS; null when nothing is above −70 */
export function integrated(H) {
  let n = 0, p = 0;
  for (let i = 0; i < NB; i++) { n += H.n[i]; p += H.p[i]; }
  if (!n) return null;
  const rel = lufs(p / n) - 10;
  const from = Math.max(0, Math.ceil((rel - LO) / BIN - 1e-9));
  let n2 = 0, p2 = 0;
  for (let i = from; i < NB; i++) { n2 += H.n[i]; p2 += H.p[i]; }
  return n2 ? lufs(p2 / n2) : null;
}
/** compact form for postMessage / storage: [[bin, count, power], …] */
export const histPack = (H) => { const o = []; for (let i = 0; i < NB; i++) if (H.n[i]) o.push([i, H.n[i], H.p[i]]); return o; };
export const histUnpack = (a) => { const H = newHist(); for (const [i, n, p] of a || []) { H.n[i] = n; H.p[i] = p; } return H; };

/* ---------------------------------------------------------------- the meter */
export class Meter {
  constructor(fs, channels) {
    this.fs = fs; this.ch = channels;
    this.w = weights(channels);
    const [s, h] = kCoefs(fs);
    this.f = [s, h];
    this.z = Array.from({ length: channels }, () => new Float64Array(4));   // two biquads × two states
    this.sub = Math.round(fs / 10);                // 100 ms
    this.acc = new Float64Array(channels); this.fill = 0;
    this.ring = []; this.hist = newHist();
    this.peak = 0; this.tp = 0;
    this.tail = Array.from({ length: channels }, () => new Float32Array(0));
    this.frames = 0;
  }
  /** planes: one Float32Array per channel, each at least `frames` long */
  push(planes, frames) {
    const [s, h] = this.f, sub = this.sub, sums = [];
    let end = this.fill;
    for (let c = 0; c < this.ch; c++) {
      const wc = this.w[c]; if (!wc) continue;
      const x = planes[c], z = this.z[c];
      let s1 = z[0], s2 = z[1], h1 = z[2], h2 = z[3], pos = this.fill, acc = this.acc[c], bi = 0;
      for (let i = 0; i < frames; i++) {               // two biquads, transposed direct form II
        const v = x[i];
        const y1 = s.b0 * v + s1; s1 = s.b1 * v - s.a1 * y1 + s2; s2 = s.b2 * v - s.a2 * y1;
        const y2 = h.b0 * y1 + h1; h1 = h.b1 * y1 - h.a1 * y2 + h2; h2 = h.b2 * y1 - h.a2 * y2;
        acc += y2 * y2;
        if (++pos === sub) { sums[bi] = (sums[bi] || 0) + (acc / sub) * wc; bi++; acc = 0; pos = 0; }
      }
      z[0] = s1; z[1] = s2; z[2] = h1; z[3] = h2;
      this.acc[c] = acc; end = pos;
    }
    this.fill = end;
    // each finished 100 ms sub-block closes a 400 ms block (75 % overlap)
    for (const v of sums) {
      this.ring.push(v); if (this.ring.length > 4) this.ring.shift();
      if (this.ring.length === 4) histAdd(this.hist, (this.ring[0] + this.ring[1] + this.ring[2] + this.ring[3]) / 4);
    }
    this.frames += frames;
    for (let c = 0; c < this.ch; c++) this.peaks(c, planes[c], frames);
  }
  /* sample peak, and the true peak between samples: a 4× interpolation evaluated next to the
     loudest samples only (where an inter-sample peak can be), continuous across chunks */
  peaks(c, x, frames) {
    let pk = this.peak;
    for (let i = 0; i < frames; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > pk) pk = a; }
    this.peak = pk;
    const prev = this.tail[c], n = prev.length + frames;
    const y = new Float32Array(n); y.set(prev); y.set(x.subarray(0, frames), prev.length);
    // only between two samples of one sign that are both near the top: the half-way point first
    // (an over sits around it), the quarter points only when that one already rises above both
    let tp = Math.max(this.tp, pk), thr = tp * 0.75;
    const [q1, mid, q3] = TP;
    for (let i = 5; i + 6 < n; i++) {
      const u = y[i], w = y[i + 1];
      if ((u > 0) !== (w > 0)) continue;
      const a = u < 0 ? -u : u, b = w < 0 ? -w : w;
      if (a < thr || b < thr) continue;
      let v = 0; for (let k = 0; k < TP_TAPS; k++) v += mid[k] * y[i - 5 + k];
      if (v < 0) v = -v;
      if (v <= (a > b ? a : b)) continue;
      if (v > tp) { tp = v; thr = tp * 0.75; }
      for (const hh of [q1, q3]) {
        let x2 = 0; for (let k = 0; k < TP_TAPS; k++) x2 += hh[k] * y[i - 5 + k];
        if (x2 < 0) x2 = -x2;
        if (x2 > tp) { tp = x2; thr = tp * 0.75; }
      }
    }
    this.tp = tp;
    this.tail[c] = y.slice(Math.max(0, n - 11));
  }
  result() {
    return { lufs: integrated(this.hist), peak: this.peak, truePeak: Math.max(this.tp, this.peak), hist: histPack(this.hist), seconds: this.frames / this.fs };
  }
}

/* ---------------------------------------------------------------- ReplayGain values */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** gain to bring `lufs` to the ReplayGain reference (−18 LUFS), in dB */
export const gainOf = (L) => (L == null ? null : clamp(REF_LUFS - L, -51, 51));
export const fmtGain = (g) => `${g >= 0 ? '+' : ''}${g.toFixed(2)} dB`;
export const fmtPeak = (p) => Math.max(0, p).toFixed(6);

/** album values from the tracks' results ({ hist, truePeak }) */
export function album(results) {
  const ok = results.filter((r) => r && r.hist);
  const L = integrated(histMerge(ok.map((r) => histUnpack(r.hist))));
  const peak = ok.reduce((m, r) => Math.max(m, r.truePeak || 0), 0);
  return { lufs: L, gain: gainOf(L), peak };
}
