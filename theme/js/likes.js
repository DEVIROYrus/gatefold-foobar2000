/*
 * Gatefold · likes.js — «Понравившиеся».
 *
 * Likes live in an ordinary foobar2000 playlist named «Понравившиеся»: it shows up in
 * foobar's own UI, survives theme changes, can be edited, sorted or exported like any
 * other playlist. Gatefold keeps an in-memory index of its tracks (by handle: path plus
 * subsong) so the heart on every row and in the player is a Set lookup, and follows
 * edits made elsewhere through playlist events.
 */
import { call, ok, on, debounce, log } from './bridge.js';
import { lang } from './i18n.js';

/* the playlist keeps the name it was created with; switching the interface language must not
   start a second one, so every known name is recognised and a new one is named in the current language */
export const NAMES = ['Понравившиеся', 'Liked', 'Favoriten', 'Me gusta', '喜欢'];
export const NAME = { en: 'Liked', de: 'Favoriten', es: 'Me gusta', zh: '喜欢' }[lang] || 'Понравившиеся';
export const isLikedName = (n) => NAMES.includes(n);
export const events = new EventTarget();
const st = { guid: '', list: [], keys: new Set(), ready: null };
const key = (t) => String((t && (t.handle || t.absolutePath || t.path)) || '').toLowerCase();

async function findGuid() {
  const r = await call('playlist.getAll');
  const all = (ok(r) && r.playlists) || [];
  const p = all.find((x) => x.name === NAME) || all.find((x) => isLikedName(x.name));
  st.guid = p ? p.guid : '';
  return st.guid;
}
async function reload() {
  if (!st.guid) await findGuid();
  const list = [];
  if (st.guid) {
    for (let start = 0; start < 100000; start += 2000) {
      const r = await call('playlist.getTracks', { playlistGuid: st.guid, start, count: 2000, fields: ['handle'] });
      if (!ok(r)) break;
      for (const t of r.tracks || []) list.push(key(t));
      if (!r.tracks || r.tracks.length < 2000) break;
    }
  }
  st.list = list; st.keys = new Set(list);
  events.dispatchEvent(new Event('change'));
}
export function init() { if (!st.ready) st.ready = reload().catch((e) => log('likes', e)); return st.ready; }
export const has = (t) => st.keys.has(key(t));
export const count = () => st.list.length;
export const guid = () => st.guid;

export async function ensure() { return ensurePlaylist(); }
async function ensurePlaylist() {
  if (st.guid || await findGuid()) return st.guid;
  const c = await call('playlist.create', { name: NAME, position: 0 });       // first in the list
  if (!ok(c)) { log('likes: cannot create playlist', c.error); return ''; }
  st.guid = c.guid || (await findGuid());
  return st.guid;
}

/** Like / unlike a track (object with handle or path). Returns the new state. */
export async function toggle(t, want) {
  const k = key(t); if (!k) return false;
  const liked = st.keys.has(k), next = want ?? !liked;
  if (next === liked) return liked;
  // optimistic: the heart reacts at once, the playlist catches up
  if (next) { st.keys.add(k); st.list.push(k); } else { st.keys.delete(k); st.list = st.list.filter((x) => x !== k); }
  events.dispatchEvent(new CustomEvent('change', { detail: { key: k, liked: next } }));
  const g = await ensurePlaylist();
  if (!g) { await reload(); return has(t); }
  if (next) {
    const r = await call('playlist.addHandles', { playlistGuid: g, handles: [t.handle || t.absolutePath || t.path] });
    if (!ok(r)) { log('like failed', r.error); await reload(); }
  } else {
    // rows of this track in the playlist (read fresh: it may have been edited elsewhere)
    const rows = [];
    for (let start = 0; start < 100000; start += 2000) {
      const r = await call('playlist.getTracks', { playlistGuid: g, start, count: 2000, fields: ['handle'] });
      if (!ok(r)) break;
      (r.tracks || []).forEach((x, i) => { if (key(x) === k) rows.push(x.index ?? start + i); });
      if (!r.tracks || r.tracks.length < 2000) break;
    }
    if (rows.length) { const r = await call('playlist.removeTracks', { playlistGuid: g, items: rows }); if (!ok(r)) { log('unlike failed', r.error); await reload(); } }
  }
  return next;
}

// edits made in foobar itself (or another window) keep the index honest
const later = debounce(() => reload(), 400);
const mine = (d) => !d || !st.guid || d.playlistGuid === st.guid || d.guid === st.guid;
['playlist:itemsAdded', 'playlist:itemsRemoved', 'playlist:itemsReplaced'].forEach((ev) => on(ev, (d) => { if (mine(d)) later(); }));
['playlist:created', 'playlist:removed', 'playlist:renamed'].forEach((ev) => on(ev, () => { st.guid = ''; later(); }));
