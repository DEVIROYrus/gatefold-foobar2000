/*
 * Gatefold · radio.js — «More like this»: an endless radio made only of your own files.
 *
 * Who: similar artists from Deezer's public «related artists» (no key; the service the artist
 * photos already use), one step further too — the related artists of the closest related ones —
 * and only those present in the library count. Genre neighbours fill in when that finds little,
 * but a genre almost every artist has («Metal», «Rock») says nothing and is ignored; rare, specific
 * genres weigh most.
 * How it sounds: tags put sad gothic doom and frantic mathcore under the same word, so the tracks
 * are chosen by how they sound. With «Sound analysis (AI)» on (ml/sound.js), every track has a
 * neural-network embedding and mood estimates: artists that *sound* like the seed join the
 * candidates even when no service relates them, and of each artist the track closest to the
 * seed's sound is played (all analysed tracks are compared, not a sample). Without it, a few
 * candidate tracks are measured on the spot (vibe.js: loudness, dynamics, brightness, attack, key).
 * Artists whose tracks keep sounding different fade out of the rotation, and so do artists whose
 * tracks you skip in the first 30 seconds; no artist gets more than 4 of any 25 tracks.
 * The first track plays at once; the rest is found while it plays and appended, and the playlist
 * is topped up whenever playback gets near its end.
 */
import { call, ok, on, esc, log } from './bridge.js';
import { router, toast } from './ui.js';
import { getJSON } from './coverfetch.js';
import { norm, cleanArtist, similarity, isVarious } from './match.js';
import * as Vibe from './vibe.js';
import * as Sound from './ml/sound.js';
import { $t } from './i18n.js';

let deps = null;                              // { getAllAlbums }
const R = { guid: '', seed: null, pool: null, played: new Set(), recentArtists: [], recentAlbums: [], busy: false, filling: false,
  target: null, seedVibe: null, dists: [], penalty: new Map(), now: null, gen: 0,
  seedSound: null, sTarget: null, sd: [] };
const CAP = 4, CAP_WINDOW = 25;
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
      // …but only artists that several of them point to: one path alone drifts away
      // (Anathema → Dream Theater → a guitar virtuoso's comic song)
      const hop = await Promise.all(first.slice(0, 10).map((r) => deezerRelated(r.id).catch(() => [])));
      const support = new Map();
      hop.forEach((list, j) => list.forEach((r, i) => {
        const x = lib.get(artistKey(r.name)); if (!x) return;
        const s = support.get(x.key) || { x, n: 0, w: 0 };
        s.n++; s.w = Math.max(s.w, (1 - 0.5 * i / Math.max(10, list.length)) * (1 - 0.04 * j));
        support.set(x.key, s);
      }));
      for (const s of support.values()) if (s.n >= 2) add(s.x, (0.2 + 0.08 * Math.min(4, s.n)) * s.w, 'related2');
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
  return { seed, pool: list, relatedHits, lib };
}

/* artists of the library that *sound* like the seed (nearest analysed tracks, grouped by artist) */
function soundNeighbours(P, T) {
  const near = Sound.nearest(T, 400, (r) => artistKey(r.aa || r.ar) !== P.seed.key);
  const by = new Map();
  for (const { r, d } of near) {
    const x = P.lib.get(artistKey(r.aa || r.ar)) || P.lib.get(artistKey(r.ar));
    if (!x || x.key === P.seed.key) continue;
    const a = by.get(x.key) || { x, ds: [] };
    if (a.ds.length < 3) a.ds.push(d);
    by.set(x.key, a);
  }
  const scored = [...by.values()].map((a) => ({ x: a.x, s: a.ds.reduce((s, d) => s + d, 0) / a.ds.length + (3 - a.ds.length) * 0.05 })).sort((a, b) => a.s - b.s).slice(0, 30);
  if (!scored.length) return 0;
  const lo = scored[0].s, hi = scored[scored.length - 1].s;
  let n = 0;
  for (const { x, s } of scored) {
    const w = 0.25 + 0.55 * (hi > lo ? (hi - s) / (hi - lo) : 1);
    const p = P.pool.find((q) => q.x.key === x.key);
    if (p) { if (p.why !== 'seed') { p.w = Math.max(p.w, w) + 0.2 * Math.min(p.w, w); p.why += '+sound'; } }
    else { P.pool.push({ x, w, why: 'sound' }); n++; }
  }
  return n;
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
  return Math.max(0.2, s[Math.floor(s.length * 0.35)]);
}
const blend = (a, b, k) => (a && b ? a.map((v, i) => v * (1 - k) + b[i] * k) : a || b);

