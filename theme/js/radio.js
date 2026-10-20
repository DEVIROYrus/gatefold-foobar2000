/*
 * Gatefold · radio.js — «More like this»: an endless radio made only of your own files.
 *
 * Who: similar artists from Deezer's public «related artists» (no key; the service the artist
 * photos already use), one step further too — the related artists of the closest related ones —
 * and only those present in the library count. Genre neighbours fill in when that finds little,
 * but a genre almost every artist has («Metal», «Rock») says nothing and is ignored; rare, specific
 * genres weigh most.
 * How it sounds: tags put sad gothic doom and frantic mathcore under the same word, so every
 * candidate track is also listened to (vibe.js: loudness, dynamics, brightness, attack, tempo) and
 * the one closest to the seed's feel wins; artists whose tracks keep sounding different fade out
 * of the rotation, and so do artists whose tracks you skip in the first 30 seconds.
 * The first track plays at once; the rest is found while it plays and appended, and the playlist
 * is topped up whenever playback gets near its end.
 */
import { call, ok, on, esc, log } from './bridge.js';
import { router, toast } from './ui.js';
import { getJSON } from './coverfetch.js';
import { norm, cleanArtist, similarity, isVarious } from './match.js';
import * as Vibe from './vibe.js';
import { $t } from './i18n.js';

let deps = null;                              // { getAllAlbums }
const R = { guid: '', seed: null, pool: null, played: new Set(), recentArtists: [], recentAlbums: [], busy: false, filling: false,
  target: null, seedVibe: null, dists: [], penalty: new Map(), now: null, gen: 0 };
const PREFIX = () => $t('Радио: ');

export function init(d) {
  deps = d;
  on('playback:trackChanged', (t) => { noteSkip(t); topUp(); });
}

const yearOf = (a) => +((String(a.year || a.date || '').match(/\d{4}/) || [0])[0]) || 0;
const artistKey = (s) => norm(cleanArtist(s));
const enc = encodeURIComponent;
const handleOf = (t) => t.handle || (t.subsong ? `${t.absolutePath}|subsong:${t.subsong}` : t.absolutePath);
const splitGenres = (g) => String(g || '').split(/\s*[;/,|]\s*/).map((x) => x.trim().toLowerCase()).filter(Boolean);

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
    for (const g of splitGenres(a.genre)) x.genres.add(g);
    if (yearOf(a)) x.years.push(yearOf(a));
  }
  return m;
}

/* ---------------------------------------------------------------- who */
async function deezerArtist(name) {
  const s = await getJSON(`https://api.deezer.com/search/artist?q=${enc(cleanArtist(name))}&limit=8`);
  return ((s && s.data) || []).map((d) => ({ id: d.id, fans: d.nb_fan || 0, sim: similarity(cleanArtist(name), d.name) }))
    .filter((d) => d.sim >= 0.86).sort((a, b) => b.sim - a.sim || b.fans - a.fans)[0] || null;
}
async function deezerRelated(id) {
  const r = await getJSON(`https://api.deezer.com/artist/${id}/related?limit=40`);
  return ((r && r.data) || []).map((d) => ({ id: d.id, name: d.name }));
}

async function buildPool(seedName) {
  const lib = await libraryArtists();
  const seed = lib.get(artistKey(seedName)) || { key: artistKey(seedName), name: seedName, albums: [], genres: new Set(), years: [] };
  const pool = new Map();
  const add = (x, w, why) => { if (!x || !x.albums.length || x.key === seed.key) return; const p = pool.get(x.key); if (!p || p.w < w) pool.set(x.key, { x, w, why }); };
  let first = [];
  try {
    const d = await deezerArtist(seedName);
    if (d) {
      first = await deezerRelated(d.id);
      first.forEach((r, i) => add(lib.get(artistKey(r.name)), 1 - 0.5 * i / Math.max(10, first.length), 'related'));
      // one step further: the related artists of the closest related ones (same scene, often the ones you own)
      const hop = await Promise.all(first.slice(0, 6).map((r) => deezerRelated(r.id).catch(() => [])));
      hop.forEach((list, j) => list.forEach((r, i) => add(lib.get(artistKey(r.name)), 0.5 * (1 - 0.5 * i / Math.max(10, list.length)) * (1 - 0.06 * j), 'related2')));
    }
  } catch (e) { log('radio related', e); }
  const relatedHits = [...pool.values()].length;
  // genre neighbours, weighted by how specific the shared genres are (IDF); common ones ignored
  if (seed.genres.size && relatedHits < 8) {
    const df = new Map(); for (const x of lib.values()) for (const g of x.genres) df.set(g, (df.get(g) || 0) + 1);
    const N = Math.max(1, lib.size);
    const idf = (g) => { const d = df.get(g) || 1; return d / N > 0.3 ? 0 : Math.log(N / d); };
    const seedIdf = [...seed.genres].reduce((s, g) => s + idf(g), 0);
    const sy = seed.years.length ? seed.years.reduce((s, y) => s + y, 0) / seed.years.length : 0;
    if (seedIdf > 0) for (const x of lib.values()) {
      if (pool.has(x.key) || x.key === seed.key) continue;
      const shared = [...x.genres].filter((g) => seed.genres.has(g)).reduce((s, g) => s + idf(g), 0);
      if (!shared) continue;
      const xy = x.years.length ? x.years.reduce((s, y) => s + y, 0) / x.years.length : 0;
      const era = sy && xy ? Math.max(0.2, 1 - Math.abs(sy - xy) / 25) : 0.6;
      add(x, 0.35 * (shared / seedIdf) * era, 'genre');
    }
  }
  const list = [...pool.values()].sort((a, b) => b.w - a.w).slice(0, 50);
  if (seed.albums.length) list.push({ x: seed, w: list.length ? 0.45 : 1, why: 'seed' });
  return { seed, pool: list, relatedHits };
}

