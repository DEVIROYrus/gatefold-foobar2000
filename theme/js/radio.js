/*
 * Gatefold · radio.js — «More like this»: an endless radio made only of your own files.
 *
 * Started from a track (Now Playing, a playlist row) the radio is that track's — named after it,
 * steered by its sound — and from an artist it is the artist's. This module gathers the facts;
 * radio-core.js decides (see there for how). The facts:
 *   people     Deezer's related artists (and the ones several of them agree on), ListenBrainz's
 *              artists listened to in the same sessions (by MusicBrainz id), your own playlists;
 *   genres     MusicBrainz genres of every artist (ml/genres.js looks them up in the background),
 *              or your own genre tags when it has none;
 *   sound      with «Sound analysis (AI)»: the distance of every analysed track to the seed, read as
 *              a percentile of your whole library, and the Discogs styles the network hears;
 *              without it, a few tracks of each artist are measured on the spot (vibe.js);
 *   tracks     an artist's best-known songs (its top tracks on Deezer) and your play counts.
 * Answers from the services are kept for two weeks, so the next radio of the artist starts at once.
 * The seed plays at once; the rest is found while it plays and appended, and the playlist is topped
 * up whenever playback gets near its end.
 */
import { call, ok, on, esc, log } from './bridge.js';
import { router, toast } from './ui.js';
import { getJSON } from './coverfetch.js';
import { norm, cleanArtist, similarity, isVarious } from './match.js';
import * as Vibe from './vibe.js';
import * as Sound from './ml/sound.js';
import * as Genres from './ml/genres.js';
import * as IDB from './idb.js';
import * as Core from './radio-core.js';
import { NAME as LIKED } from './likes.js';
import { $t } from './i18n.js';

let deps = null;                              // { getAllAlbums }
const R = { guid: '', gen: 0, busy: false, filling: 0, planner: null, ctx: null, now: null, skipRecs: [] };
const PREFIX = () => $t('Радио: ');
const WEB_KEY = 'radio.web.v1', TOP_KEY = 'radio.top.v1', WEB_TTL = 14 * 864e5;
const LB = 'https://labs.api.listenbrainz.org/similar-artists/json?algorithm=session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30&artist_mbids=';

export function init(d) {
  deps = d;
  on('playback:trackChanged', (t) => { noteSkip(t); topUp(); });
}

const yearOf = (a) => +((String(a.year || a.date || '').match(/\d{4}/) || [0])[0]) || 0;
const artistKey = (s) => norm(cleanArtist(s));
const enc = encodeURIComponent;
const handleOf = (t) => t.handle || (t.subsong ? `${t.absolutePath}|subsong:${t.subsong}` : t.absolutePath);
const sample = (arr, n) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
const within = (p, ms, dflt = null) => Promise.race([p.catch((e) => { log('radio', e); return dflt; }), new Promise((r) => setTimeout(() => r(dflt), ms))]);
const recArtist = (r) => (r.aa && !isVarious(r.aa) ? r.aa : r.ar);

/* ---------------------------------------------------------------- the library */
/** artists: key → { key, name, albums[], tags: Set, years[] } — from the albums, and from the analysed
 *  tracks (an artist you have only on compilations is still an artist of the library) */
async function libraryArtists() {
  const albums = await deps.getAllAlbums();
  const m = new Map();
  const get = (name) => {
    const k = artistKey(name); if (!k) return null;
    let x = m.get(k);
    if (!x) m.set(k, (x = { key: k, name, albums: [], tags: new Set(), years: [] }));
    return x;
  };
  for (const a of albums) {
    const name = a.albumArtist || a.artist;
    if (!name || isVarious(name)) continue;
    const x = get(name); if (!x) continue;
    x.albums.push(a);
    for (const g of Genres.specificTags(a.genre)) x.tags.add(g);
    if (yearOf(a)) x.years.push(yearOf(a));
  }
  if (Sound.ready()) for (const r of Sound.all()) { const n = recArtist(r); if (n && !isVarious(n)) get(n); }
  return m;
}
const tracksCache = new Map();
async function queryTracks(name) {
  const k = artistKey(name);
  if (tracksCache.has(k)) return tracksCache.get(k);
  const q = `"album artist" IS "${name.replace(/"/g, '')}" OR artist IS "${name.replace(/"/g, '')}"`;
  const r = await call('library.query', { query: q, limit: 500, fields: ['handle', 'absolutePath', 'subsong', 'title', 'artist', 'albumArtist', 'album', 'duration'] });
  const list = ok(r) ? (r.tracks || []).filter((t) => (t.duration || 0) > 45) : [];
  tracksCache.set(k, list);
  setTimeout(() => tracksCache.delete(k), 10 * 60000);
  return list;
}

