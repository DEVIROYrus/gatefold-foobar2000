/*
 * Gatefold · bridge.js
 * Defensive wrapper over the native `fb2k` object injected by foo_ui_webview2.
 * - never throws: every call resolves to an envelope { success, ... }
 * - one native subscription per event name, fanned out locally
 * - tolerant to field-name drift between component versions
 */
import { $t } from './i18n.js';
let native = null;
const handlers = new Map();
const nativeSubscribed = new Set();

export const log = (...a) => console.log('%c[Gatefold]', 'color:#9cf', ...a);

export function waitForBridge(timeout = 10000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    (function poll() {
      if (window.fb2k && typeof window.fb2k.invoke === 'function') {
        native = window.fb2k;
        for (const ev of handlers.keys()) subscribeNative(ev);
        resolve(true); return;
      }
      if (performance.now() - t0 > timeout) { resolve(false); return; }
      setTimeout(poll, 20);
    })();
  });
}

export const hasBridge = () => !!native;
export const ok = (r) => !!r && r.success !== false;

export async function call(method, params) {
  if (!native) return { success: false, code: 'NO_BRIDGE', error: 'fb2k bridge not available' };
  try {
    const r = await native.invoke(method, params || {});
    return r == null ? { success: true } : r;
  } catch (e) {
    return { success: false, code: 'EXCEPTION', error: String((e && e.message) || e) };
  }
}

function subscribeNative(event) {
  if (!native || nativeSubscribed.has(event)) return;
  nativeSubscribed.add(event);
  try {
    native.on(event, (data) => {
      const set = handlers.get(event);
      if (!set) return;
      for (const h of set) { try { h(data || {}); } catch (e) { console.error('[Gatefold] handler', event, e); } }
    });
  } catch (e) { console.warn('[Gatefold] cannot subscribe', event, e); }
}

/** Modules register listeners at import time, before the bridge is confirmed;
 *  those are queued here and wired natively by waitForBridge(). */
export function on(event, fn) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  subscribeNative(event);
  return () => handlers.get(event)?.delete(fn);
}

/** Normalise any track-ish payload into one shape. */
export function normTrack(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.track && typeof t.track === 'object') t = t.track;
  else if (t.playing && typeof t.playing === 'object') t = t.playing;
  const path = t.absolutePath || t.fullPath || t.path || '';
  if (!path && !t.title) return null;
  const subsong = Number(t.subsong || 0);
  const handle = t.handle || (path ? (subsong ? `${path}|subsong:${subsong}` : path) : '');
  const first = (v) => (Array.isArray(v) ? v[0] : v) || '';
  return {
    title: t.title || (path ? path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : ''),
    artist: t.artist || (t.artists && t.artists.join(', ')) || '',
    album: t.album || '',
    albumArtist: first(t.albumArtists) || first(t.albumArtist) || first(t.artists) || t.artist || '',
    date: String(t.date || t.year || ''),
    year: (String(t.date || t.year || '').match(/\d{4}/) || [''])[0],
    genre: t.genre || '',
    trackNumber: t.trackNumber || '',
    discNumber: t.discNumber || '',
    duration: Number(t.duration || t.length || 0),
    codec: t.codec || '',
    bitrate: Number(t.bitrate || 0),
    sampleRate: Number(t.sampleRate || 0),
    channels: Number(t.channels || 0),
    path, subsong, handle,
    rawPath: t.path || path,
  };
}

export const albumKeyOf = (artist, album) =>
  (String(artist || '').toLowerCase().trim() + '\u0001' + String(album || '').toLowerCase().trim());

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** like debounce, but while the calls keep coming (an import of thousands of files arrives in many
 *  batches) `fn` runs at most once every `every` ms: the last call after a quiet `quiet` ms */
export function settle(fn, quiet, every) {
  let t = 0, last = -1e9;
  return (...a) => { clearTimeout(t); t = setTimeout(() => { last = performance.now(); fn(...a); }, Math.max(quiet, last + every - performance.now())); };
}
export function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? $t('{0} ч {1} мин', h, m) : $t('{0} мин', m);
}

export { plural } from './i18n.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- artwork URL versioning
/* The host serves fb2k://artwork with Cache-Control max-age=86400. After covers
   change on disk we bump a version that is appended to every artwork URL the UI
   loads (the host's parser ignores unknown query keys), so the WebView refetches. */
