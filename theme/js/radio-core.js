/*
 * Gatefold · radio-core.js — the radio's decisions, without any I/O (radio.js gathers the facts).
 *
 * WHO comes on is decided by evidence of two kinds, and the strong kind is people:
 *   community  Deezer «related artists» (and the artists several of them agree on), ListenBrainz
 *              artists listened to in the same sessions, and your own playlists — combined as a
 *              noisy-OR: each source can only add, two sources that agree count more than one;
 *   content    genres (MusicBrainz, voted by its editors, weighted by how rare they are in your
 *              library), the sound (the neural embedding, as a percentile of your whole library),
 *              and the Discogs styles the network hears (compared as distributions).
 * An artist people relate to the seed comes on in proportion to how much the content agrees. An
 * artist only the content points to must be a strong match on all of it — and on the genre too
 * when it is known: a K-pop song can be mixed like a Finnish rock song, it is still not the same
 * radio. (That was the old radio's failure: the embedding alone brought artists in, and the tracks
 * nearest in sound always won.)
 *
 * WHAT is played of an artist: the track that sounds closest to the seed, weighed with how known it
 * is (the artist's top tracks on Deezer) and how often you play it. Remixes, live versions, demos,
 * interludes and such stay out unless the seed is one of them; a song already played (on another
 * album) does not come again.
 *
 * ORDER: the first tracks come from the closest artists; then the circle widens. Never the same
 * artist twice in a row, rarely twice in four, at most three of any 25 tracks; the seed's own
 * artist returns about every sixth track. An artist whose tracks keep sounding off, or that you skip,
 * fades out. When nothing fitting is left, the radio stops instead of filling up with anything.
 */

export const clamp01 = (x) => (x > 1 ? 1 : x > 0 ? x : 0);
export const noisyOr = (...xs) => 1 - xs.reduce((p, x) => p * (1 - clamp01(x || 0)), 1);

/* ---------------------------------------------------------------- versions and fillers */
// words inside brackets / after « - » that make a track a different version of a song
const VERSION = /\b(re-?mix(es|ed)?|rmx|mix|dub|edit(?!ion)|live|demo|karaoke|instrumental|a ?capp?ella|commentary|interview|rehearsal|session|alternate|alt\.? take|take \d+|8[- ]?bit|orchestral|piano version|acoustic|unplugged|cover|tribute|sped up|slowed|nightcore|reverb)\b/i;
const KEEP = /\b(radio edit|single edit|album version|single version|remaster(ed)?|mono|stereo|bonus)\b/i;
const FILLER = /^\s*(intro|outro|interlude|prelude|postlude|skit|untitled|hidden track|silence|segue|reprise|ambience|sound ?check)\b/i;
const ALBUM_KIND = /\b(live|remix(es)?|demos?|karaoke|instrumentals?|unplugged|acoustic|sessions?|rehearsals?|commentary|tribute|covers)\b/i;

/** the version words of a title: «Crush 'Em [Jock mix] [bonus track]» → ['mix'] */
export function versionOf(title) {
  const t = String(title || '');
  const parts = [...t.matchAll(/[([]([^)\]]*)[)\]]/g)].map((m) => m[1]);
  const dash = t.match(/\s[-–—]\s(.+)$/); if (dash) parts.push(dash[1]);
  const out = new Set();
  for (const p of parts) {
    const s = p.replace(KEEP, ' ');
    const m = s.match(new RegExp(VERSION.source, 'gi'));
    if (m) for (const w of m) out.add(w.toLowerCase().replace(/^re-?mix.*/, 'remix').replace(/^rmx$/, 'remix'));
  }
  return [...out];
}
/** the song itself, for spotting the same song twice: «Still Standing (Remastered 2023)» → «still standing» */
export const songKey = (title) => String(title || '').toLowerCase().replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s[-–—]\s.*$/, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Is this track a song for the radio? `seed` ({ title, album, duration }) lets through the kind the
 * seed itself is (a live seed → live tracks are fine).
 * → { ok, kind, mul } — mul < 1 for tracks that are fine but less ideal (very long, a bonus track)
 */
