/*
 * Gatefold · yt-search.js — YouTube search, suggestions and metadata without an API key.
 *
 * Requests go through foobar2000 (bridge http): no CORS, no browser cookies.
 *   search    the results page's ytInitialData (videos only filter), more pages through
 *             the same internal endpoint the site uses (youtubei/v1/search + continuation)
 *   suggest   suggestqueries (the site's own search hints)
 *   oembed    title/channel of a single video, for pasted links and playlist items
 * Everything is parsed defensively: YouTube changes its markup, a broken parse yields
 * an empty list and a readable error, never an exception in the UI.
 */
import { httpGet, httpPost, ok, log } from './bridge.js';
import { settings } from './settings.js';
import { lang, locale } from './i18n.js';

import { $t } from './i18n.js';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HL = lang === 'zh' ? 'zh-CN' : lang;
const H = { 'User-Agent': UA, 'Accept-Language': lang === 'en' ? 'en-US,en;q=0.9' : `${locale},${lang};q=0.9,en;q=0.8`, Cookie: 'CONSENT=YES+cb.20240101-00-p0.ru+FX+000; SOCS=CAI' };
/** 'off' | 'api' | 'web' — how (and whether) search works; links always play */
export const mode = () => (settings.ytSearch === 'api' && settings.ytApiKey ? 'api' : settings.ytSearch === 'web' ? 'web' : 'off');
const enc = encodeURIComponent;
let inner = { key: '', ver: '2.20250101.00.00' };

const txt = (o) => !o ? '' : o.simpleText || (o.runs ? o.runs.map((r) => r.text).join('') : '') || (o.content || '');
export const thumb = (id, q = 'mqdefault') => `https://i.ytimg.com/vi/${id}/${q}.jpg`;
const durSec = (s) => String(s || '').split(':').reduce((a, x) => a * 60 + (+x || 0), 0);

function walk(o, out, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 40) return;
  if (Array.isArray(o)) { for (const x of o) walk(x, out, depth + 1); return; }
  if (o.videoRenderer) { out.videos.push(o.videoRenderer); return; }
  if (o.continuationItemRenderer) { const t = o.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token; if (t) out.cont = t; return; }
  for (const k in o) if (k !== 'frameworkUpdates') walk(o[k], out, depth + 1);
}
function toItem(v) {
  const id = v.videoId; if (!id) return null;
  const badges = JSON.stringify(v.badges || []) + JSON.stringify(v.thumbnailOverlays || []);
  const live = /LIVE|BADGE_STYLE_TYPE_LIVE_NOW/.test(badges) || (!v.lengthText && /watching|смотр/i.test(txt(v.viewCountText)));
  return {
    id, title: txt(v.title), channel: txt(v.ownerText) || txt(v.longBylineText) || txt(v.shortBylineText),
    dur: v.lengthText ? txt(v.lengthText) : '', sec: v.lengthText ? durSec(txt(v.lengthText)) : 0, live,
    views: txt(v.shortViewCountText) || txt(v.viewCountText), age: txt(v.publishedTimeText),
    thumb: thumb(id), desc: (v.detailedMetadataSnippets && txt(v.detailedMetadataSnippets[0]?.snippetText)) || txt(v.descriptionSnippet),
  };
}

async function get(url, headers = {}) {
  const r = await httpGet({ url, timeout: 15000, headers: { ...H, ...headers } });
  if (!ok(r)) throw new Error(r.error || $t('нет связи'));
  if (r.status && r.status >= 400) throw new Error($t('YouTube ответил ') + r.status);
  return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
}

