/*
 * Gatefold · ml/genres.js — the genre of a track, the way streaming services get it right.
 *
 * Audio alone does not separate melodic death metal from gothic or power metal well: Discogs-EffNet
 * learnt from Discogs' release labels, which are coarse and noisy for subgenres (for Ensiferum it
 * hears «Heavy Metal, Gothic Metal, Symphonic Rock»). Services combine sound with what people say
 * about the music. Gatefold does the same, in this order:
 *   1. your own genre tag, when it is specific (not just «Metal» or «Rock»);
 *   2. MusicBrainz genres voted by its editors — of the album (release group), then of the artist
 *      (Ensiferum: folk metal, viking metal, melodic death metal…). The artist is verified by
 *      matching its discography against your albums, so «Death» is the Florida band you own;
 *   3. for artists MusicBrainz has nothing on: the genres of the tracks that *sound* closest to
 *      this one (neural embeddings) among artists it does know — label propagation by sound;
 *   4. only then the network's own Discogs styles.
 * Among the genres of a source, the network's per-track estimate decides the order (a ballad and a
 * thrasher of the same band get different first genres). Nothing is written into your files.
 * Requests: musicbrainz.org (1 per 1.1 s, by artist name), only while sound analysis is on.
 */
import { log } from '../bridge.js';
import { getJSON } from '../coverfetch.js';
import { norm, cleanArtist, cleanAlbum, similarity, isVarious } from '../match.js';
import { settings } from '../settings.js';
import * as IDB from '../idb.js';
import * as Sound from './sound.js';

const KEY = 'mbgenres.v1', RETRY = 30 * 864e5;
const enc = encodeURIComponent, unq = (s) => String(s || '').replace(/["\\]/g, ' ').trim();
const D = { a: {}, r: {} };          // artist key → { id, g:[[name, votes]], at }; album key → { g, at }
let loaded = null, saveT = 0, deps = null, running = false;
export const state = { artists: 0, done: 0, running: false };
export const events = new EventTarget();
const load = () => (loaded ||= IDB.kvGet(KEY, null).then((o) => { if (o) { Object.assign(D.a, o.a || {}); Object.assign(D.r, o.r || {}); } }));
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => IDB.kvSet(KEY, D), 3000); };
const aKey = (name) => norm(cleanArtist(name || ''));
const rKey = (artist, album) => aKey(artist) + '|' + norm(cleanAlbum(album || ''));

/* generic words that say nothing about a genre */
const GENERIC = new Set(['metal', 'rock', 'pop', 'other', 'unknown', 'misc', 'music', 'various', 'alternative', 'electronic', 'soundtrack', 'genre', 'none']);
const nk = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/* MusicBrainz names genres in lower case; abbreviations stay upper case (AOR, not «Aor») */
const ABBR = new Set(['aor', 'edm', 'idm', 'ebm', 'uk', 'us', 'nwobhm', 'nwoahm', 'mpb', 'dsbm', 'ost', 'dj', 'r&b', 'dnb', 'lgbt', 'ccm', 'opm', 'acg', 'jrpg', 'vgm']);
const title = (s) => String(s).split(/(\s+|-)/).map((w) => ABBR.has(w.toLowerCase()) ? w.toUpperCase() : w.replace(/^\p{L}/u, (c) => c.toUpperCase())).join('')
  .replace(/\bAnd\b/g, 'and').replace(/\bN\b/g, 'n');

/* MusicBrainz genre → Discogs style index (for the network's per-track estimate) */
let discogsIdx = null;
function discogs(name) {
  if (!discogsIdx) {
    discogsIdx = new Map();
    Sound.styleNames().forEach((s, i) => { discogsIdx.set(nk(s), i); });
    for (const [a, b] of [['thrash metal', 'thrash'], ['hip hop', 'hip hop'], ['drum and bass', 'drum n bass'], ['symphonic metal', 'symphonic rock'], ['neoclassical metal', 'heavy metal'], ['groove metal', 'thrash'], ['death n roll', 'death metal']])
      if (discogsIdx.has(nk(b))) discogsIdx.set(a, discogsIdx.get(nk(b)));
  }
  const k = nk(name);
  return discogsIdx.has(k) ? discogsIdx.get(k) : -1;
}