export function songCheck(t, seed = null) {
  const title = String(t.title || ''), album = String(t.album || ''), du = +t.duration || 0;
  const seedKinds = seed ? new Set([...versionOf(seed.title), ...(ALBUM_KIND.test(seed.album || '') ? [String(seed.album).match(ALBUM_KIND)[1].toLowerCase()] : [])]) : new Set();
  if (du && du < 80) return { ok: false, kind: 'short' };
  if (FILLER.test(title) || /[([](intro|outro|interlude|skit)[)\]]/i.test(title)) return { ok: false, kind: 'filler' };
  const v = versionOf(title).filter((k) => !seedKinds.has(k));
  if (v.length) return { ok: false, kind: v[0] };
  const ak = album.match(ALBUM_KIND);
  if (ak && !seedKinds.has(ak[1].toLowerCase()) && !/\bdeluxe|expanded|anniversary\b/i.test(album)) return { ok: false, kind: 'album:' + ak[1].toLowerCase() };
  let mul = 1;
  if (du > 540) mul *= du > 900 ? 0.4 : 0.75;                    // a 12-minute epic is rarely what a radio wants next
  if (/\bbonus\b/i.test(title)) mul *= 0.8;
  return { ok: true, kind: '', mul };
}

/* ---------------------------------------------------------------- similarity of facts */
/** cosine of two weighted genre maps (genre → weight), each genre counted by its rarity `idf(g)` */
export function genreSim(a, b, idf = () => 1) {
  if (!a || !b || !a.size || !b.size) return null;
  let ab = 0, aa = 0, bb = 0;
  for (const [g, w] of a) { const i = idf(g); aa += (w * i) ** 2; const v = b.get(g); if (v) ab += w * v * i * i; }
  for (const [g, w] of b) { const i = idf(g); bb += (w * i) ** 2; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : null;
}
/** Bhattacharyya coefficient of two style distributions (0 … 1): robust to one loud class */
export function styleBC(p, q) {
  if (!p || !q) return null;
  let sp = 0, sq = 0; for (let i = 0; i < p.length; i++) { sp += p[i]; sq += q[i]; }
  if (!sp || !sq) return null;
  let s = 0; for (let i = 0; i < p.length; i++) s += Math.sqrt((p[i] / sp) * (q[i] / sq));
  return s;
}
/** sorted distances → q(d): the share of the library closer than d (0 … 1) */
export function quantiles(dists) {
  const a = Float32Array.from(dists).sort();
  const n = a.length;
  return (d) => {
    if (!n) return 0.5;
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < d) lo = m + 1; else hi = m; }
    return lo / n;
  };
}
export const eraSim = (y1, y2) => (y1 && y2 ? clamp01(1 - Math.abs(y1 - y2) / 22) : null);

/**
 * An artist's score from its facts (each 0 … 1, or null when unknown):
 *   deezer, deezer2 (agreed on by several related artists), lb (ListenBrainz), pl (your playlists),
 *   genre, sound, style, era.
 * → { s, C, K } — s ≥ 0.1 or so to be on the radio at all
 */
export function artistScore(f) {
  const C = noisyOr(f.deezer, 0.6 * (f.deezer2 || 0), f.lb, 0.75 * (f.pl || 0));
  // genres voted on MusicBrainz are a strong fact; a file's own genre tag (genreTags) a weak one
  const parts = [[f.genre, f.genreTags ? 0.2 : 0.45], [f.sound, 0.35], [f.style, 0.2]].filter(([v]) => v != null);
  const W = parts.reduce((s, [, w]) => s + w, 0);
  const K = W ? parts.reduce((s, [v, w]) => s + v * w, 0) / W : null;
  const era = f.era == null ? 1 : 0.7 + 0.3 * f.era;
  let s;
  if (C > 0.02) s = (0.35 + 0.65 * C) * (K == null ? 0.65 : 0.25 + 0.75 * K);
  else if (K == null) s = 0;
  else {
    // content alone: only a strong match on what is known, and never against the genre
    if (f.genre != null && !f.genreTags && f.genre < 0.2) return { s: 0, C, K };
    s = 0.6 * K * K * (W >= 0.6 ? 1 : 0.5);
  }
  return { s: s * era, C, K };
}