async function pickOne(gen) {
  let bestAll = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (gen !== R.gen) return null;
    // variety: never the artist that just played; the one before it only rarely; at most 4 of any 25 tracks
    const last = R.recentArtists[R.recentArtists.length - 1], prev = R.recentArtists[R.recentArtists.length - 2];
    const recent = R.recentArtists.slice(-CAP_WINDOW);
    // (with the neural analysis only: the rough on-the-spot measurement is not sure enough to push artists out)
    // a small library: when every artist that sounds right has had its share, one more of theirs beats
    // a track that sounds wrong — after five misses the cap gives way («never twice in a row» does not)
    const capped = (k) => !!R.sTarget && attempt < 5 && recent.filter((x) => x === k).length >= CAP;
    const pl = R.pool.pool.map((p) => ({ p, w: p.w * (R.penalty.get(p.x.key) || 1) * (p.x.key === last || capped(p.x.key) ? 0 : p.x.key === prev ? 0.35 : 1) })).filter((c) => c.w > 0.01);
    if (!pl.length) { if (attempt < 5) { attempt = 4; continue; } return bestAll; }   // everyone that fits is capped → let the cap give way
    const p = pickWeighted(pl).p;
    const fresh = (await tracksOf(p.x)).filter((t) => !R.played.has(handleOf(t)));
    if (!fresh.length) { p.w *= 0.2; continue; }
    // prefer albums not heard lately; an artist with one or two albums may repeat one, just not back to back
    const lastAlbum = R.recentAlbums[R.recentAlbums.length - 1];
    let tracks = fresh.filter((t) => !R.recentAlbums.slice(-6).includes(t.album));
    if (!tracks.length) tracks = fresh.filter((t) => t.album !== lastAlbum);
    if (!tracks.length) { p.w *= 0.5; continue; }
    if (R.sTarget) {
      const best = await bySound(tracks, p, gen);
      if (best === 'none') { /* nothing of this artist analysed: measured the old way below */ }
      else {
        if (!best) { p.w *= 0.5; continue; }
        if (!bestAll || best.d < bestAll.d) bestAll = best;
        if (best.d <= sThreshold()) break;
        p.w *= 0.5;
        continue;
      }
    }
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
  if (bestAll && bestAll.v) R.target = blend(R.seedVibe, bestAll.v, 0.1);    // barely follow the music: the seed's feel stays the goal
  if (bestAll && bestAll.rec && R.seedSound) R.sTarget = Sound.blend(R.seedSound, bestAll.rec, 0.1);
  return bestAll;
}
function sThreshold() {
  if (R.sd.length < 6) return 0.7;
  const s = [...R.sd].sort((a, b) => a - b);
  return Math.max(0.3, s[Math.floor(s.length * 0.35)]);
}
/** of an artist's tracks, the one that sounds closest to the target (by the neural analysis);
 *  'none' when none of them has been analysed and analysing two of them now did not work */