/** → { items, cont } */
async function webSearch(q) {
  // sp=EgIQAQ== : type = video
  const html = await get(`https://www.youtube.com/results?search_query=${enc(q)}&sp=EgIQAQ%253D%253D&hl=${HL}${HL === 'ru' ? '&gl=RU' : ''}`);
  const key = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/); if (key) inner.key = key[1];
  const ver = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/); if (ver) inner.ver = ver[1];
  const m = html.match(/(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*(\{[\s\S]+?\});\s*(?:<\/script>|window\[|var\s)/);
  if (!m) { log('yt: no ytInitialData', html.slice(0, 200)); throw new Error($t('не удалось разобрать ответ YouTube')); }
  const data = JSON.parse(m[1]);
  const out = { videos: [], cont: '' };
  walk(data.contents || data, out);
  return { items: out.videos.map(toItem).filter(Boolean), cont: out.cont };
}
/** next page of a search → { items, cont } */
async function webMore(cont) {
  if (!cont) return { items: [], cont: '' };
  const r = await httpPost({
    url: `https://www.youtube.com/youtubei/v1/search?${inner.key ? 'key=' + inner.key + '&' : ''}prettyPrint=false`,
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: inner.ver, hl: HL, ...(HL === 'ru' ? { gl: 'RU' } : {}) } }, continuation: cont }),
    headers: { ...H, 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': inner.ver, Origin: 'https://www.youtube.com' }, timeout: 15000,
  });
  if (!ok(r) || !r.body) return { items: [], cont: '' };
  let j; try { j = typeof r.body === 'string' ? JSON.parse(r.body) : r.body; } catch { return { items: [], cont: '' }; }
  const out = { videos: [], cont: '' };
  walk(j.onResponseReceivedCommands || j, out);
  return { items: out.videos.map(toItem).filter(Boolean), cont: out.cont };
}

// ---------------------------------------------------------------- YouTube Data API v3 (official; the user's own key)
/* search.list costs 100 quota units of the free 10 000 a day (≈100 searches); videos.list, which
   adds durations and view counts, costs 1. Next pages use pageToken. */
