/*
 * Gatefold · radio.js — «More like this»: an endless radio made only of your own files.
 *
 * Seed: a track (or an artist). Similar artists come from Deezer's public «related artists»
 * (no key, the same service the artist photos already use); only the ones present in the library
 * are kept. Around them: the seed artist itself now and then, and artists of the same genre from
 * the same era, so the radio still works offline or for artists Deezer does not know.
 * Tracks are picked with variety rules (no artist twice in a row, no album repeated soon, nothing
 * already played in this radio), written to a playlist «Radio: <artist>», and the playlist is
 * topped up with a new batch whenever playback gets near its end.
 */
import { call, ok, on, esc, log } from './bridge.js';
import { router, toast } from './ui.js';
import { getJSON } from './coverfetch.js';
import { norm, cleanArtist, similarity, isVarious } from './match.js';
import { $t } from './i18n.js';

let deps = null;                              // { getAllAlbums }
const R = { guid: '', seed: null, pool: null, played: new Set(), recentArtists: [], recentAlbums: [], busy: false };
const PREFIX = () => $t('Радио: ');

export function init(d) {
  deps = d;
  on('playback:trackChanged', () => topUp());
}

const yearOf = (a) => +((String(a.year || a.date || '').match(/\d{4}/) || [0])[0]) || 0;
const artistKey = (s) => norm(cleanArtist(s));
const enc = encodeURIComponent;

/** library artists: key → { name, albums[], genres:Set, years[] } */
async function libraryArtists() {
  const albums = await deps.getAllAlbums();
  const m = new Map();
  for (const a of albums) {
    const name = a.albumArtist || a.artist;
    if (!name || isVarious(name)) continue;
    const k = artistKey(name);
    if (!k) continue;
    let x = m.get(k);
    if (!x) m.set(k, (x = { key: k, name, albums: [], genres: new Set(), years: [] }));
    x.albums.push(a);
    for (const g of String(a.genre || '').split(/\s*[;/,]\s*/)) if (g) x.genres.add(g.toLowerCase());
    if (yearOf(a)) x.years.push(yearOf(a));
  }
  return m;
}

async function deezerRelated(name) {
  const s = await getJSON(`https://api.deezer.com/search/artist?q=${enc(cleanArtist(name))}&limit=8`);
  const cand = ((s && s.data) || []).map((d) => ({ id: d.id, fans: d.nb_fan || 0, sim: similarity(cleanArtist(name), d.name) }))
    .filter((d) => d.sim >= 0.86).sort((a, b) => b.sim - a.sim || b.fans - a.fans)[0];
  if (!cand) return [];
  const r = await getJSON(`https://api.deezer.com/artist/${cand.id}/related?limit=60`);
  return ((r && r.data) || []).map((d) => d.name);
}

/** weighted artists for a seed artist */
async function buildPool(seedName) {
  const lib = await libraryArtists();
  const seed = lib.get(artistKey(seedName)) || { key: artistKey(seedName), name: seedName, albums: [], genres: new Set(), years: [] };
  const pool = new Map();
  const add = (x, w, why) => { if (!x || !x.albums.length) return; const p = pool.get(x.key); if (!p || p.w < w) pool.set(x.key, { x, w, why }); };
  let related = [];
  try { related = await deezerRelated(seedName); } catch (e) { log('radio related', e); }
  related.forEach((n, i) => add(lib.get(artistKey(n)), 1 - i / Math.max(20, related.length) * 0.6, 'related'));
  // same genre and era: the fallback, and some breadth when Deezer knows few of yours
  const sy = seed.years.length ? seed.years.reduce((s, y) => s + y, 0) / seed.years.length : 0;
  if (seed.genres.size) {
    for (const x of lib.values()) {
      if (x.key === seed.key || pool.has(x.key)) continue;
      const shared = [...x.genres].filter((g) => seed.genres.has(g)).length;
      if (!shared) continue;
      const xy = x.years.length ? x.years.reduce((s, y) => s + y, 0) / x.years.length : 0;
      const era = sy && xy ? Math.max(0, 1 - Math.abs(sy - xy) / 25) : 0.5;
      add(x, 0.25 + 0.2 * era + 0.05 * Math.min(2, shared), 'genre');
    }
  }
  const relatedHits = [...pool.values()].filter((p) => p.why === 'related').length;
  add(seed, relatedHits ? 0.55 : 0.9, 'seed');
  return { seed, pool: [...pool.values()].sort((a, b) => b.w - a.w).slice(0, 60), relatedHits, deezer: related.length };
}

