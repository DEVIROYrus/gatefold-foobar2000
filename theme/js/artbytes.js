/*
 * Gatefold · artbytes.js — get the BYTES of a cover (not just an <img>), robustly.
 *
 * Three transports, tried in order until one works on this machine; the
 * working one is remembered for the session:
 *   1. fetch('fb2k://artwork/…')            custom scheme, registered with allowed origins "*"
 *   2. fetch('https://foo-ui-webview2.local/fb2k-artwork/…')   same-origin route (gives readable ETag)
 *   3. artwork.getForTrack (bridge call)     original picture as base64 — always works,
 *                                            heavier (no scaling, crosses IPC), no ETag
 * A transport counts as broken only on a network-level failure (TypeError
 * "Failed to fetch"), never on an HTTP status: 404 means "no cover", not "broken".
 */
import { call, ok, log } from './bridge.js';
import { bgCall } from './sched.js';
import { img as imgOp } from './imgw.js';

import { $t } from './i18n.js';
const SAME_HOST = 'https://foo-ui-webview2.local';
const FB2K = /^fb2k:\/\/artwork\//i;
const order = ['fb2k', 'same', 'bridge'];
let mode = null;                    // the transport that worked
const dead = new Set();             // transports that failed at network level
export const artDiag = { mode: null, errors: {} };

function pathFromUrl(u) {
  try { const q = String(u).split('?')[1] || ''; return new URLSearchParams(q).get('path') || ''; } catch { return ''; }
}
function typeFromUrl(u) {
  try { const q = String(u).split('?')[1] || ''; return new URLSearchParams(q).get('type') || 'front'; } catch { return 'front'; }
}

async function viaFetch(kind, url, etag) {
  const target = kind === 'same' ? String(url).replace(FB2K, SAME_HOST + '/fb2k-artwork/') : url;
  const r = await fetch(target, { cache: etag ? 'no-store' : 'default', headers: etag ? { 'If-None-Match': etag } : undefined });
  if (r.status === 304) return { status: 304, via: kind };
  if (r.status === 404) return { status: 404, via: kind };
  if (!r.ok) return { status: r.status, via: kind };
  const blob = await r.blob();
  if (blob.size < 64) return { status: 404, via: kind };
  return { status: 200, blob, etag: r.headers.get('ETag') || '', via: kind };
}

async function viaBridge(url, path, priority) {
  const p = path || pathFromUrl(url);
  if (!p) return { status: 400, via: 'bridge' };
  // extraction + base64 of the original happen on foobar's UI thread → paced when it's background work
  const params = { path: p, type: typeFromUrl(url) };
  const r = priority ? await bgCall('artwork.getForTrack', params, priority) : await call('artwork.getForTrack', params);
  if (!ok(r)) {
    if (r.code === 'NO_BRIDGE' || r.code === 'EXCEPTION') throw new TypeError(r.error || 'bridge failed');
    return { status: 404, via: 'bridge' };
  }
  if (r.available === false || !r.dataUrl) return { status: 404, via: 'bridge' };
  return { status: 200, blob: await imgOp('fromDataUrl', { dataUrl: r.dataUrl, mime: r.mimeType }), etag: '', via: 'bridge', original: true };
}

/**
 * url: an fb2k://artwork/… URL (maxSize honoured by transports 1–2 only).
 * opts.path: the track path (used by transport 3; parsed from url otherwise).
 * opts.etag: conditional request (transports 1–2).
 * opts.priority: 'low' | 'normal' for background work (bridge transport is paced via sched.js).
 * → { status: 200|304|404|…, blob?, etag?, via, original? }
 */
export async function fetchArt(url, opts = {}) {
  const u = String(url || '');
  if (!FB2K.test(u) && /^(blob:|data:|https?:|\/)/i.test(u)) {
    // already a normal URL (thumbnail blob, test server…) — nothing to choose
    return viaFetch('plain', u, opts.etag);
  }
  const kinds = mode ? [mode, ...order.filter((k) => k !== mode && !dead.has(k))] : order.filter((k) => !dead.has(k));
  let lastErr = null;
  for (const kind of kinds) {
    if (kind !== 'bridge' && !FB2K.test(u)) continue;
    if (kind === 'same' && location.origin !== SAME_HOST) continue;
    try {
      const res = kind === 'bridge' ? await viaBridge(u, opts.path, opts.priority) : await viaFetch(kind, u, opts.etag);
      if (mode !== kind) { mode = kind; artDiag.mode = kind; log('artwork bytes via', kind); }
      return res;
    } catch (e) {
      lastErr = e;
      artDiag.errors[kind] = String(e && e.message || e);
      if (e instanceof TypeError) { dead.add(kind); if (mode === kind) mode = null; log('artwork transport failed:', kind, e.message); }
      else throw e;
    }
  }
  throw lastErr || new Error($t('нет способа прочитать обложку'));
}

/** True when bytes come through the bridge (no scaling, no ETag) — callers may want to slow down. */
export const heavyTransport = () => mode === 'bridge';