const isoDur = (s) => { const m = String(s || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0; };
const fmtDur = (sec) => { const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
const loc = () => locale;
const VIEWS = { ru: '# просмотров', en: '# views', de: '# Aufrufe', es: '# visualizaciones', zh: '# 次观看' };
function ago(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000; if (!(d > 0)) return '';
  const rtf = new Intl.RelativeTimeFormat(loc(), { numeric: 'auto' });
  const U = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [s, u] of U) if (d >= s) return rtf.format(-Math.floor(d / s), u);
  return rtf.format(0, 'minute');
}
async function apiGet(path, params) {
  const qs = Object.entries({ ...params, key: settings.ytApiKey }).map(([k, v]) => k + '=' + enc(v)).join('&');
  const r = await httpGet({ url: `https://www.googleapis.com/youtube/v3/${path}?${qs}`, timeout: 15000, headers: { Accept: 'application/json' } });
  if (!ok(r)) throw new Error(r.error || 'network');
  let j; try { j = typeof r.body === 'string' ? JSON.parse(r.body) : r.body; } catch { throw new Error('YouTube API: bad response'); }
  if (j && j.error) throw new Error('YouTube API: ' + (j.error.errors && j.error.errors[0] && j.error.errors[0].reason || j.error.message || r.status));
  return j;
}
async function apiSearch(q, pageToken) {
  const s = await apiGet('search', { part: 'snippet', type: 'video', maxResults: 24, q, relevanceLanguage: lang === 'zh' ? 'zh-Hans' : lang, ...(pageToken ? { pageToken } : {}) });
  const ids = (s.items || []).map((x) => x.id && x.id.videoId).filter(Boolean);
  const meta = new Map();
  if (ids.length) {
    const v = await apiGet('videos', { part: 'contentDetails,statistics', id: ids.join(',') }).catch(() => ({ items: [] }));
    for (const x of v.items || []) meta.set(x.id, x);
  }
  const nf = new Intl.NumberFormat(loc(), { notation: 'compact', maximumFractionDigits: 1 });
  const items = (s.items || []).filter((x) => x.id && x.id.videoId).map((x) => {
    const id = x.id.videoId, sn = x.snippet || {}, m = meta.get(id);
    const sec = m ? isoDur(m.contentDetails && m.contentDetails.duration) : 0;
    const live = sn.liveBroadcastContent === 'live';
    const views = m && m.statistics && m.statistics.viewCount != null ? nf.format(+m.statistics.viewCount) : '';
    const tx = document.createElement('textarea');            // titles come HTML-escaped
    const un = (h) => { tx.innerHTML = h || ''; return tx.value; };
    return { id, title: un(sn.title), channel: un(sn.channelTitle), dur: !live && sec ? fmtDur(sec) : '', sec, live, views: views ? VIEWS[lang].replace('#', views) : '', age: sn.publishedAt ? ago(sn.publishedAt) : '', thumb: thumb(id), desc: un(sn.description) };
  });
  return { items, cont: s.nextPageToken ? 'api:' + s.nextPageToken : '' };
}

let apiQ = '';
/** search in the chosen mode → { items, cont } */
export async function search(q) {
  const m = mode();
  if (m === 'api') { apiQ = q; return apiSearch(q); }
  if (m === 'web') return webSearch(q);
  const e = new Error('search-off'); e.code = 'OFF'; throw e;
}
export async function more(cont) {
  if (!cont) return { items: [], cont: '' };
  if (cont.startsWith('api:')) return apiSearch(apiQ, cont.slice(4));
  return webMore(cont);
}

/** search hints while typing (the site's own unofficial endpoint — only in 'web' mode) */
export async function suggest(q) {
  if (mode() !== 'web') return [];
  try {
    const t = await get(`https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&hl=${HL}&q=${enc(q)}`);
    const m = t.match(/\(([\s\S]*)\)\s*$/); const arr = JSON.parse(m ? m[1] : t);
    return (arr[1] || []).map((x) => (Array.isArray(x) ? x[0] : x)).filter((x) => typeof x === 'string').slice(0, 8);
  } catch { return []; }
}

/** title and channel of one video (pasted links, playlist items) */
const oeCache = new Map();
export async function oembed(id) {
  if (oeCache.has(id)) return oeCache.get(id);
  let v = null;
  try {
    const j = JSON.parse(await get(`https://www.youtube.com/oembed?format=json&url=${enc('https://www.youtube.com/watch?v=' + id)}`));
    v = { id, title: j.title || '', channel: j.author_name || '', thumb: thumb(id) };
  } catch { v = { id, title: '', channel: '', thumb: thumb(id) }; }
  oeCache.set(id, v);
  return v;
}

/** thumbnail as a data: URL (readable pixels → palette) */
export async function thumbData(id) {
  for (const q of ['mqdefault', 'hqdefault']) {
    const r = await httpGet({ url: thumb(id, q), responseType: 'base64', timeout: 12000, headers: { 'User-Agent': UA } });
    if (ok(r) && r.body && (!r.status || r.status < 400)) return 'data:image/jpeg;base64,' + r.body;
  }
  return '';
}

/** "https://youtu.be/ID?t=42", "…watch?v=ID&list=…", "…/shorts/ID", a bare 11-char id → { id, list, start } | null */
export function parseLink(s) {
  s = String(s || '').trim();
  if (!s) return null;
  const id = (s.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/)|music\.youtube\.com\/watch\?(?:[^#]*&)?v=)([\w-]{11})/i) || [])[1]
    || (/^[\w-]{11}$/.test(s) && /[-_\d]/.test(s) ? s : null);
  const list = (s.match(/[?&]list=([\w-]{10,})/) || [])[1] || null;
  const tm = s.match(/[?&#](?:t|start)=(?:(\d+)h)?(?:(\d+)m)?(\d+)?s?/);
  const start = tm ? (+(tm[1] || 0)) * 3600 + (+(tm[2] || 0)) * 60 + (+(tm[3] || 0)) : 0;
  if (!id && !list) return null;
  return { id, list, start };
}
