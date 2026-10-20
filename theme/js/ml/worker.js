/*
 * Gatefold · ml/worker.js — the neural network, off the interface thread.
 *
 * onnxruntime-web (WebAssembly, one thread, SIMD) runs Discogs-EffNet on mel patches of a track
 * and the small classification heads on its embeddings. One track at a time per worker (the
 * «Maximum» speed runs several); the window and foobar2000 never wait for it.
 *
 *   → { type:'init', manifest, wasm:ArrayBuffer, models:{ file → ArrayBuffer } }   ← { type:'ready', heads:[ids] }
 *   → { id, type:'analyze', pieces:[Float32Array], rates:[Hz] }   ← { id, emb, styles, heads:{ id → Float32Array }, share:{ id → Float32Array }, patches, ms }
 *     (pieces not at 16 kHz are resampled here)
 */
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { melFrames, patches, resample, PATCH, BANDS, SR } from './frontend.js';

let M = null, effnet = null;
const heads = [];

async function init(m) {
  M = m.manifest;
  ort.env.wasm.wasmBinary = m.wasm;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  effnet = await ort.InferenceSession.create(new Uint8Array(m.models[M.effnet.file]), opt);
  heads.length = 0;
  for (const h of M.heads) {
    const buf = m.models[h.file];
    if (!buf) continue;
    try { heads.push({ ...h, s: await ort.InferenceSession.create(new Uint8Array(buf), opt) }); } catch (e) { console.warn('head', h.id, e); }
  }
  return { type: 'ready', heads: heads.map((h) => h.id) };
}

const mean = (data, rows, cols) => {
  const o = new Float32Array(cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) o[c] += data[r * cols + c];
  for (let c = 0; c < cols; c++) o[c] /= rows || 1;
  return o;
};

async function analyze(pieces, rates, hop) {
  const t0 = performance.now();
  pieces = pieces.map((x, i) => resample(x, (rates && rates[i]) || SR, SR));
  const fr = M.framing || { centered: false, patchHop: 62 };
  const parts = pieces.map((x) => patches(melFrames(x, fr.centered), hop || fr.patchHop)).filter((p) => p.count);
  const n = parts.reduce((s, p) => s + p.count, 0);
  if (!n) return { emb: null };
  const all = new Float32Array(n * PATCH * BANDS);
  let o = 0; for (const p of parts) { all.set(p.data, o); o += p.data.length; }
  const shape = (M.effnet.inputShape || []).length === 4 ? [n, 1, PATCH, BANDS] : [n, PATCH, BANDS];
  const out = await effnet.run({ [M.effnet.input]: new ort.Tensor('float32', all, shape) });
  const E = out[M.effnet.embeddingOutput], A = out[M.effnet.activationOutput];
  const D = E.dims[E.dims.length - 1];
  const res = { emb: mean(E.data, n, D), styles: A ? mean(A.data, n, A.dims[A.dims.length - 1]) : null, heads: {}, patches: n };
  // heads see every patch embedding (as Essentia does), their outputs are averaged
  for (const h of heads) {
    try {
      const r = await h.s.run({ [h.input]: new ort.Tensor('float32', E.data, [n, D]) });
      const y = r[h.output];
      const C = y.dims[y.dims.length - 1] || 1;
      res.heads[h.id] = mean(y.data, n, C);
      // and how much of the track each class wins: a song with a long guitar solo averages
      // «half instrumental», but its voice still wins most patches
      const won = new Float32Array(C);
      for (let r = 0; r < n; r++) { let b = 0; for (let c = 1; c < C; c++) if (y.data[r * C + c] > y.data[r * C + b]) b = c; won[b]++; }
      for (let c = 0; c < C; c++) won[c] /= n || 1;
      (res.share ||= {})[h.id] = won;
    } catch (e) { console.warn('head run', h.id, e); }
  }
  res.ms = Math.round(performance.now() - t0);
  return res;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') postMessage({ id: m.id, ...(await init(m)) });
    else if (m.type === 'analyze') {
      const r = await analyze(m.pieces, m.rates, m.hop);
      const tr = [r.emb, r.styles, ...Object.values(r.heads || {}), ...Object.values(r.share || {})].filter(Boolean).map((a) => a.buffer);
      postMessage({ id: m.id, type: 'result', ...r }, tr);
    }
  } catch (err) { postMessage({ id: m.id, type: 'error', error: String((err && err.message) || err) }); }
};
