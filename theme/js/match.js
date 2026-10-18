/*
 * Gatefold · match.js — metadata normalisation + fuzzy matching for cover search.
 * Pure functions (unit-tested in Node).
 */
const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',і:'i',ї:'yi',є:'ye',ґ:'g' };

export const translit = (s) => s.replace(/[а-яёіїєґ]/g, (c) => TR[c] ?? c);

/** Edition/format noise that differs between a local rip and store listings. */
const NOISE = /\s*[([{][^)\]}]*(deluxe|edition|remaster|remastered|expanded|anniversary|bonus|special|explicit|clean|version|reissue|mono|stereo|hi-?res|24.?bit|96.?khz|flac|mp3|web|vinyl|cd\s*\d*|disc\s*\d*|disk\s*\d*|ep|single|lp|ost|издание|переиздание|ремастер)[^)\]}]*[)\]}]/gi;

export function cleanAlbum(s) {
  let t = String(s || '');
  t = t.replace(NOISE, ' ');
  t = t.replace(/\s*[-–—:]\s*(the\s+)?(super\s+)?(deluxe|expanded|remaster(ed)?|anniversary|special|bonus|\d+(st|nd|rd|th)\s+anniversary)\b.*$/i, '');
  t = t.replace(/\s+\d+(st|nd|rd|th)?\s+anniversary(\s+(edition|version))?\s*$/i, '');
  t = t.replace(/\s+(super\s+)?deluxe(\s+(edition|version))?\s*$/i, '');
  t = t.replace(/\s+(expanded|special|collector'?s)\s+edition\s*$/i, '');
  t = t.replace(/\s+remaster(ed)?(\s+\d{4})?\s*$/i, '');
  t = t.replace(/\s*[-–—]\s*(ep|single)\s*$/i, '');
  t = t.replace(/\b(cd|disc|disk)\s*\d+\b/gi, ' ');
  t = t.replace(/\s*[([]\s*[A-Z]{2,6}[- ]?\d{3,7}(?:[-~]\d{1,4})?\s*[)\]]/g, ' '); // catalogue numbers: (UICY-25145)
  return t.replace(/\s{2,}/g, ' ').trim() || String(s || '').trim();
}

/** For search queries: drop only guest credits, keep "Simon & Garfunkel" intact. */
export function queryArtist(s) {
  return String(s || '').split(/\s*(?:;|\/|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i)[0].trim() || String(s || '').trim();
}

export function cleanArtist(s) {
  return String(s || '')
    .split(/\s*(?:;|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bvs\.?|\bwith\b|\bx\b|,|&|\band\b|\bи\b)\s*/i)[0]
    .trim() || String(s || '').trim();
}

export const isVarious = (a) => /^(various( artists)?|va|v\.a\.|сборник|разные исполнители|various artist)$/i.test(String(a || '').trim());

export function norm(s) {
  return translit(String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''))
    .replace(/&/g, ' and ')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9À-ɏͰ-Ͽ぀-ヿ一-鿿가-힯]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s) {
  const m = new Map();
  const t = s.replace(/\s+/g, '');
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
function dice(a, b) {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  if (a.replace(/\s/g, '').length < 2 || b.replace(/\s/g, '').length < 2) return a === b ? 1 : 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) || 0);
  return (2 * inter) / (na + nb);
}
function tokenSet(a, b) {
  const A = new Set(a.split(' ').filter(Boolean)), B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size) * (0.75 + 0.25 * inter / Math.max(A.size, B.size));
}

/** Similarity 0..1 robust to word order, punctuation, script (Кино≈Kino) and editions. */
export function similarity(x, y) {
  const a = norm(x), b = norm(y);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [sh, lo] = a.length <= b.length ? [a, b] : [b, a];
  // Dice/token overlap stay high when one name merely contains the other
  // ("Daft Punk" ⊂ "Daft Punk Tribute Band"); damp by length ratio.
  let s = Math.max(dice(a, b), tokenSet(a, b)) * (0.7 + 0.3 * (sh.length / lo.length));
  // containment ("Discovery" ⊂ "Discovery Live"): credible, but only as much as the length ratio allows
  if (sh.length >= 4 && (lo.startsWith(sh + ' ') || lo.endsWith(' ' + sh))) s = Math.max(s, 0.55 + 0.25 * (sh.length / lo.length));
  // Words that make a *different release* with a different cover: "X" ≠ "X Live" ≠ "X Vol. 2".
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  const diff = [...A].filter((t) => !B.has(t)).concat([...B].filter((t) => !A.has(t)));
  if (diff.some((t) => DISTINCT.test(t) || /\d/.test(t))) s *= 0.72;
  return Math.min(1, s);
}
const DISTINCT = /^(live|demos?|remix(es|ed)?|acoustic|sessions?|unplugged|instrumentals?|b|sides|rarities|vol|volume|part|pt|ii|iii|iv|[2-9]|best|greatest|hits|collection|anthology|essential|karaoke|orchestral|symphonic|концерт|живьём|лучшее|сборник|часть)$/;

/**
 * Score a store candidate against the local album.
 * local: { artist, album, year, tracks }   cand: { artist, title, year, tracks }
 */
export function scoreCandidate(local, cand) {
  const va = isVarious(local.artist);
  const sAlbum = Math.max(similarity(cleanAlbum(local.album), cleanAlbum(cand.title)), similarity(local.album, cand.title));
  const sArtist = va ? (isVarious(cand.artist) ? 1 : 0.8) : Math.max(similarity(cleanArtist(local.artist), cleanArtist(cand.artist)), similarity(local.artist, cand.artist));
  if (sAlbum < 0.58 || sArtist < 0.5) return { score: 0, sAlbum, sArtist };
  let score = 0.56 * sAlbum + 0.44 * sArtist;
  // near-misses are where wrong covers come from: penalise them super-linearly
  if (sAlbum < 0.92) score -= (0.92 - sAlbum) * 0.4;
  if (sArtist < 0.9) score -= (0.9 - sArtist) * 0.5;
  if (local.tracks && cand.tracks) {
    const d = Math.abs(local.tracks - cand.tracks);
    score += d === 0 ? 0.05 : d <= 2 ? 0.025 : d > 6 ? -0.05 : 0;
  }
  const ly = parseInt(local.year, 10), cy = parseInt(cand.year, 10);
  if (ly && cy) { const d = Math.abs(ly - cy); score += d === 0 ? 0.04 : d <= 1 ? 0.02 : d > 4 ? -0.035 : 0; }
  return { score: Math.max(0, Math.min(1, score)), sAlbum, sArtist };
}
