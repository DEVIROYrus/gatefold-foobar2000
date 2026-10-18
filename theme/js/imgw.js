/* Gatefold · imgw.js — promise API over the image worker (main-thread fallback). */
import { ops } from './imgops.js';
import { log } from './bridge.js';

let w = null, seq = 0;
const pending = new Map();
try {
  w = new Worker(new URL('./imgworker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.ok ? p.res(e.data.res) : p.rej(new Error(e.data.err)); };
  w.onerror = (e) => { log('image worker failed → main thread', e.message || e); w = null; for (const p of pending.values()) p.retry(); pending.clear(); };
} catch (e) { w = null; }

export function img(op, args) {
  if (!w) return ops[op](args);
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej, retry: () => ops[op](args).then(res, rej) });
    w.postMessage({ id, op, args });
  });
}
