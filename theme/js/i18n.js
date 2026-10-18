/*
 * Gatefold · i18n.js — interface language.
 *
 * Source strings are Russian (the language the theme was written in); a locale file maps each
 * of them to its translation, the way gettext maps msgid → msgstr. Untranslated strings fall
 * back to Russian and are collected in window.__i18nMissing for the test suite.
 *
 *   t('Слушать')                          → 'Play'
 *   t('Удалить плейлист «{0}»?', name)    → 'Delete playlist “Road trip”?'   ({0}, {1} … positional)
 *   plural(n, 'трек', 'трека', 'треков')  → 'track' / 'tracks'  (CLDR rules via Intl.PluralRules)
 *
 * The language is fixed for the page's lifetime: changing it in Settings reloads the interface,
 * which is simpler and safer than re-rendering every view in place.
 */
import EN from './locales/en.js';

export const LANGS = { ru: 'Русский', en: 'English' };
const SETTINGS_KEY = 'aurora.settings.v1';

function detect() {
  let pref = 'auto';
  try { pref = (JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}).language || 'auto'; } catch {}
  if (LANGS[pref]) return pref;
  const list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en']);
  // the first language the system asks for that we have; Belarusian and Kazakh users usually read Russian
  for (const l of list) {
    const base = String(l).toLowerCase().split('-')[0];
    if (base === 'ru' || base === 'be' || base === 'kk') return 'ru';
    if (base === 'en') return 'en';
  }
  return 'en';
}

export const lang = detect();
const DICT = lang === 'en' ? EN : null;
const missing = new Set();
if (typeof window !== 'undefined') window.__i18nMissing = missing;
const fill = (s, args) => (args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[+i] ?? '')) : s);

/** translate a source (Russian) string; {0}, {1}… are filled from the arguments */
export function t(key, ...args) {
  if (!DICT) return fill(key, args);
  let s = DICT[key];
  if (s == null) { missing.add(key); s = key; }
  return fill(s, args);
}

/** the name used across the code base — `t` is too often a local (track, time) */
export const $t = t;

const prEn = new Intl.PluralRules('en');
/** the right word form for n: Russian one/few/many, English one/other (from the locale's "a|b|c" entry) */
export function plural(n, one, few, many) {
  if (!DICT) {
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
    return many;
  }
  const e = DICT[`${one}|${few}|${many}`];
  if (e == null) { missing.add(`${one}|${few}|${many}`); return many; }
  const [o, other] = e.split('|');
  return prEn.select(n) === 'one' ? o : (other ?? o);
}

/** number formatting in the interface language (1 234 / 1,234) */
export const num = (n, opts) => new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'ru-RU', opts).format(n);

/* Static markup (index.html, canvas.html) is written in Russian; in English its text nodes and
   title / placeholder / aria-label / alt attributes are swapped once at start-up. Only nodes
   whose text exactly matches a source string change, so music data is never touched. */
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
export function translateDom(root = document.body) {
  document.documentElement.lang = lang;
  if (!DICT || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const cyr = /[А-Яа-яЁё]/;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue; if (!cyr.test(raw)) continue;
    const key = raw.trim(); const tr = DICT[key];
    if (tr != null) n.nodeValue = raw.replace(key, tr); else missing.add(key);
  }
  for (const el of root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a); if (!v || !cyr.test(v)) continue;
      const tr = DICT[v]; if (tr != null) el.setAttribute(a, tr); else missing.add(v);
    }
  }
}