/* ---------------------------------------------------------------- people: Deezer, ListenBrainz, your playlists */
let webCache = null;
const webStore = async () => (webCache ||= (await IDB.kvGet(WEB_KEY, null)) || {});
async function remembered(kind, key, fetcher) {
  const c = await webStore(), id = kind + ':' + key, hit = c[id];
  if (hit && Date.now() - hit.at < WEB_TTL) return hit.v;
  const v = await fetcher();
  if (v != null) { c[id] = { at: Date.now(), v }; IDB.kvSet(WEB_KEY, c); }
  return v;
}

async function deezerArtist(name) {
  const s = await getJSON(`https://api.deezer.com/search/artist?q=${enc(cleanArtist(name))}&limit=8`);
  if (!s) return null;
  return ((s && s.data) || []).map((d) => ({ id: d.id, fans: d.nb_fan || 0, sim: similarity(cleanArtist(name), d.name) }))
    .filter((d) => d.sim >= 0.86).sort((a, b) => b.sim - a.sim || b.fans - a.fans)[0] || { id: 0 };
}
async function deezerRelated(id) {
  const r = await getJSON(`https://api.deezer.com/artist/${id}/related?limit=40`);
  return r ? ((r && r.data) || []).map((d) => ({ id: d.id, name: d.name, fans: d.nb_fan || 0 })) : null;
}
/** related artists, and theirs (only the ones several of them point to: one path alone drifts away) */
async function deezerFacts(seedName, lib) {
  const v = await remembered('dz2', artistKey(seedName), async () => {
    const d = await deezerArtist(seedName);
    if (!d) return null;                                     // offline: try again next time
    if (!d.id) return { id: 0, fans: 0, first: [], hop: [] };
    const first = await deezerRelated(d.id);
    if (!first) return null;
    const hop = await Promise.all(first.slice(0, 10).map((r) => deezerRelated(r.id).then((x) => x || []).catch(() => [])));
    return { id: d.id, fans: d.fans || 0, first, hop };
  });
  if (!v) return null;
  const d1 = new Map(), d2 = new Map(), ids = new Map(), fans = new Map();
  ids.set(artistKey(seedName), v.id);
  for (const r of [...v.first, ...v.hop.flat()]) if (r.fans) fans.set(artistKey(r.name), r.fans);
  v.first.forEach((r, i) => { const k = artistKey(r.name); ids.set(k, r.id); if (lib.has(k)) d1.set(k, Math.max(d1.get(k) || 0, 1 - 0.5 * i / Math.max(10, v.first.length))); });
  const support = new Map();
  v.hop.forEach((list, j) => list.forEach((r, i) => {
    const k = artistKey(r.name); if (!ids.has(k)) ids.set(k, r.id);
    if (!lib.has(k)) return;
    const s = support.get(k) || { n: 0, w: 0 };
    s.n++; s.w = Math.max(s.w, (1 - 0.5 * i / Math.max(10, list.length)) * (1 - 0.04 * j));
    support.set(k, s);
  }));
  for (const [k, s] of support) if (s.n >= 2) d2.set(k, Math.min(0.9, (0.25 + 0.15 * Math.min(4, s.n)) * s.w));
  return { d1, d2, ids, fans, seedFans: v.fans || 0 };
}

async function mbid(name) {
  await Genres.whenLoaded();
  const known = Genres.artistMbid(name);
  if (known) return known;
  return remembered('mb', artistKey(name), async () => {
    const j = await getJSON(`https://musicbrainz.org/ws/2/artist/?query=${enc(`artist:"${cleanArtist(name).replace(/["\\]/g, ' ')}"`)}&fmt=json&limit=5`);
    if (!j) return null;
    const c = (j.artists || []).filter((x) => similarity(cleanArtist(name), x.name) >= 0.9).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    return c ? c.id : '';
  });
}
/** ListenBrainz: the artists listened to in the same sessions as the seed (its own data, open, no key) */
async function listenBrainzFacts(seedName, lib) {
  const id = await mbid(seedName);
  if (!id) return null;
  const list = await remembered('lb', id, async () => {
    const j = await getJSON(LB + id);
    return Array.isArray(j) ? j.slice(0, 100).map((x) => [x.name, x.score]) : null;
  });
  if (!list || !list.length) return null;
  const mx = list[0][1] || 1, m = new Map();
  for (const [name, score] of list) { const k = artistKey(name); if (lib.has(k)) m.set(k, Math.max(m.get(k) || 0, 0.9 * (score / mx) ** 1.5)); }
  return m;
}