/* ---------------------------------------------------------------- MusicBrainz */
const verifies = (local, titles) => local.some((a) => titles.some((t) => similarity(cleanAlbum(a), cleanAlbum(t)) >= 0.86));
const topGenres = (list) => (list || []).filter((g) => g && g.name && (g.count || 0) > 0).sort((a, b) => b.count - a.count).slice(0, 8).map((g) => [g.name, g.count]);

async function fetchArtist(name, albums) {
  const j = await getJSON(`https://musicbrainz.org/ws/2/artist/?query=${enc(`artist:"${unq(cleanArtist(name))}"`)}&fmt=json&limit=8`);
  const cands = ((j && j.artists) || []).filter((x) => similarity(cleanArtist(name), x.name) >= 0.9 || (x.aliases || []).some((al) => similarity(cleanArtist(name), al.name) >= 0.92));
  // the right one of several namesakes: its discography contains your albums; else the most talked-about
  cands.sort((a, b) => (b.tags || []).reduce((s, t) => s + t.count, 0) - (a.tags || []).reduce((s, t) => s + t.count, 0) || (b.score || 0) - (a.score || 0));
  let pick = null, rgs = [];
  for (const x of cands.slice(0, 3)) {
    const rg = await getJSON(`https://musicbrainz.org/ws/2/release-group?artist=${x.id}&inc=genres&fmt=json&limit=100`);
    const list = (rg && rg['release-groups']) || [];
    if (!albums.length || verifies(albums, list.map((r) => r.title))) { pick = x; rgs = list; break; }
    if (!pick) { pick = x; rgs = list; }
  }
  if (!pick) return { g: [], at: Date.now() };
  const full = await getJSON(`https://musicbrainz.org/ws/2/artist/${pick.id}?inc=genres&fmt=json`);
  const g = topGenres(full && full.genres);
  // the albums' own genres, matched to your album titles
  for (const al of albums) {
    const m = rgs.map((r) => ({ r, s: similarity(cleanAlbum(al), cleanAlbum(r.title)) })).sort((a, b) => b.s - a.s)[0];
    if (m && m.s >= 0.86 && m.r.genres && m.r.genres.length) D.r[rKey(name, al)] = { g: topGenres(m.r.genres), at: Date.now() };
  }
  return { id: pick.id, g, at: Date.now() };
}

/** the library's artists, the playing one first; MusicBrainz at its own pace (≈ 1 request a second) */
const urgent = [];
async function worker() {
  if (running) return;
  running = true; state.running = true;
  try {
    await load();
    const albums = deps ? await deps.getAllAlbums() : [];
    const by = new Map();
    for (const a of albums) {
      const n = a.albumArtist || a.artist; if (!n || isVarious(n)) continue;
      const k = aKey(n); if (!k) continue;
      const x = by.get(k) || { name: n, albums: [], tracks: 0 }; x.albums.push(a.name); x.tracks += a.trackCount || 1; by.set(k, x);
    }
    const todo = [...by.entries()].filter(([k]) => !D.a[k] || (!D.a[k].g.length && Date.now() - D.a[k].at > RETRY)).sort((a, b) => b[1].tracks - a[1].tracks);
    state.artists = by.size; state.done = by.size - todo.length;
    events.dispatchEvent(new Event('change'));
    while (settings.soundAI && settings.soundGenresOnline !== false) {
      const u = urgent.shift();
      const item = u ? [aKey(u.name), by.get(aKey(u.name)) || { name: u.name, albums: u.albums || [] }] : todo.shift();
      if (!item) break;
      const [k, x] = item;
      if (D.a[k] && (D.a[k].g.length || Date.now() - D.a[k].at < RETRY)) continue;
      try { D.a[k] = await fetchArtist(x.name, x.albums); } catch (e) { log('genres', x.name, e); D.a[k] = { g: [], at: Date.now() }; }
      state.done++; save(); events.dispatchEvent(new Event('change'));
    }
  } finally { running = false; state.running = false; }
}
/** ask for this artist ahead of the others (the playing track) */
export function want(artist, album) {
  if (!artist || isVarious(artist) || settings.soundGenresOnline === false) return;
  load().then(() => { if (D.a[aKey(artist)]) return; urgent.push({ name: artist, albums: album ? [album] : [] }); worker(); });
}
export function init(d) { deps = d; load(); }
export function start() { if (settings.soundGenresOnline !== false) setTimeout(() => worker(), 4000); }

