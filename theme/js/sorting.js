/*
 * Gatefold · sorting.js — album and artist ordering.
 *
 * The component's own `library.getAlbums` sort compares raw UTF-8 bytes with an
 * unstable std::sort and only by the primary key: albums of one artist came out
 * in an arbitrary order, upper-case before lower-case, all Latin before all
 * Cyrillic. So the grid is sorted here, with full tie-breakers and a real
 * collation (case-insensitive, numbers as numbers, punctuation ignored).
 *
 * Recency comes from Playback Statistics (foo_playcount):
 *   added   — %added% of each album's first track      (playcount.getBatch, 500 per call)
 *   played  — order of %last_played% over ALL tracks   (library.query: filtering on foobar's
 *             thread, sorting on the component's worker), so an album counts as played when
 *             any of its tracks was; kept current locally on every track change.
 */
import { call, ok, on, log, albumKeyOf, normTrack } from './bridge.js';
import { bgCall } from './sched.js';

import { $t } from './i18n.js';
import * as Colors from './colors.js';
// root collation: Latin before Cyrillic, like Explorer and foobar2000 itself; case and punctuation ignored, numbers by value
const coll = new Intl.Collator('en', { sensitivity: 'base', numeric: true, ignorePunctuation: true });
export const cmpText = (a, b) => coll.compare(a || '', b || '') || (a || '').localeCompare(b || '');
export const yearOf = (a) => +((String(a.year || a.date || '').match(/\d{4}/) || [0])[0]) || 0;
const artistOf = (a) => a.albumArtist || a.artist || '';
export const albumKey = (a) => albumKeyOf(artistOf(a), a.name);
/* a merged album (library.js mergeAlbums) is as recent as its most recent part */
const recOf = (kind, a) => { let v = rec[kind].get(albumKey(a)) || 0; if (a.parts) for (const p of a.parts) v = Math.max(v, rec[kind].get(albumKeyOf(p.albumArtist, p.name)) || 0); return v; };

export const SORTS = {
  artist: $t('По исполнителю'), name: $t('По названию'), year: $t('По году'), added: $t('Недавно добавленные'), played: $t('Недавно проигранные'), trackCount: $t('По числу треков'), color: $t('По цвету обложки'),
};

// ---------------------------------------------------------------- comparators
const byArtist = (a, b) => cmpText(artistOf(a), artistOf(b));
const byYearAsc = (a, b) => (yearOf(a) || 9999) - (yearOf(b) || 9999);     // undated albums after dated ones
const byName = (a, b) => cmpText(a.name, b.name);
const byPath = (a, b) => cmpText(a.firstTrackAbsolutePath, b.firstTrackAbsolutePath);
const chain = (...fs) => (a, b) => { for (const f of fs) { const r = f(a, b); if (r) return r; } return 0; };

const rec = { added: new Map(), played: new Map(), loaded: { added: 0, played: 0 }, top: 0, missing: { added: false, played: false } };
const recency = (kind) => (a, b) => recOf(kind, b) - recOf(kind, a);

const CMP = {
  // artist → year (oldest first, a discography reads left to right) → title → path
  artist: chain(byArtist, byYearAsc, byName, byPath),
  name: chain(byName, byArtist, byYearAsc, byPath),
  year: chain((a, b) => (yearOf(b) || -1) - (yearOf(a) || -1), byArtist, byName, byPath),
  trackCount: chain((a, b) => (b.trackCount || 0) - (a.trackCount || 0), byArtist, byYearAsc, byName),
  added: chain(recency('added'), byArtist, byYearAsc, byName, byPath),
  played: chain(recency('played'), byArtist, byYearAsc, byName, byPath),
  color: chain(Colors.compare, byArtist, byYearAsc, byName, byPath),
};

export function sortAlbums(list, by) {
  return [...list].sort(CMP[by] || CMP.artist);
}

// ---------------------------------------------------------------- recency data
const parseTs = (s) => { if (!s) return 0; const t = Date.parse(String(s).replace(' ', 'T')); return Number.isFinite(t) ? t : 0; };