/* ---------------------------------------------------------------- the planner */
/**
 * pool: [{ key, name, s, why: [] }]; seed: { key, track } (the seed's artist)
 * tracksOf(key) → [{ h, title, album, duration, sim (0…1 | null), pop (0…1 | null), plays (0…1 | null), rec? }]
 *   (may return a promise; sim: how close it sounds to the seed — 0 is «far», null «not known»)
 * near(rec) → 0…1, how close a track sounds to the tracks you skipped (optional)
 * measure(t) → sim (0…1 | null), for a track whose sound is not known yet: asked for the few best
 *   candidates only, before one of them is chosen (optional, may be slow)
 */
export class Planner {
  constructor({ pool, seed, tracksOf, near = null, measure = null, rnd = Math.random, cap = 3, window = 25, seedEvery = 6, anchor = 6, anchorTop = 8 }) {
    this.pool = pool.map((p) => ({ ...p, fit: 1, pen: 1, dead: false, tries: 0 }));
    this.byKey = new Map(this.pool.map((p) => [p.key, p]));
    this.seed = seed && seed.key ? { key: seed.key, name: seed.name || '', s: 1, why: ['seed'], fit: 1, pen: 1, dead: false, tries: 0 } : null;
    this.seedTrack = seed && seed.track ? seed.track : null;
    this.tracksOf = tracksOf; this.near = near; this.measure = measure; this.rnd = rnd;
    this.cap = cap; this.win = window; this.seedEvery = seedEvery; this.anchor = anchor; this.anchorTop = anchorTop;
    this.played = new Set(); this.songs = new Set(); this.hist = []; this.albums = []; this.n = 0; this.turn = 0;
    this.relaxed = false; this.why = new Map();
    if (this.seedTrack) this.mark(this.seedTrack, this.seed ? this.seed.key : '');
  }
  mark(t, key) {
    this.played.add(String(t.h).toLowerCase());
    this.songs.add(key + '|' + songKey(t.title));
  }
  /** a placed track (also the seed): counted for variety */
  place(t, key) {
    this.mark(t, key); this.hist.push(key); this.albums.push(key + '|' + String(t.album || '').toLowerCase());
    if (this.hist.length > this.win) this.hist.shift();
    if (this.albums.length > 10) this.albums.shift();
  }
  /** you skipped a track of this artist early: it comes up less */
  skip(key) { const p = this.byKey.get(key) || (this.seed && this.seed.key === key ? this.seed : null); if (p) p.pen *= 0.45; }
  ban(key) { const p = this.byKey.get(key); if (p) p.dead = true; if (this.seed && this.seed.key === key) this.seed.dead = true; }
  isSeedTurn() { return !!this.seed && !this.seed.dead && this.turn % this.seedEvery === this.seedEvery - 1; }