const pickWeighted = (list) => { const total = list.reduce((s, p) => s + p.w, 0); let r = Math.random() * total; for (const p of list) { r -= p.w; if (r <= 0) return p; } return list[list.length - 1]; };
const trackCache = new Map();
async function tracksOf(x) {
  if (trackCache.has(x.key)) return trackCache.get(x.key);
  const q = `"album artist" IS "${x.name.replace(/"/g, '')}" OR artist IS "${x.name.replace(/"/g, '')}"`;
  const r = await call('library.query', { query: q, limit: 400, fields: ['handle', 'absolutePath', 'subsong', 'title', 'artist', 'album', 'duration'] });
  const list = ok(r) ? (r.tracks || []).filter((t) => (t.duration || 0) > 45) : [];
  trackCache.set(x.key, list);
  return list;
}
const handleOf = (t) => t.handle || (t.subsong ? `${t.absolutePath}|subsong:${t.subsong}` : t.absolutePath);

async function nextBatch(n) {
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 8) {
    const cands = R.pool.pool.filter((p) => !R.recentArtists.slice(-2).includes(p.x.key));
    const p = pickWeighted(cands.length ? cands : R.pool.pool);
    if (!p) break;
    const tracks = (await tracksOf(p.x)).filter((t) => !R.played.has(handleOf(t)) && !R.recentAlbums.slice(-6).includes(t.album));
    if (!tracks.length) { p.w *= 0.3; continue; }
    const t = tracks[Math.floor(Math.random() * tracks.length)];
    out.push(t);
    R.played.add(handleOf(t)); R.recentArtists.push(p.x.key); R.recentAlbums.push(t.album);
    if (R.recentArtists.length > 20) R.recentArtists.shift();
    if (R.recentAlbums.length > 20) R.recentAlbums.shift();
  }
  return out;
}

async function radioPlaylist(name) {
  const all = await call('playlist.getAll');
  const ex = ((ok(all) && all.playlists) || []).find((p) => p.name.startsWith(PREFIX()));
  if (ex) {
    await call('playlist.clear', { playlistGuid: ex.guid });
    await call('playlist.rename', { playlistGuid: ex.guid, name });
    return ex.guid;
  }
  const c = await call('playlist.create', { name });
  return ok(c) ? c.guid : '';
}

/** start a radio from a track ({ title, artist, albumArtist, handle/path… }) or an artist name */
export async function start(seed) {
  if (!deps || R.busy) return;
  const seedName = typeof seed === 'string' ? seed : seed.artist || seed.albumArtist;
  if (!seedName) return;
  R.busy = true;
  toast($t('Собираю радио «{0}»…', esc(cleanArtist(seedName))), { ms: 2500 });
  try {
    R.pool = await buildPool(seedName);
    R.played = new Set(); R.recentArtists = []; R.recentAlbums = [];
    if (!R.pool.pool.length) { toast($t('Для «{0}» не нашлось похожей музыки в медиатеке', esc(seedName))); return; }
    const first = typeof seed === 'object' && handleOf(seed) ? [seed] : [];
    if (first.length) { R.played.add(handleOf(seed)); R.recentArtists.push(artistKey(seedName)); R.recentAlbums.push(seed.album); }
    const batch = first.concat(await nextBatch(25));
    const name = PREFIX() + cleanArtist(seedName);
    const guid = await radioPlaylist(name);
    if (!guid) { toast($t('Не удалось создать плейлист радио')); return; }
    const r = await call('playlist.addHandles', { playlistGuid: guid, handles: batch.map(handleOf) });
    if (!ok(r)) { toast($t('foobar2000 не добавил треки радио: {0}', esc(r.error || r.code || ''))); return; }
    R.guid = guid; R.seed = seedName;
    await call('playlist.setActive', { playlistGuid: guid });
    await call('playlist.playTrack', { playlistGuid: guid, index: 0 });
    router.go('playlist', guid);
    const kin = R.pool.relatedHits;
    toast(kin ? $t('Радио «{0}»: {1} похожих исполнителей из вашей медиатеки. Плейлист будет пополняться сам', esc(cleanArtist(seedName)), kin)
      : $t('Радио «{0}»: похожие по жанру и времени — Deezer не знает подходящих исполнителей из вашей медиатеки', esc(cleanArtist(seedName))), { ms: 7000 });
  } finally { R.busy = false; }
}

/* near the end of the radio playlist → add the next batch */
async function topUp() {
  if (!R.guid || R.busy) return;
  const pi = await call('playback.getCurrentTrackIndex');
  if (!ok(pi) || pi.found === false || pi.playlistGuid !== R.guid) return;
  const c = await call('playlist.getTrackCount', { playlistGuid: R.guid });
  const total = ok(c) ? (c.count ?? c.trackCount ?? c.total ?? 0) : 0;
  if (!total || pi.index < total - 3) return;
  R.busy = true;
  try {
    const more = await nextBatch(15);
    if (more.length) await call('playlist.addHandles', { playlistGuid: R.guid, handles: more.map(handleOf) });
  } finally { R.busy = false; }
}
export const active = () => R.guid;