/* ---------------------------------------------------------------- what */
const pickWeighted = (list) => { const total = list.reduce((s, p) => s + p.w, 0); let r = Math.random() * total; for (const p of list) { r -= p.w; if (r <= 0) return p; } return list[list.length - 1]; };
const trackCache = new Map();
async function tracksOf(x) {
  if (trackCache.has(x.key)) return trackCache.get(x.key);
  const q = `"album artist" IS "${x.name.replace(/"/g, '')}" OR artist IS "${x.name.replace(/"/g, '')}"`;
  const r = await call('library.query', { query: q, limit: 400, fields: ['handle', 'absolutePath', 'subsong', 'title', 'artist', 'albumArtist', 'album', 'duration'] });
  const list = ok(r) ? (r.tracks || []).filter((t) => (t.duration || 0) > 45) : [];
  trackCache.set(x.key, list);
  return list;
}
const sample = (arr, n) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
/** the distance a candidate may have: the better half of what has been heard so far, never stricter than 0.22 */
function threshold() {
  if (R.dists.length < 6) return 0.55;
  const s = [...R.dists].sort((a, b) => a - b);
  return Math.max(0.22, s[Math.floor(s.length * 0.45)]);
}
const blend = (a, b, k) => (a && b ? a.map((v, i) => v * (1 - k) + b[i] * k) : a || b);