let artV = 0;
try { artV = +localStorage.getItem('aurora.artv') || 0; } catch {}
export function bumpArtV() { artV++; try { localStorage.setItem('aurora.artv', String(artV)); } catch {} }
/* Per-folder versions: replacing ONE album's cover must not refetch all 2000. */
const lcDir = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '').toLowerCase();
let dirV = {}, dirN = 0;
try { dirV = JSON.parse(localStorage.getItem('aurora.artv.dir') || '{}') || {}; dirN = Object.keys(dirV).length; } catch {}
export function bumpArtFor(path) {
  const d = lcDir(path); if (!d) return;
  dirV[d] = (dirV[d] || 0) + 1;
  const keys = Object.keys(dirV);
  if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete dirV[k];
  dirN = Object.keys(dirV).length;
  try { localStorage.setItem('aurora.artv.dir', JSON.stringify(dirV)); } catch {}
}
/** the cover size to ask foobar2000 for, in pixels: as big as the cover can be shown on this screen — the
    Canvas and full-screen Now Playing (up to 900 px, plus the slow zoom), times the display scaling — so a
    big cover is never stretched from a smaller copy. Steps of 128 keep foobar's cache from fragmenting. */
export function coverPx() {
  const sw = (window.screen && screen.width) || innerWidth, sh = (window.screen && screen.height) || innerHeight;
  const css = Math.min(900, 0.62 * Math.max(sh, 1), 0.62 * Math.max(sw, 1)) * 1.08;
  const px = css * (window.devicePixelRatio || 1);
  return Math.max(640, Math.min(2560, Math.ceil(px / 128) * 128));
}
export function artUrl(u) {
  if (!u || !/^fb2k:/i.test(u)) return u || '';
  let q = artV ? 'av=' + artV : '';
  if (dirN) {
    const m = u.match(/[?&]path=([^&]*)/);
    if (m) { let p = m[1]; try { p = decodeURIComponent(p); } catch {} const v = dirV[lcDir(p)]; if (v) q += (q ? '&' : '') + 'dv=' + v; }
  }
  return q ? u + (u.includes('?') ? '&' : '?') + q : u;
}

// ---------------------------------------------------------------- HTTP off foobar's UI thread
/* http.get with async:false runs WinHTTP *on foobar's main thread*: every cover
   download froze the whole window for its full network time (0.3–3 s). With
   async:true the host answers at once with a requestId, performs the request on
   a background thread and delivers an 'http:response' event (body serialised off
   the UI thread too). Falls back to the synchronous form if the host can't. */
const httpWait = new Map(), httpEarly = new Map();
let httpWired = false;
const normHttp = (d) => ({ success: d.success !== false && !d.cancelled, status: d.status, headers: d.headers || {}, body: d.body, error: d.error, code: d.code || (d.cancelled ? 'CANCELLED' : undefined) });
function wireHttp() {
  if (httpWired) return;
  httpWired = true;
  on('http:response', (d) => {
    if (!d || !d.requestId) return;
    const w = httpWait.get(d.requestId);
    if (w) { httpWait.delete(d.requestId); clearTimeout(w.t); w.res(normHttp(d)); }
    else { httpEarly.set(d.requestId, d); setTimeout(() => httpEarly.delete(d.requestId), 60000); }
  });
}
export const httpGet = (params) => httpReq('http.get', params);
export const httpPost = (params) => httpReq('http.post', params);
async function httpReq(method, params) {
  if (native) {
    wireHttp();
    const r = await call(method, { ...params, async: true });
    if (ok(r) && r.requestId && r.body === undefined && r.status === undefined) {
      const early = httpEarly.get(r.requestId);
      if (early) { httpEarly.delete(r.requestId); return normHttp(early); }
      return new Promise((res) => {
        const t = setTimeout(() => { httpWait.delete(r.requestId); call('http.abort', { requestId: r.requestId }); res({ success: false, code: 'TIMEOUT', error: 'timeout' }); }, (params.timeout || 30000) + 8000);
        httpWait.set(r.requestId, { res, t });
      });
    }
    // the host answered inline anyway, or refused this one request (a malformed URL, a bad header):
    // that is this request's answer. Never switch to the synchronous form for the rest of the session —
    // it runs WinHTTP on foobar2000's UI thread, and one bad URL from a lookup used to make every later
    // download freeze the player («Not responding») until restart. Every supported host (2.0+) is async.
    return r;
  }
  return call(method, { ...params, async: false });
}