async function bySound(tracks, p, gen) {
  let known = tracks.map((t) => ({ t, rec: Sound.get(t) })).filter((x) => x.rec);
  if (!known.length) {
    const recs = await Promise.all(sample(tracks, 2).map((t) => Sound.analyzeNow(t, 12000)));
    if (gen !== R.gen) return null;
    known = tracks.map((t) => ({ t, rec: Sound.get(t) })).filter((x) => x.rec);
    if (!known.length && !recs.some(Boolean)) return 'none';
  }
  Sound.prioritize(tracks, 25);                               // the rest of this artist, soon
  const scored = known.map((x) => ({ ...x, d: Sound.distance(R.sTarget, x.rec) })).sort((a, b) => a.d - b.d);
  for (const x of scored.slice(0, 3)) R.sd.push(x.d);
  if (R.sd.length > 200) R.sd.splice(0, R.sd.length - 200);
  // not always the single closest: a little randomness among the closest three keeps the radio alive
  const top = scored.slice(0, 3), lo = top[0].d;
  const pick = pickWeighted(top.map((x) => ({ ...x, w: Math.exp(-(x.d - lo) / 0.04) })));
  return { t: pick.t, d: pick.d, rec: pick.rec, p };
}
function take(x) {
  R.played.add(handleOf(x.t)); R.recentArtists.push(x.p.x.key); R.recentAlbums.push(x.t.album);
  if (R.recentArtists.length > CAP_WINDOW) R.recentArtists.shift();
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
    R.played = new Set(); R.recentArtists = []; R.recentAlbums = []; R.dists = []; R.penalty = new Map(); R.sd = [];
    R.seedSound = null; R.sTarget = null; R.seedVibe = null;
    const soundOn = Sound.ready();
    if (!R.pool.pool.length && !soundOn) { toast($t('Похожей музыки не нашлось')); return; }
    const name = PREFIX() + cleanArtist(seedName);
    const guid = await radioPlaylist(name);
    if (!guid) { toast($t('Не удалось создать плейлист радио')); return; }
    R.guid = guid; R.seed = seedName;
    R.now = null;
    if (seedTrack) {                                            // the seed plays at once; the rest is found meanwhile
      take({ t: seedTrack, p: { x: { key: artistKey(seedName) } } });
      await call('playlist.addHandles', { playlistGuid: guid, handles: [handleOf(seedTrack)] });
      await call('playlist.setActive', { playlistGuid: guid });
      await call('playlist.playTrack', { playlistGuid: guid, index: 0 });
      router.go('playlist', guid);
    }
    // the sound to follow (neural analysis): the seed track, or the average of the seed artist's analysed tracks
    if (soundOn) {
      if (typeof seed === 'object' && seedTrack) R.seedSound = Sound.target(await Sound.analyzeNow(seedTrack, 15000));
      else for (const t of await tracksOf(R.pool.seed)) { const r = Sound.get(t); if (r) R.seedSound = R.seedSound ? Sound.blend(R.seedSound, r, 0.3) : Sound.target(r); }
      if (!R.seedSound && seedTrack) R.seedSound = Sound.target(await Sound.analyzeNow(seedTrack, 15000));
      if (R.seedSound) { R.sTarget = R.seedSound; R.pool.soundHits = soundNeighbours(R.pool, R.seedSound); }
      warm(R.pool, gen);
    }
    if (!R.pool.pool.length) { toast($t('Похожей музыки не нашлось')); R.guid = ''; return; }
    if (seedTrack && !R.seedSound) R.seedVibe = await Vibe.of(seedTrack);
    R.target = R.seedVibe;
    // (no second toast: «Collecting radio…» said it; the playlist appears and fills by itself)
    if (!seedTrack) {
      await fill(1);
      await call('playlist.setActive', { playlistGuid: guid });
      await call('playlist.playTrack', { playlistGuid: guid, index: 0 });
      router.go('playlist', guid);
    }
    if (gen === R.gen) fill(24);
  } finally { R.busy = false; }
}

/* the candidates' tracks go to the front of the analysis queue (a few artists at a time, in the background) */
async function warm(P, gen) {
  for (const p of [...P.pool].sort((a, b) => b.w - a.w).slice(0, 16)) {
    if (gen !== R.gen) return;
    Sound.prioritize(await tracksOf(p.x), 22);
    await new Promise((r) => setTimeout(r, 400));
  }
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

/** «not this»: the artist leaves this radio, and its tracks not yet played leave the playlist */
export async function ban(name) {
  if (!R.guid || !name) return;
  const k = artistKey(name);
  R.penalty.set(k, 0);
  const pi = await call('playback.getCurrentTrackIndex');
  const from = ok(pi) && pi.found !== false && pi.playlistGuid === R.guid ? pi.index + 1 : 0;
  const c = await call('playlist.getTrackCount', { playlistGuid: R.guid });
  const total = ok(c) ? c.count || 0 : 0;
  if (total > from) {
    const r = await call('playlist.getTracks', { playlistGuid: R.guid, start: from, count: total - from, fields: ['artist', 'albumArtist'] });
    const items = ok(r) ? (r.tracks || []).map((t, i) => (artistKey(t.albumArtist || t.artist) === k || artistKey(t.artist) === k ? from + i : -1)).filter((i) => i >= 0) : [];
    if (items.length) await call('playlist.removeTracks', { playlistGuid: R.guid, items });
  }
  toast($t('{0} больше не попадёт в это радио', esc(cleanArtist(name))));
  topUp();
}
