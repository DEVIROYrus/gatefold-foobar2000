/*
 * Gatefold · artistnames.js — one name field, several artists.
 *
 * «Artist A; Artist B» (or two values of a multi-value tag) is two artists: the album is listed under
 * each of them in Artists, and a playlist row links each name to its own page. «;» and multi-value tags
 * are split by default — nobody writes «;» inside a name. «/», «,», «&» and «feat.» are common inside real
 * names (AC/DC; Earth, Wind & Fire; Simon & Garfunkel), so they are opt-in in Settings → Library, with a
 * preview of every name the choice would split and a list of names that are never split.
 */
import { settings } from './settings.js';

export const SEPARATORS = [
  { id: ';', label: ';', re: /\s*;\s*/g },
  { id: '/', label: '/', re: /\s*\/\s*/g },
  { id: ',', label: ',', re: /\s*,\s*/g },
  { id: '&', label: '&', re: /\s+&\s+/g },
  { id: 'feat', label: 'feat. · ft.', re: /\s+(?:feat\.?|ft\.?|featuring)\s+|\s*[([](?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]\s*/gi },
];
const lc = (s) => String(s || '').trim().toLowerCase();

/* your own separators («x», «vs.», «+», «×»…) are kept with the others as 'c:<text>'. A word (letters or
   digits at an edge) splits only between spaces — «x» splits «A x B», never «Xzibit»; a sign may touch the names. */
export const CUSTOM = 'c:';
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** a separator typed by the user, cleaned: '' when it is not one */
export function customText(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length && t.length <= 12 ? t : '';
}
const customCache = new Map();
export function custom(text) {
  let sp = customCache.get(text);
  if (!sp) {
    const word = /^[\p{L}\p{N}]|[\p{L}\p{N}]$/u.test(text), body = reEsc(text).replace(/ /g, '\\s+');
    sp = { id: CUSTOM + text, label: text, custom: true, re: new RegExp(word ? `\\s+${body}\\s+` : `\\s*${body}\\s*`, 'giu') };
    customCache.set(text, sp);
  }
  return sp;
}
/** the separators in use (from the settings, or the ones given) */
export function active(ids = settings.artistSplit) {
  const list = Array.isArray(ids) ? ids : [';'], on = new Set(list);
  const own = list.filter((id) => typeof id === 'string' && id.startsWith(CUSTOM)).map((id) => customText(id.slice(CUSTOM.length))).filter(Boolean);
  return [...SEPARATORS.filter((s) => on.has(s.id)), ...[...new Set(own)].map(custom)];
}
let keepFor = null, keepSet = new Set();
const kept = () => { if (keepFor !== settings.artistKeep) { keepFor = settings.artistKeep; keepSet = new Set((settings.artistKeep || []).map(lc)); } return keepSet; };

/** the artists one name stands for: «A; B» → [A, B]; a name in the «never split» list stays whole */
export function split(name, seps = active(), keep = kept()) {
  const s = String(name || '').trim();
  if (!s) return [];
  if (!seps.length || keep.has(lc(s))) return [s];
  let parts = [s];
  for (const sep of seps) {
    parts = parts.flatMap((p) => {
      if (keep.has(lc(p))) return [p];
      // «A (feat. B)»: the guest in brackets is a name of its own
      const out = []; let rest = p.replace(sep.re, (m, inner) => { if (typeof inner === 'string' && inner) out.push(inner); return '\u0000'; });
      return [...rest.split('\u0000'), ...out];
    }).map((x) => x.trim()).filter(Boolean);
  }
  const seen = new Set();
  return parts.filter((p) => { const k = lc(p); if (seen.has(k)) return false; seen.add(k); return true; });
}
/** the artists of several tag values (a multi-value tag), each split too */
export function splitAll(values, seps = active()) {
  const seen = new Set(), out = [];
  for (const v of values || []) for (const n of split(v, seps)) { const k = lc(n); if (!seen.has(k)) { seen.add(k); out.push(n); } }
  return out;
}
/** the names a choice of separators would split, for the preview: [{ name, parts }] */
export function preview(names, ids, keep = settings.artistKeep || []) {
  const seps = active(ids), k = new Set(keep.map(lc));
  const out = [], seen = new Set();
  for (const n of names) {
    const key = lc(n); if (!key || seen.has(key)) continue; seen.add(key);
    const parts = split(n, seps, new Set());
    if (parts.length > 1) out.push({ name: n, parts, kept: k.has(key) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
/** a name cut into its artists, keeping the text between them: [{ text, name }] (name: an artist) */
export function segments(text, seps = active()) {
  const s = String(text || '');
  const parts = split(s, seps);
  if (parts.length < 2) return s ? [{ text: s, name: s.trim() }] : [];
  const low = s.toLowerCase(), out = [];
  let at = 0;
  for (const p of parts) {
    const i = low.indexOf(p.toLowerCase(), at);
    if (i < 0) return parts.flatMap((x, j) => (j ? [{ text: ', ' }, { text: x, name: x }] : [{ text: x, name: x }]));
    if (i > at) out.push({ text: s.slice(at, i) });
    out.push({ text: s.slice(i, i + p.length), name: p });
    at = i + p.length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}