/* ---------------------------------------------------------------- the genres to show */
const mbOf = (artist, album) => {
  const r = album ? D.r[rKey(artist, album)] : null, a = D.a[aKey(artist)];
  const out = new Map();
  const add = (g, w) => { if (!g || !g.length) return; const mx = g[0][1] || 1; for (const [n, c] of g) out.set(n, Math.max(out.get(n) || 0, (c / mx) * w)); };
  add(r && r.g, 1); add(a && a.g, r && r.g && r.g.length ? 0.6 : 1);
  return out;                                             // genre → 0…1
};
const tagGenres = (tag) => String(tag || '').split(/\s*[;/,|]\s*/).map((s) => s.trim()).filter((s) => s && !GENERIC.has(nk(s)));

/** the genres around a track by sound: votes of the closest analysed tracks of artists MusicBrainz knows */
function bySound(rec) {
  const T = Sound.target(rec); if (!T) return null;
  const me = aKey(rec.aa || rec.ar);
  const near = Sound.nearest(T, 40, (r) => aKey(r.aa || r.ar) !== me && (D.a[aKey(r.aa || r.ar)] || {}).g?.length);
  if (near.length < 8) return null;
  const votes = new Map(); let tot = 0;
  for (const { r, d } of near) {
    const w = Math.max(0, 1.2 - d); if (!w) continue;
    for (const [g, s] of mbOf(r.aa || r.ar, r.al)) { votes.set(g, (votes.get(g) || 0) + w * s); }
    tot += w;
  }
  if (!tot) return null;
  return new Map([...votes].map(([g, v]) => [g, v / tot]).filter(([, v]) => v >= 0.25));
}

/**
 * [{ name, src: 'tag' | 'musicbrainz' | 'sound' | 'network', w }] — the best `n` genres of a track.
 * `t` is a track ({ artist, albumArtist, album, genre }); `rec` its sound analysis (optional).
 */
export function describe(t, rec, n = 2, { neighbours = true } = {}) {
  const artist = (t && (t.albumArtist || t.artist)) || (rec && (rec.aa || rec.ar)) || '';
  const album = (t && t.album) || (rec && rec.al) || '';
  const audio = (name) => { if (!rec || !rec.st) return null; const i = discogs(name); return i >= 0 ? rec.st[i] / 255 : null; };
  const rank = (m, src) => {
    const list = [...m].map(([name, w]) => ({ name, w, a: audio(name) }));
    const amax = Math.max(0.05, ...list.map((x) => x.a || 0));
    for (const x of list) x.score = 0.7 * x.w + 0.3 * (x.a == null ? 0.35 : x.a / amax);
    return list.sort((a, b) => b.score - a.score).map((x) => ({ name: title(x.name), src, w: x.w, audio: x.a }));
  };
  const tags = tagGenres(t && t.genre);
  const mb = mbOf(artist, album);
  if (tags.length) for (const g of tags) mb.set(nk(g), Math.max(mb.get(nk(g)) || 0, 1.1));
  if (mb.size) return dedupe(rank(mb, tags.length ? 'tag' : 'musicbrainz')).slice(0, n);
  if (rec && neighbours) { const s = bySound(rec); if (s && s.size) return dedupe(rank(s, 'sound')).slice(0, n); }
  return Sound.describeStyles(rec, n, t && t.genre).map((s) => ({ name: s.name, src: 'network', w: s.p, audio: s.own }));
}
function dedupe(list) { const seen = new Set(); return list.filter((x) => { const k = nk(x.name); if (seen.has(k)) return false; seen.add(k); return true; }); }
export const known = (artist) => !!(D.a[aKey(artist)] || {}).g?.length;
export const ready = () => loaded;