/** your playlists: artists that share them with the seed (big mixed playlists count less) */
async function playlistFacts(seedKey, lib) {
  const all = await call('playlist.getAll');
  if (!ok(all)) return null;
  const like = new RegExp('^' + $t('Похоже на «{0}»').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{0\\}', '.+') + '$');
  const lists = (all.playlists || []).filter((p) => !p.isAutoplaylist && p.trackCount >= 3 && p.trackCount <= 1500
    && !/^(Радио|Radio): /.test(p.name) && !p.name.startsWith(PREFIX()) && p.name !== LIKED && !like.test(p.name)).slice(0, 60);
  const n = new Map(), co = new Map(), cnt = new Map(); let nSeed = 0;
  for (const p of lists) {
    const r = await call('playlist.getTracks', { playlistGuid: p.guid, start: 0, count: p.trackCount, fields: ['artist', 'albumArtist'] });
    if (!ok(r)) continue;
    const set = new Set();
    for (const t of r.tracks || []) { for (const a of [t.albumArtist && !isVarious(t.albumArtist) ? t.albumArtist : '', t.artist]) { const k = a && artistKey(a); if (k && lib.has(k)) set.add(k); } }
    // one artist says nothing; a playlist of favourites from everywhere (or the whole library) neither
    if (set.size < 2 || set.size > 120) continue;
    const w = 1 / Math.log2(2 + set.size);
    for (const k of set) n.set(k, (n.get(k) || 0) + w);
    if (set.has(seedKey)) { nSeed += w; for (const k of set) { co.set(k, (co.get(k) || 0) + w); cnt.set(k, (cnt.get(k) || 0) + 1); } }
  }
  if (!nSeed) return null;
  const m = new Map();
  // only next to the seed in two playlists or more, and shrunk towards 0 while the evidence is thin
  for (const [k, c] of co) if (k !== seedKey && cnt.get(k) >= 2) m.set(k, Core.clamp01(c / (Math.sqrt(nSeed * n.get(k)) + 0.3)));
  return m;
}

/* ---------------------------------------------------------------- sound: the whole library against the seed */
function soundFacts(T, seedKey, lib) {
  const all = Sound.all();
  if (!all.length) return null;
  const ds = new Float32Array(all.length);
  const by = new Map();
  all.forEach((r, i) => {
    const d = Sound.distance(T, r); ds[i] = d;
    const k = artistKey(recArtist(r)); if (!k) return;
    const l = by.get(k); if (l) l.push({ r, d }); else by.set(k, [{ r, d }]);
  });
  const Q = Core.quantiles(ds);
  // how wide «close» is: in a library of one style everything is near, so the seed artist's own tracks
  // set the scale (twice where its typical track lies), between the closest 30 % and 70 % of the library
  const own = (by.get(seedKey) || []).map((x) => Q(x.d)).filter((q) => q > 0.002).sort((a, b) => a - b);
  const scale = Math.min(0.7, Math.max(0.3, own.length >= 3 ? 2 * own[own.length >> 1] : 0.35));
  // styles: the seed's (its own, with a little of its artist's) against each artist's average
  const sum = (list) => { const n = list[0].r.st.length, m = new Float32Array(n); for (const { r } of list) for (let i = 0; i < n; i++) m[i] += r.st[i] / 255; return m; };
  const seedList = (by.get(seedKey) || []).filter((x) => x.r.st);
  let seedSt = T.st || null;
  if (seedList.length) { const am = sum(seedList); seedSt = seedSt ? seedSt.map((v, i) => 0.7 * v + 0.3 * am[i] / seedList.length) : am; }
  const art = new Map(), bcs = [];
  for (const [k, list] of by) {
    list.sort((a, b) => a.d - b.d);
    const best = list.slice(0, 3);
    const q = best.reduce((s, x) => s + Q(x.d), 0) / best.length + (3 - best.length) * 0.02;
    const withSt = list.filter((x) => x.r.st);
    const bc = seedSt && withSt.length ? Core.styleBC(seedSt, sum(withSt)) : null;
    if (bc != null && k !== seedKey) bcs.push(bc);
    art.set(k, { sound: Core.clamp01(1 - q / (0.75 * scale)), bc });
  }
  // a style match is judged against the rest of your library: the median artist is 0, the closest are 1
  bcs.sort((a, b) => a - b);
  const med = bcs.length ? bcs[bcs.length >> 1] : 0, top = bcs.length ? bcs[Math.floor(bcs.length * 0.97)] : 1;
  for (const v of art.values()) v.style = v.bc == null ? null : Core.clamp01((v.bc - med) / Math.max(1e-3, top - med));
  return { Q, by, art, scale, sim: (d) => Core.clamp01(1 - Q(d) / scale) };
}

/* ---------------------------------------------------------------- the facts, together */
async function gather(seedName, seedTrack, gen) {
  const lib = await libraryArtists();
  const seedKey = artistKey(seedName);
  if (!lib.has(seedKey)) lib.set(seedKey, { key: seedKey, name: seedName, albums: [], tags: new Set(), years: [] });
  const seedA = lib.get(seedKey);
  const ctx = { lib, seedKey, seedName, seedTrack, T: null, sound: null, seedVibe: null, ids: new Map(), tracks: new Map(), pool: [] };

  // the sound to steer by: the seed track; for an artist radio, the average of its analysed tracks
  if (Sound.ready()) {
    let rec = seedTrack ? Sound.get(seedTrack) || await Sound.analyzeNow(seedTrack, 15000) : null;
    if (rec) { ctx.T = Sound.target(rec); ctx.T.st = rec.st ? Float32Array.from(rec.st, (v) => v / 255) : null; }
    else for (const r of Sound.all()) if (artistKey(recArtist(r)) === seedKey) ctx.T = ctx.T ? Sound.blend(ctx.T, r, 0.3) : Sound.target(r);
  }
  if (gen !== R.gen) return null;
  const [dz, lb, pl] = await Promise.all([
    within(deezerFacts(seedName, lib), 20000),
    within(listenBrainzFacts(seedName, lib), 20000),
    within(playlistFacts(seedKey, lib), 10000),
  ]);
  if (gen !== R.gen) return null;
  if (ctx.T) ctx.sound = soundFacts(ctx.T, seedKey, lib);
  if (!ctx.sound) ctx.T = null;
  if (!ctx.T && seedTrack) ctx.seedVibe = await Vibe.of(seedTrack);
  if (dz) ctx.ids = dz.ids;
  Object.assign(ctx, { dz, lb, pl });
  await Genres.whenLoaded();
  ctx.hubs = await hubStats();
  ctx.pool = scorePool(ctx);
  // the genres of the leading artists, from MusicBrainz first in its queue: the pool is scored again
  // as they arrive (an artist the services relate but whose genres say otherwise drops out)
  for (const n of [seedName, ...ctx.pool.slice(0, 40).map((p) => p.name)]) if (!Genres.artistGenres(n)) Genres.want(n);
  noteHubs(ctx);
  log('radio pool', seedName, ctx.pool.slice(0, 20).map((p) => `${p.name} ${p.s.toFixed(2)} [${Object.entries(p.f).filter(([, v]) => v != null && v !== false).map(([k, v]) => k + ' ' + (+v).toFixed(2)).join(', ')}]`));
  return ctx;
}

/* artists that turn up on most radios whatever the seed (hubs: the famous names everybody's
   listeners also play) — remembered over the last radios, and held back unless the genres agree */
const HUB_KEY = 'radio.hubs.v1';
async function hubStats() { return (await IDB.kvGet(HUB_KEY, null)) || { seeds: [], hits: {} }; }
function noteHubs(ctx) {
  const H = ctx.hubs;
  if (!H.seeds.includes(ctx.seedKey)) { H.seeds.push(ctx.seedKey); if (H.seeds.length > 60) H.seeds.shift(); }
  const live = new Set(H.seeds);
  for (const p of ctx.pool.slice(0, 30)) { const l = (H.hits[p.key] || []).filter((x) => live.has(x) && x !== ctx.seedKey); l.push(ctx.seedKey); H.hits[p.key] = l; }
  IDB.kvSet(HUB_KEY, H);
}
const hubFactor = (ctx, key, f) => {
  const H = ctx.hubs, total = H.seeds.filter((x) => x !== ctx.seedKey).length;
  const hits = (H.hits[key] || []).filter((x) => x !== ctx.seedKey && H.seeds.includes(x)).length;
  // not when Deezer names it directly as related, or the genres clearly agree
  if (total < 3 || hits / total < 0.5 || (f.deezer || 0) >= 0.4 || (f.genre != null && f.genre >= 0.5)) return null;
  return 0.55;
};

/** every library artist scored against the seed; the ones that are on the radio at all, best first */
function scorePool(ctx) {
  const { lib, seedKey, dz, lb, pl } = ctx;
  const seedA = lib.get(seedKey);
  // genres: MusicBrainz's, else your specific tags; a genre counts by how rare it is in your library
  const tagged = new Set();
  const gOf = (a) => { const mb = Genres.artistGenres(a.name); if (mb) return mb; if (!a.tags.size) return null; tagged.add(a.key); return new Map([...a.tags].map((g) => [g, 1])); };
  const G = new Map(); const df = new Map();
  for (const a of lib.values()) { const g = gOf(a); if (!g) continue; G.set(a.key, g); for (const k of g.keys()) df.set(k, (df.get(k) || 0) + 1); }
  const N = Math.max(1, G.size);
  const idf = (g) => Math.log(1 + N / (df.get(g) || 1));
  const gSeed = G.get(seedKey) || null;
  const seedYear = seedA.years.length ? seedA.years.reduce((s, y) => s + y, 0) / seedA.years.length : 0;

  const pool = [];
  for (const a of lib.values()) {
    if (a.key === seedKey) continue;
    const snd = ctx.sound && ctx.sound.art.get(a.key);
    const year = a.years.length ? a.years.reduce((s, y) => s + y, 0) / a.years.length : 0;
    const g = G.get(a.key) || null;
    const f = {
      deezer: dz && dz.d1.get(a.key), deezer2: dz && dz.d2.get(a.key), lb: lb && lb.get(a.key), pl: pl && pl.get(a.key),
      genre: Core.genreSim(gSeed, g, idf), genreTags: tagged.has(a.key) || tagged.has(seedKey), sound: snd ? snd.sound : null, style: snd ? snd.style : null, era: Core.eraSim(seedYear, year),
    };
    // the famous are «similar» to everybody (in co-listening and in related-of-related lists): that
    // evidence counts less the more famous the artist is than the seed
    const fc = dz && dz.fans.get(a.key), fs = dz && dz.seedFans;
    f.fame = fc && fs ? Core.clamp01(1 - 0.25 * Math.log10(Math.max(1, fc / fs))) : null;
    f.hub = hubFactor(ctx, a.key, f);
    const { s, C, K } = Core.artistScore(f);
    if (s < 0.1) continue;
    const why = [];
    if (f.deezer) why.push('deezer'); else if (f.deezer2) why.push('deezer2');
    if (f.lb) why.push('lb');
    if (f.pl && f.pl >= 0.15) why.push('pl');
    if (f.genre != null && f.genre >= 0.35 && gSeed && g) {
      const shared = [...g.keys()].filter((x) => gSeed.has(x)).sort((x, y) => idf(y) * gSeed.get(y) - idf(x) * gSeed.get(x)).slice(0, 2);
      if (shared.length) why.push('genre:' + shared.join(', '));
    }
    pool.push({ key: a.key, name: a.name, s, C, K, f, why });
  }
  pool.sort((a, b) => b.s - a.s);
  return pool.slice(0, 60);
}

/* ---------------------------------------------------------------- an artist's tracks, with what we know of them */
let topStore = null;
async function topTracks(ctx, key, name) {
  topStore ||= (await IDB.kvGet(TOP_KEY, null)) || {};
  const hit = topStore[key];
  if (hit && Date.now() - hit.at < WEB_TTL * 2) return hit.v;
  let id = ctx.ids.get(key);
  if (id == null) { const d = await deezerArtist(name); if (!d) return null; id = d.id; }
  if (!id) { topStore[key] = { at: Date.now(), v: [] }; return []; }
  const j = await getJSON(`https://api.deezer.com/artist/${id}/top?limit=50`);
  if (!j) return null;
  const v = ((j && j.data) || []).map((x) => Core.songKey(x.title_short || x.title)).filter(Boolean);
  topStore[key] = { at: Date.now(), v };
  IDB.kvSet(TOP_KEY, topStore);
  return v;
}
async function plays(list) {
  const paths = list.map((x) => x.h).slice(0, 500);
  if (!paths.length) return;
  const r = await call('titleformat.evalFieldsBatch', { paths, fields: { pc: '[%play_count%]' } });
  const rows = ok(r) ? r.results || [] : [];
  const pc = rows.map((x) => +((x && x.pc) || 0) || 0);
  const mx = Math.max(0, ...pc);
  if (!mx) return;
  pc.forEach((v, i) => { list[i].plays = Math.log1p(v) / Math.log1p(mx); });
}
function tracksFor(ctx, key) {
  if (ctx.tracks.has(key)) return ctx.tracks.get(key);
  const p = (async () => {
    const a = ctx.lib.get(key);
    const list = [], seen = new Set();
    const add = (x) => { const k = String(x.h).toLowerCase(); if (!x.h || seen.has(k)) return; seen.add(k); list.push(x); };
    for (const { r, d } of (ctx.sound && ctx.sound.by.get(key)) || []) add({ h: Sound.handleOfRec(r), title: r.ti, album: r.al, duration: r.du, rec: r, d });
    if (a) for (const t of await queryTracks(a.name)) add({ h: handleOf(t), title: t.title, album: t.album, duration: t.duration, t });
    for (const x of list) { x.sim = null; x.pop = null; x.plays = null; }
    if (ctx.T) {
      // not analysed yet: to the front of the analysis queue (the planner has the best of them analysed at once)
      const rest = list.filter((x) => !x.rec && x.t);
      if (rest.length) Sound.prioritize(rest.map((x) => x.t), 22);
      // how close it sounds, as a share of your library (see soundFacts for the scale)
      for (const x of list) if (x.rec) x.sim = ctx.sound.sim(x.d);
    }
    const [top] = await Promise.all([within(topTracks(ctx, key, a ? a.name : key), 8000), within(plays(list), 5000)]);
    if (top && top.length) for (const x of list) {
      const sk = Core.songKey(x.title);
      const i = top.findIndex((t) => t === sk || (sk.length > 3 && similarity(t, sk) >= 0.9));
      x.pop = i < 0 ? 0 : 1 - 0.7 * i / top.length;
    }
    return list;
  })();
  ctx.tracks.set(key, p);
  return p;
}

/** how close a track not known yet sounds: analysed now (sound analysis), or measured on the spot (vibe.js) */
async function measure(ctx, x) {
  const t = x.t || { absolutePath: x.h };
  if (ctx.T) {
    const r = Sound.get(t) || await Sound.analyzeNow(t, 12000);
    if (!r) return null;
    x.rec = r; x.d = Sound.distance(ctx.T, r);
    return ctx.sound.sim(x.d);
  }
  if (!ctx.seedVibe) return null;
  const v = await Vibe.of(t);
  if (!v) return null;
  const d = Vibe.distance(ctx.seedVibe, v);
  (ctx.vd ||= []).push(d);
  return Core.clamp01(1 - d / 0.5);
}

/* ---------------------------------------------------------------- filling the playlist */
async function fill(n) {
  const gen = R.gen;
  if (R.filling === gen || !R.planner) return;
  R.filling = gen;
  try {
    let buf = [];
    for (let i = 0; i < n; i++) {
      const x = await R.planner.next();
      if (gen !== R.gen) return;
      if (!x) { if (!R.ended) { R.ended = true; toast($t('Похожей музыки в медиатеке больше нет — радио на этом остановится'), { ms: 4000 }); } break; }
      buf.push(x.t.h);
      if (i % 4 === 3 && R.ctx) R.planner.update(scorePool(R.ctx));      // more genres known by now
      if (buf.length >= (i < 4 ? 1 : 4)) { await call('playlist.addHandles', { playlistGuid: R.guid, handles: buf }); buf = []; }
    }
    if (buf.length && gen === R.gen) await call('playlist.addHandles', { playlistGuid: R.guid, handles: buf });
  } catch (e) { log('radio fill', e); } finally { if (R.filling === gen) R.filling = 0; }
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
  if (!deps || R.busy || !seed) return;
  const seedTrack = typeof seed === 'object' && handleOf(seed) ? seed : null;
  const seedName = cleanArtist(typeof seed === 'string' ? seed : seed.artist || seed.albumArtist || '');
  if (!seedName) return;
  R.busy = true;
  const gen = ++R.gen;
  const label = seedTrack && seedTrack.title ? `${seedTrack.title} — ${seedName}` : seedName;
  toast($t('Собираю радио «{0}»…', esc(label)), { ms: 2500 });
  try {
    R.planner = null; R.ctx = null; R.now = null; R.skipRecs = []; R.ended = false;
    const guid = await radioPlaylist(PREFIX() + label);
    if (!guid) { toast($t('Не удалось создать плейлист радио')); return; }
    R.guid = guid;
    if (seedTrack) {                                            // the seed plays at once; the rest is found meanwhile
      await call('playlist.addHandles', { playlistGuid: guid, handles: [handleOf(seedTrack)] });
      await call('playlist.setActive', { playlistGuid: guid });
      await call('playlist.playTrack', { playlistGuid: guid, index: 0 });
      router.go('playlist', guid);
    }
    const ctx = await gather(seedName, seedTrack, gen);
    if (!ctx || gen !== R.gen) return;
    R.ctx = ctx;
    if (!ctx.pool.length) { toast($t('Похожей музыки не нашлось')); return; }
    const core = (t) => ({ h: handleOf(t), title: t.title, album: t.album, duration: t.duration });
    R.planner = new Core.Planner({
      pool: ctx.pool, seed: { key: ctx.seedKey, name: seedName, track: seedTrack ? core(seedTrack) : null },
      tracksOf: (k) => tracksFor(ctx, k),
      measure: (t) => measure(ctx, t),
      near: ctx.T ? (rec) => R.skipRecs.reduce((m, s) => Math.max(m, Core.clamp01((0.45 - Sound.distance(s, rec)) / 0.3)), 0) : null,
    });
    if (ctx.T) warm(ctx, gen);
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
async function warm(ctx, gen) {
  for (const p of ctx.pool.slice(0, 16)) {
    if (gen !== R.gen) return;
    const a = ctx.lib.get(p.key); if (!a) continue;
    Sound.prioritize(await queryTracks(a.name), 22);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* a radio track skipped in its first 30 seconds: its artist comes up less, and so does its sound */
function noteSkip(d) {
  const now = performance.now();
  const prev = R.now;
  R.now = d ? { key: artistKey(d.artist || d.albumArtist || ''), t0: now, t: d } : null;
  if (!R.guid || !R.planner || !prev || !prev.key) return;
  if (now - prev.t0 < 30000) {
    R.planner.skip(prev.key);
    const r = prev.t && Sound.get(prev.t);
    if (r) R.skipRecs.push(Sound.target(r));
  }
}

/* near the end of the radio playlist → add the next batch */
async function topUp() {
  if (!R.guid || R.busy || R.filling || !R.planner) return;
  const pi = await call('playback.getCurrentTrackIndex');
  if (!ok(pi) || pi.found === false || pi.playlistGuid !== R.guid) { if (ok(pi) && pi.found !== false && pi.playlistGuid !== R.guid) R.now = null; return; }
  const c = await call('playlist.getTrackCount', { playlistGuid: R.guid });
  const total = ok(c) ? (c.count ?? 0) : 0;
  if (!total || pi.index < total - 4) return;
  fill(15);
}
export const active = () => R.guid;

/** why a track is on the radio, in words ('' when it is not one of the radio's) */
export function why(t) {
  if (!R.planner || !t) return '';
  const w = R.planner.why.get(String(handleOf(t)).toLowerCase());
  if (!w) return '';
  const L = {
    seed: $t('исполнитель, с которого началось радио'), deezer: $t('похожий исполнитель на Deezer'), deezer2: $t('его называют похожим несколько похожих исполнителей'),
    lb: $t('его слушают вместе с исполнителем радио (ListenBrainz)'), pl: $t('стоит рядом в ваших плейлистах'), sound: $t('звучит похоже'), hit: $t('один из самых известных треков исполнителя'),
  };
  return w.map((x) => (x.startsWith('genre:') ? $t('общие жанры: {0}', x.slice(6)) : L[x] || '')).filter(Boolean).join(' · ');
}

/** «not this»: the artist leaves this radio, and its tracks not yet played leave the playlist */
export async function ban(name) {
  if (!R.guid || !name) return;
  const k = artistKey(name);
  if (R.planner) R.planner.ban(k);
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
export const _debug = () => R;
