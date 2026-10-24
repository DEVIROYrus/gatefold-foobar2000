/*
 * Gatefold · trackstore.js — every track of the library, read once and shared.
 *
 * Three parts of Gatefold need the whole library as tracks: the editions and artist names of the album
 * grid (library.js), Library → Folders (folders.js) and Library → Tracks (tracks.js). They used to ask
 * foobar2000 separately; now one query (only the fields they show, so the answer stays small) serves all
 * three until the library changes. foobar2000 hands such an answer to the page on its UI thread, about
 * 20 ms per megabyte, so asking once instead of three times is what keeps a big library smooth.
 *
 * Library → Tracks also keeps the last list on disk (IndexedDB), so that screen opens at once after a
 * restart and is brought up to date in the background.
 */
import { ok, on, log } from './bridge.js';
import { bgCall } from './sched.js';
import { settings } from './settings.js';
import * as IDB from './idb.js';

export const FIELDS = ['handle', 'title', 'artist', 'artists', 'album', 'albumArtist', 'albumArtists', 'absolutePath', 'subsong',
  'trackNumber', 'discNumber', 'duration', 'date', 'genre', 'codec', 'sampleRate', 'bitrate'];
const SNAP = 'tracks.snap.v1';

const S = { data: null, stale: true, loading: null, gen: 0, snap: null };
export const events = new EventTarget();
/* any change in the library: the next reader asks again (the screens that show it refresh themselves) */
for (const ev of ['library:itemsAdded', 'library:itemsRemoved', 'library:itemsModified', 'library:initialized']) on(ev, () => { S.stale = true; });

/** the library's tracks, current (one query when something changed since the last one) */
export function all() {
  if (S.data && !S.stale) return Promise.resolve(S.data);
  if (S.loading) return S.loading;
  S.stale = false;                                     // a change while this runs marks it stale again
  S.loading = (async () => {
    const t0 = performance.now();
    const r = await bgCall('library.query', { query: 'ALL', limit: 1000000, fields: FIELDS }, 'normal');
    if (!ok(r)) { S.stale = true; return S.data || []; }
    S.data = r.tracks || []; S.gen++;
    log('tracks:', S.data.length, 'in', Math.round(performance.now() - t0), 'ms');
    events.dispatchEvent(new Event('change'));
    if (settings.libMode === 'tracks') saveSnap();
    return S.data;
  })().finally(() => { S.loading = null; });
  return S.loading;
}
/** what is known now without asking: the current list, else the one kept on disk (or null) */
export async function peek() {
  if (S.data) return S.data;
  if (S.snap === null) S.snap = (await IDB.kvGet(SNAP, null).catch(() => null)) || false;
  return S.snap ? S.snap.tracks : null;
}
export const fresh = () => !!S.data && !S.stale;
export const generation = () => S.gen;
let snapT = 0;
function saveSnap() {
  clearTimeout(snapT);
  // written when the page is idle: a big library is several megabytes to copy
  snapT = setTimeout(() => {
    const go = () => IDB.kvSet(SNAP, { tracks: S.data, t: Date.now() }).catch(() => {});
    if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 8000 }); else go();
  }, 3000);
}
export function keep() { if (S.data) saveSnap(); }