async function loadAdded(albums) {
  const m = new Map();
  const paths = albums.map((a) => a.firstTrackAbsolutePath).filter(Boolean);
  const byPathKey = new Map(albums.map((a) => [a.firstTrackAbsolutePath, albumKey(a)]));
  let any = false;
  for (let i = 0; i < paths.length; i += 500) {
    const r = await (i ? bgCall('playcount.getBatch', { paths: paths.slice(i, i + 500) }, 'normal') : call('playcount.getBatch', { paths: paths.slice(i, i + 500) }));
    if (!ok(r)) { log('playcount.getBatch failed', r.error || r.code); break; }
    for (const row of r.results || []) {
      const t = parseTs(row.added);
      if (t) { any = true; m.set(byPathKey.get(row.path), t); }
    }
  }
  rec.missing.added = !any;
  return m;
}

async function loadPlayed() {
  const m = new Map();
  let r = null;
  for (const query of ['%last_played% PRESENT', '%play_count% GREATER 0']) {
    r = await call('library.query', { query, sort: '%last_played%', limit: 1000000, fields: ['album', 'albumArtist', 'artist'] });
    if (ok(r)) break;
  }
  const tracks = (ok(r) && r.tracks) || [];
  // ascending by %last_played% → walk backwards: the first time an album shows up is its latest play
  let rank = tracks.length + 1;
  for (let i = tracks.length - 1; i >= 0; i--, rank--) {
    const t = tracks[i];
    const k = albumKeyOf(t.albumArtist || t.artist, t.album);
    if (t.album && !m.has(k)) m.set(k, rank);
  }
  rec.top = tracks.length + 1;
  rec.missing.played = !tracks.length;
  return m;
}

/** Make sure recency data for `kind` is loaded (cached until the library changes). */
export async function ensure(kind, albums) {
  if (kind !== 'added' && kind !== 'played') return true;
  if (rec.loaded[kind]) return !rec.missing[kind];
  const t0 = performance.now();
  rec[kind] = kind === 'added' ? await loadAdded(albums) : await loadPlayed();
  rec.loaded[kind] = Date.now();
  log(`recency '${kind}': ${rec[kind].size} albums in ${Math.round(performance.now() - t0)} ms`);
  return !rec.missing[kind];
}
export const hasData = (kind) => !rec.missing[kind];
export const playedRank = (a) => recOf('played', a);

/* New files → album add dates need a refresh; plays are tracked live below. */
['library:itemsAdded', 'library:itemsRemoved'].forEach((ev) => on(ev, () => { rec.loaded.added = 0; }));

/* Every track change moves its album to the top of "recently played" without a query. */
export const events = new EventTarget();
on('playback:trackChanged', (d) => {
  const t = normTrack(d);
  if (!t || !t.album || !rec.loaded.played) return;
  const k = albumKeyOf(t.albumArtist, t.album);
  rec.played.set(k, ++rec.top);
  rec.missing.played = false;
  events.dispatchEvent(new CustomEvent('played', { detail: { key: k } }));
});

// ---------------------------------------------------------------- artists
const ARTIST_CMP = {
  name: (p, q) => cmpText(p.name, q.name),
  albums: (p, q) => q.albums.length - p.albums.length || cmpText(p.name, q.name),
  tracks: (p, q) => q.tracks - p.tracks || cmpText(p.name, q.name),
  added: (p, q) => latest(q, 'added') - latest(p, 'added') || cmpText(p.name, q.name),
  played: (p, q) => latest(q, 'played') - latest(p, 'played') || cmpText(p.name, q.name),
};
function latest(x, kind) {
  let v = 0;
  for (const a of (x.albums.length ? x.albums : x.appears || [])) { const r = recOf(kind, a); if (r > v) v = r; }
  return v;
}
export function sortArtists(list, by, isVarious) {
  const f = ARTIST_CMP[by] || ARTIST_CMP.name;
  return list.sort((p, q) => (isVarious(p.name) - isVarious(q.name)) || f(p, q));
}
/** Discography order on an artist page: oldest → newest, then title. */
export const sortDiscography = (albums) => albums.sort(chain(byYearAsc, byName, byPath));