  weights() {
    const last = this.hist[this.hist.length - 1];
    const recent4 = this.hist.slice(-4);
    const ranked = this.pool.filter((p) => !p.dead).sort((a, b) => b.s - a.s);
    let cands = ranked;
    if (this.n < this.anchor && !this.relaxed) {
      // the first tracks: the closest artists only (the ones that carry the most evidence)
      const top = ranked.filter((p) => p.fit > 0.3).slice(0, this.anchorTop);
      if (top.length >= 2) cands = top;
    }
    const w = (p, capOK) => {
      if (p.key === last) return 0;
      const cnt = this.hist.reduce((s, k) => s + (k === p.key), 0);
      if (cnt >= this.cap && !capOK) return 0;
      let x = p.s * p.s * p.fit * p.fit * p.pen;          // an artist whose tracks keep sounding off fades quickly
      if (recent4.includes(p.key)) x *= 0.15;
      if (cnt >= this.cap) x *= 0.05;
      return x;
    };
    let list = cands.map((p) => ({ p, w: w(p, false) })).filter((x) => x.w > 1e-6);
    if (!list.length) list = cands.map((p) => ({ p, w: w(p, true) })).filter((x) => x.w > 1e-6);   // a small library: the cap gives way
    return list;
  }
  pick(list) {
    const total = list.reduce((s, x) => s + x.w, 0);
    let r = this.rnd() * total;
    for (const x of list) { r -= x.w; if (r <= 0) return x.p; }
    return list[list.length - 1].p;
  }
  /** the best track of an artist now, or null (and why) */
  async bestOf(p) {
    const all = (await this.tracksOf(p.key)) || [];
    const lastAlbums = new Set(this.albums.slice(-8));
    const fresh = all.filter((t) => !this.played.has(String(t.h).toLowerCase()) && !this.songs.has(p.key + '|' + songKey(t.title)));
    if (!fresh.length) return { none: 'used' };
    const floor = this.relaxed ? 0.0 : 0.04;
    const rate = (t, mul) => {
      const parts = [[t.sim, 0.62], [t.pop, 0.25], [t.plays, 0.13]].filter(([v]) => v != null);
      const W = parts.reduce((s, [, w]) => s + w, 0);
      let sc = W ? parts.reduce((s, [v, w]) => s + v * w, 0) / W : 0.4;
      if (t.sim == null) sc *= 0.8;                                      // not heard yet: a little behind the ones that are
      sc *= mul;
      if (lastAlbums.has(p.key + '|' + String(t.album || '').toLowerCase())) sc *= 0.35;
      if (this.near && t.rec) sc *= 1 - 0.6 * clamp01(this.near(t.rec));
      return sc;
    };
    let scored = [];
    for (const t of fresh) {
      const chk = songCheck(t, this.seedTrack);
      if (!chk.ok) continue;
      if (t.sim != null && t.sim < floor) continue;                      // sounds far from the seed
      scored.push({ t, sc: rate(t, chk.mul), mul: chk.mul });
    }
    if (!scored.length) return { none: 'far' };
    scored.sort((a, b) => b.sc - a.sc);
    // the best candidates whose sound is not known yet are listened to first (a few per turn): a track
    // is only chosen once the ones ranked above it are known
    if (this.measure) {
      let n = 0, far = 0;
      while (n < 6) {
        const top = scored.slice(0, 3).filter((x) => x.t.sim == null && !x.t.measured);
        if (!top.length) break;
        for (const x of top) { x.t.measured = true; x.t.sim = await this.measure(x.t); n++; if (x.t.sim != null && x.t.sim < floor) far++; }
        scored = scored.filter((x) => x.t.sim == null || x.t.sim >= floor).map((x) => ({ ...x, sc: rate(x.t, x.mul) })).sort((a, b) => b.sc - a.sc);
      }
      if (far >= 3 && far === n) p.fit *= 0.3;                          // everything heard of it sounds off
      if (!scored.length) return { none: 'far' };
    }
    // not always the single best: a little chance among the close ones keeps the radio alive
    const top = scored.slice(0, 4), hi = top[0].sc;
    const pool = top.map((x) => ({ p: x, w: Math.exp(-(hi - x.sc) / 0.05) }));
    return { pick: this.pick(pool) };
  }
  /** the next track: { t, key, why } or null when nothing fitting is left */
  async next() {
    for (let attempt = 0; attempt < 40; attempt++) {
      let p;
      if (this.isSeedTurn() && attempt < 2) p = this.seed;
      else {
        const list = this.weights();
        if (!list.length) { if (!this.relaxed) { this.relaxed = true; continue; } return null; }
        p = this.pick(list);
      }
      const r = await this.bestOf(p);
      p.tries++;
      if (!r.pick) {
        if (r.none === 'used') p.dead = true;
        else { p.fit *= 0.5; if (p.fit < 0.05) p.dead = true; }
        if (p === this.seed) this.turn++;                    // the seed's turn passes
        continue;
      }
      const { t, sc } = r.pick;
      if (t.sim != null) p.fit = Math.min(1, p.fit * 0.6 + (0.15 + 0.85 * t.sim) * 0.4);
      this.place(t, p.key); this.n++; this.turn++;
      const why = [...(p.why || [])];
      if (t.sim != null && t.sim >= 0.6) why.push('sound');
      if (t.pop != null && t.pop >= 0.6) why.push('hit');
      this.why.set(String(t.h).toLowerCase(), why);
      return { t, key: p.key, score: sc, why };
    }
    return null;
  }
}
