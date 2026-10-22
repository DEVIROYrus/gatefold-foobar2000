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
 *   t('Текст\u0004lyrics')                → 'Lyrics' — a context after U+0004 (gettext's msgctxt) tells
 *                                           apart one Russian word that other languages say differently;
 *                                           in markup it is the data-ctx attribute
 *
 * The language is fixed for the page's lifetime: changing it in Settings reloads the interface,
 * which is simpler and safer than re-rendering every view in place.
 */
/* each language's file is loaded on demand: only the one in use is fetched and parsed */
const LOAD = {
  en: () => import('./locales/en.js'),
  de: () => import('./locales/de.js'),
  es: () => import('./locales/es.js'),
  zh: () => import('./locales/zh.js'),
};
export const LANGS = { ru: 'Русский', en: 'English', de: 'Deutsch', es: 'Español', zh: '中文' };
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
    if (LOAD[base]) return base;
  }
  return 'en';
}

let cur = detect(), DICT = null;
if (cur !== 'ru') {
  try { DICT = (await LOAD[cur]()).default; }
  catch {   // a missing file (an old copy of the theme) → English, then the Russian source
    cur = 'en';
    try { DICT = (await LOAD.en()).default; } catch { cur = 'ru'; }
  }
}
export const lang = cur;
const missing = new Set();
if (typeof window !== 'undefined') window.__i18nMissing = missing;
const fill = (s, args) => (args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[+i] ?? '')) : s);

/** translate a source (Russian) string; {0}, {1}… are filled from the arguments */
const CTX = '\u0004';
export function t(key, ...args) {
  if (!DICT) return fill(key.split(CTX)[0], args);
  let s = DICT[key];
  if (s == null) { missing.add(key); s = key.split(CTX)[0]; }
  return fill(s, args);
}

/** the name used across the code base — `t` is too often a local (track, time) */
export const $t = t;

const pr = new Intl.PluralRules(lang);
/** the right word form for n: Russian one/few/many; other languages one/other (from the locale's "a|b|c" entry) */
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
  return pr.select(n) === 'one' ? o : (other ?? o);
}

/** BCP 47 tag for Intl / Accept-Language */
export const locale = { ru: 'ru-RU', en: 'en-US', de: 'de-DE', es: 'es-ES', zh: 'zh-CN' }[lang];
/** number formatting in the interface language (1 234 / 1,234 / 1.234) */
export const num = (n, opts) => new Intl.NumberFormat(locale, opts).format(n);

/* Static markup (index.html, canvas.html) is written in Russian; in other languages its text nodes and
   title / placeholder / aria-label / alt attributes are swapped once at start-up. Only nodes
   whose text exactly matches a source string change, so music data is never touched. */
const ATTRS = ['title', 'data-tip', 'placeholder', 'aria-label', 'alt'];
export function translateDom(root = document.body) {
  document.documentElement.lang = lang;
  if (!DICT || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const cyr = /[А-Яа-яЁё]/;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue; if (!cyr.test(raw)) continue;
    const key = raw.trim(), ctx = n.parentElement && n.parentElement.dataset.ctx;
    const full = ctx ? key + CTX + ctx : key, tr = DICT[full];
    if (tr != null) n.nodeValue = raw.replace(key, tr); else missing.add(full);
  }
  for (const el of root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a); if (!v || !cyr.test(v)) continue;
      const tr = DICT[v]; if (tr != null) el.setAttribute(a, tr); else missing.add(v);
    }
  }
}