async function pickOne(gen) {
  let bestAll = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (gen !== R.gen) return null;
    // variety: never the artist that just played; the one before it only rarely
    const last = R.recentArtists[R.recentArtists.length - 1], prev = R.recentArtists[R.recentArtists.length - 2];
    const pl = R.pool.pool.map((p) => ({ p, w: p.w * (R.penalty.get(p.x.key) || 1) * (p.x.key === last ? 0 : p.x.key === prev ? 0.35 : 1) })).filter((c) => c.w > 0.01);
    if (!pl.length) return bestAll;
    const p = pickWeighted(pl).p;
    const fresh = (await tracksOf(p.x)).filter((t) => !R.played.has(handleOf(t)));
    if (!fresh.length) { p.w *= 0.2; continue; }
    // prefer albums not heard lately; an artist with one or two albums may repeat one, just not back to back
    const lastAlbum = R.recentAlbums[R.recentAlbums.length - 1];
    let tracks = fresh.filter((t) => !R.recentAlbums.slice(-6).includes(t.album));
    if (!tracks.length) tracks = fresh.filter((t) => t.album !== lastAlbum);
    if (!tracks.length) { p.w *= 0.5; continue; }
    const options = sample(tracks, R.target ? 3 : 1);
    if (!R.target) return { t: options[0], p };
    let best = null;
    for (const t of options) {
      const v = await Vibe.of(t);
      const d = v ? Vibe.distance(R.target, v) : 0.6;
      if (v) R.dists.push(d);
      if (!best || d < best.d) best = { t, d, v, p };
    }
    if (R.dists.length > 200) R.dists.splice(0, R.dists.length - 200);
    if (!bestAll || best.d < bestAll.d) bestAll = best;
    if (best.d <= threshold()) break;
    p.w *= 0.5;                                               // this artist sounds different from the seed
  }
  if (bestAll && bestAll.v) R.target = blend(R.seedVibe, bestAll.v, 0.25);   // follow the music a little, anchored to the seed
  return bestAll;
}
function take(x) {
  R.played.add(handleOf(x.t)); R.recentArtists.push(x.p.x.key); R.recentAlbums.push(x.t.album);
  if (R.recentArtists.length > 20) R.recentArtists.shift();
  if (R.recentAlbums.length > 20) R.recentAlbums.shift();
}
/** find `n` tracks and append them, a few at a time, while the music plays */
async function fill(n) {
  if (R.filling) return;
  R.filling = true;
  const gen = R.gen;
  try {
    let buf = [];
    for (let i = 0; i < n; i++) {
      const x = await pickOne(gen);
      if (!x || gen !== R.gen) break;
      take(x); buf.push(handleOf(x.t));
      if (buf.length >= (i < 4 ? 1 : 4)) { await call('playlist.addHandles', { playlistGuid: R.guid, handles: buf }); buf = []; }
    }
    if (buf.length && gen === R.gen) await call('playlist.addHandles', { playlistGuid: R.guid, handles: buf });
  } catch (e) { log('radio fill', e); } finally { R.filling = false; }
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
  const gen = ++R.gen;
  toast($t('Собираю радио «{0}»…', esc(cleanArtist(seedName))), { ms: 2500 });
  try {
    const poolP = buildPool(seedName);
    // the feel to follow: the seed track itself, or a few tracks of the seed artist
    let seedTrack = typeof seed === 'object' && handleOf(seed) ? seed : null;
    R.pool = await poolP;
    if (!seedTrack && R.pool.seed.albums.length) seedTrack = sample(await tracksOf(R.pool.seed), 1)[0] || null;
    R.played = new Set(); R.recentArtists = []; R.recentAlbums = []; R.dists = []; R.penalty = new Map();
    if (!R.pool.pool.length) { toast($t('Для «{0}» не нашлось похожей музыки в медиатеке', esc(seedName))); return; }
    const name = PREFIX() + cleanArtist(seedName);
    const guid = await radioPlaylist(name);
    if (!guid) { toast($t('Не удалось создать плейлист радио')); return; }
    R.guid = guid; R.seed = seedName;
    R.now = null;
    if (seedTrack) {
      take({ t: seedTrack, p: { x: { key: artistKey(seedName) } } });
      await call('playlist.addHandles', { playlistGuid: guid, handles: [handleOf(seedTrack)] });
      await call('playlist.setActive', { playlistGuid: guid });
      await call('playlist.playTrack', { playlistGuid: guid, index: 0 });
      router.go('playlist', guid);
      R.seedVibe = await Vibe.of(seedTrack);
    } else R.seedVibe = null;
    R.target = R.seedVibe;
    const kin = R.pool.relatedHits;
    toast((kin ? $t('Радио «{0}»: {1} похожих исполнителей из вашей медиатеки.', esc(cleanArtist(seedName)), kin)
      : $t('Радио «{0}»: Deezer не знает похожих исполнителей из вашей медиатеки — подбираю по жанру.', esc(cleanArtist(seedName))))
      + ' ' + (R.seedVibe ? $t('Треки подбираются и по звучанию — плейлист пополняется, пока играет музыка') : $t('Плейлист пополняется, пока играет музыка')), { ms: 8000 });
    if (!seedTrack) {
      await fill(1);
      await call('playlist.setActive', { playlistGuid: guid });
      await call('playlist.playTrack', { playlistGuid: guid, index: 0 });
      router.go('playlist', guid);
    }
    if (gen === R.gen) fill(24);
  } finally { R.busy = false; }
}

/* a radio track skipped in its first 30 seconds: its artist comes up less */
function noteSkip(d) {
  const now = performance.now();
  const prev = R.now;
  R.now = d ? { key: artistKey(d.artist || d.albumArtist || ''), t0: now } : null;
  if (!R.guid || !prev || !prev.key) return;
  if (now - prev.t0 < 30000) R.penalty.set(prev.key, (R.penalty.get(prev.key) || 1) * 0.4);
}

/* near the end of the radio playlist → add the next batch */
async function topUp() {
  if (!R.guid || R.busy || R.filling) return;
  const pi = await call('playback.getCurrentTrackIndex');
  if (!ok(pi) || pi.found === false || pi.playlistGuid !== R.guid) { if (ok(pi) && pi.found !== false && pi.playlistGuid !== R.guid) R.now = null; return; }
  const c = await call('playlist.getTrackCount', { playlistGuid: R.guid });
  const total = ok(c) ? (c.count ?? 0) : 0;
  if (!total || pi.index < total - 4) return;
  fill(15);
}
export const active = () => R.guid;
