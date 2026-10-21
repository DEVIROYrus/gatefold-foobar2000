/*
 * Gatefold · loudness-worker.js — measures tracks off the page's thread (see loudness-core.js).
 *   { type:'begin', id, fs, ch }      a new track
 *   { type:'push',  id, planes, frames }   the next decoded piece (planes are transferred)
 *   { type:'end',   id }              → { id, result:{ lufs, peak, truePeak, hist, seconds } }
 *   { type:'drop',  id }              forget a track that will not be finished
 */
import { Meter } from './loudness-core.js';

const meters = new Map();
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'begin') meters.set(m.id, new Meter(m.fs, m.ch));
    else if (m.type === 'push') { const x = meters.get(m.id); if (x) x.push(m.planes, m.frames); }
    else if (m.type === 'end') {
      const x = meters.get(m.id); meters.delete(m.id);
      self.postMessage({ id: m.id, result: x ? x.result() : null });
    } else if (m.type === 'drop') meters.delete(m.id);
  } catch (err) {
    meters.delete(m.id);
    if (m.type === 'end' || m.type === 'push') self.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};
