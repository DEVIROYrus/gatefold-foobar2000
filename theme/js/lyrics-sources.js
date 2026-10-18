/*
 * Gatefold · lyrics-sources.js — online synced-lyrics providers.
 *
 *   LRCLIB        lrclib.net — open database, no key; line (sometimes word) sync
 *   Musixmatch    the largest catalogue; line sync and «richsync» word sync. Uses the
 *                 desktop app's anonymous token; Musixmatch may rate-limit it (we back off)
 *   NetEase       NetEase Cloud Music — huge for Asian/K-pop/J-pop, good for the rest;
 *                 line sync plus «yrc» word sync
 *   QQ Музыка     Tencent; strong for Chinese/Korean catalogues
 *   Kugou         big crowd-sourced LRC base, many niche tracks
 *
 * All requests go through foobar2000 (bridge http, off the UI thread): no CORS, no
 * browser cookies. Every provider returns candidates in one shape; one scoring picks
 * the best: synced beats plain, word-synced beats line-synced, then how well title,
 * artist and length match. All found variants are kept so the user can switch.
 */
import { httpGet, ok, log } from './bridge.js';
import { similarity } from './match.js';
import { getJSON } from './coverfetch.js';

import { $t } from './i18n.js';
const enc = encodeURIComponent;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const PROVIDERS = [
  { id: 'lrclib', name: 'LRCLIB', official: true, desc: $t('Открытая база, без ключей') },
  { id: 'musixmatch', name: 'Musixmatch', desc: $t('Самый большой каталог; синхронизация по строкам и по словам') },
  { id: 'netease', name: 'NetEase Cloud Music', desc: $t('Огромная база, особенно азиатская музыка; по словам') },
  { id: 'qq', name: $t('QQ Музыка'), desc: $t('Китайский и корейский каталоги') },
  { id: 'kugou', name: 'Kugou', desc: $t('Большая народная база LRC') },
];
export const nameOf = (id) => (PROVIDERS.find((p) => p.id === id) || {}).name || id;

// ---------------------------------------------------------------- http helpers
async function getText(url, headers = {}, timeout = 12000) {
  const r = await httpGet({ url, timeout, headers: { 'User-Agent': UA, Accept: '*/*', ...headers } });
  if (!ok(r)) return null;
  if (r.status && r.status >= 400) return r.status === 401 ? { status: 401 } : null;
  return r.body == null ? null : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
}
async function getJson(url, headers, timeout) {
  const t = await getText(url, headers, timeout);
  if (t == null) return null;
  if (typeof t === 'object') return t;                          // {status:401}
  let s = String(t).trim();
  if (!/^[{[]/.test(s)) { const m = s.match(/^[\w.$]+\(([\s\S]*)\)\s*;?$/); if (m) s = m[1]; }   // JSONP
  try { return JSON.parse(s); } catch { return null; }
}
const b64utf8 = (b) => { try { const bin = atob(String(b).replace(/\s+/g, '')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder('utf-8').decode(u); } catch { return ''; } };
const unent = (s) => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const stamp = (sec) => { sec = Math.max(0, +sec || 0); const m = Math.floor(sec / 60), s = sec - m * 60; return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`; };

// ---------------------------------------------------------------- matching
export const cleanTitle = (s) => String(s || '')
  .replace(/\s*[([][^)\]]*\b(remaster(ed)?|mono|stereo|bonus|explicit|deluxe|single version|album version|radio edit|feat\.?|ft\.?|prod\.?)\b[^)\]]*[)\]]/gi, '')
  .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|mono|stereo)(\s+\d{4})?(\s+version)?\s*$/i, '')
  .replace(/\s+(feat\.?|ft\.?)\s+.*$/i, '')
  .trim();
const SPLIT = /\s*(?:,|;|\/|&|\+|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?|\bx\b|、|和)\s*/i;
const firstArtist = (s) => String(s || '').split(SPLIT).map((x) => x.trim()).filter(Boolean)[0] || String(s || '');
function artistSim(a, b) {
  const A = String(a || '').split(SPLIT).filter(Boolean), B = String(b || '').split(SPLIT).filter(Boolean);
  let m = similarity(a || '', b || '');
  for (const x of A) for (const y of B) m = Math.max(m, similarity(x, y));
  return m;
}
/** How well a candidate fits the track: { ok, s } */
export function fit(t, c) {
  const st = Math.max(similarity(cleanTitle(t.title), cleanTitle(c.title)), similarity(t.title || '', c.title || ''));
  const sa = artistSim(t.artist || t.albumArtist, c.artist);
  const ds = t.duration && c.duration ? Math.abs(t.duration - c.duration) : null;
  const durOk = ds == null || ds <= 4;
  // transliterated artists (유주 / YUJU, 周杰伦 / Jay Chou) rarely look alike: then title + exact length must carry it
  const okk = durOk && st >= 0.78 && (sa >= 0.6 || (ds != null && ds <= 2 && st >= 0.9));
  const s = st * 2 + sa + (ds == null ? 0.2 : ds <= 1 ? 1 : ds <= 2 ? 0.8 : ds <= 4 ? 0.4 : -2);
  return { ok: okk, s };
}
const best = (t, list) => list.map((c) => ({ c, f: fit(t, c) })).filter((x) => x.f.ok).sort((a, b) => b.f.s - a.f.s)[0] || null;
const durOf = (t) => Math.round(t.duration || 0);

// ---------------------------------------------------------------- LRCLIB
async function lrclib(t) {
  const artist = t.artist || t.albumArtist, title = t.title, dur = durOf(t);
  const tryGet = async (ti) => {
    const q = `artist_name=${enc(artist)}&track_name=${enc(ti)}${t.album ? `&album_name=${enc(t.album)}` : ''}${dur ? `&duration=${dur}` : ''}`;
    const j = await getJSON('https://lrclib.net/api/get?' + q);
    return j && (j.syncedLyrics || j.plainLyrics || j.instrumental) ? j : null;
  };
  let hit = await tryGet(title);
  const ct = cleanTitle(title);
  if (!hit && ct && ct !== title) hit = await tryGet(ct);
  if (!hit) {
    const arr = await getJSON(`https://lrclib.net/api/search?track_name=${enc(ct || title)}&artist_name=${enc(firstArtist(artist))}`);
    const b = best(t, (Array.isArray(arr) ? arr : []).filter((x) => x.syncedLyrics || x.plainLyrics).map((x) => ({ ...x, title: x.trackName, artist: x.artistName, duration: x.duration })));
    hit = b && b.c;
  }
  if (!hit) return null;
  return { title: hit.trackName || title, artist: hit.artistName || artist, duration: hit.duration, synced: hit.syncedLyrics || '', plain: hit.plainLyrics || '', instrumental: !!hit.instrumental, id: hit.id };
}

// ---------------------------------------------------------------- Musixmatch (desktop API, anonymous token)
const MXM = 'https://apic-desktop.musixmatch.com/ws/1.1/';
const MXM_APP = 'web-desktop-app-v1.0';
const MXM_H = { Cookie: 'AWSELB=0; AWSELBCORS=0; x-mxm-token-guid=', Origin: 'musixmatch', Accept: 'application/json' };
const mxm = (() => { try { return JSON.parse(localStorage.getItem('aurora.mxm') || '{}'); } catch { return {}; } })();
const mxmSave = () => { try { localStorage.setItem('aurora.mxm', JSON.stringify(mxm)); } catch {} };
async function mxmToken(force) {
  if (!force && mxm.token && Date.now() - (mxm.at || 0) < 6 * 3600e3) return mxm.token;
  if (Date.now() < (mxm.blockedUntil || 0)) return null;
  const j = await getJson(`${MXM}token.get?app_id=${MXM_APP}&user_language=en&t=${Date.now()}`, MXM_H);
  const tok = j && j.message && j.message.body && j.message.body.user_token;
  if (tok && !/UpgradeOnly|undefined/i.test(tok)) { mxm.token = tok; mxm.at = Date.now(); mxm.blockedUntil = 0; mxmSave(); return tok; }
  // 401 «captcha»: Musixmatch rate-limits anonymous tokens — leave it alone for a while
  mxm.blockedUntil = Date.now() + 15 * 60e3; mxm.token = ''; mxmSave();
  log('musixmatch: no token', j && j.message && j.message.header);
  return null;
}
async function musixmatch(t) {
  const artist = t.artist || t.albumArtist, title = cleanTitle(t.title) || t.title, dur = durOf(t);
  let tok = await mxmToken(); if (!tok) return null;
  const url = (tk) => `${MXM}macro.subtitles.get?format=json&namespace=lyrics_richsynched&subtitle_format=mxm&optional_calls=track.richsync&app_id=${MXM_APP}`
    + `&q_artist=${enc(artist)}&q_track=${enc(title)}${t.album ? `&q_album=${enc(t.album)}` : ''}${dur ? `&q_duration=${dur}&f_subtitle_length=${dur}&f_subtitle_length_max_deviation=3` : ''}&usertoken=${enc(tk)}`;
  let j = await getJson(url(tok), MXM_H);
  if (j && (j.status === 401 || (j.message && j.message.header && j.message.header.status_code === 401))) { tok = await mxmToken(true); if (!tok) return null; j = await getJson(url(tok), MXM_H); }
  const calls = j && j.message && j.message.body && j.message.body.macro_calls; if (!calls) return null;
  const body = (k) => (calls[k] && calls[k].message && calls[k].message.body) || null;
  const tr = body('matcher.track.get') && body('matcher.track.get').track; if (!tr) return null;
  const cand = { title: tr.track_name, artist: tr.artist_name, duration: tr.track_length };
  if (!fit(t, cand).ok) return null;
  if (tr.instrumental) return { ...cand, instrumental: true, synced: '', plain: '' };
  let synced = '', words = false;
  try {
    const rs = body('track.richsync.get') && body('track.richsync.get').richsync && body('track.richsync.get').richsync.richsync_body;
    if (rs) { synced = JSON.parse(rs).map((ln) => `[${stamp(ln.ts)}]` + (ln.l || []).map((w) => `<${stamp(ln.ts + (w.o || 0))}>${w.c}`).join('')).join('\n'); words = true; }
  } catch { synced = ''; }
  if (!synced) {
    try {
      const sub = body('track.subtitles.get') && body('track.subtitles.get').subtitle_list && body('track.subtitles.get').subtitle_list[0];
      const sb = sub && sub.subtitle && sub.subtitle.subtitle_body;
      if (sb) synced = JSON.parse(sb).map((x) => `[${stamp(x.time && x.time.total)}]${x.text || ''}`).join('\n');
    } catch { synced = ''; }
  }
  let plain = (body('track.lyrics.get') && body('track.lyrics.get').lyrics && body('track.lyrics.get').lyrics.lyrics_body) || '';
  plain = plain.replace(/\n*\*{3,}[^\n]*\*{3,}[\s\S]*$/, '').trim();          // «This Lyrics is NOT for Commercial use» tail
  if (!synced && !plain) return null;
  return { ...cand, synced, plain, words };
}

// ---------------------------------------------------------------- NetEase Cloud Music
const NE_H = { Referer: 'https://music.163.com/', Cookie: 'appver=8.9.70; os=pc', Origin: 'https://music.163.com' };
const NE_CREDIT = /^\s*(作词|作曲|编曲|制作人|混音|母带|录音|监制|和声|吉他|贝斯|鼓|弦乐|出品|发行|OP|SP|Lyricist|Composer|Arranger|Producer)\s*[:：]/i;
function neteaseLrc(text) {
  return String(text || '').split(/\r?\n/).filter((l) => !/^\s*\{/.test(l)).filter((l) => !NE_CREDIT.test(l.replace(/^\[[^\]]*\]/, ''))).join('\n');
}
/** yrc: "[16210,3460](16210,670,0)word(16880,410,0)word" → enhanced LRC */
function yrcToLrc(yrc) {
  const out = [];
  for (const line of String(yrc || '').split(/\r?\n/)) {
    const m = line.match(/^\[(\d+),(\d+)\](.*)$/); if (!m) continue;
    const words = [...m[3].matchAll(/\((\d+),(\d+),\d+\)([^(]*)/g)].map((w) => `<${stamp(+w[1] / 1000)}>${w[3]}`);
    const text = words.join('').replace(/<[^>]+>/g, '');
    if (NE_CREDIT.test(text)) continue;
    out.push(`[${stamp(+m[1] / 1000)}]${words.join('')}`);
  }
  return out.length > 2 ? out.join('\n') : '';
}
async function netease(t) {
  const artist = firstArtist(t.artist || t.albumArtist), title = cleanTitle(t.title) || t.title;
  const j = await getJson(`https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${enc(artist + ' ' + title)}&type=1&offset=0&total=true&limit=15`, NE_H);
  const songs = (j && j.result && j.result.songs) || [];
  const b = best(t, songs.map((x) => ({ id: x.id, title: x.name, artist: (x.artists || x.ar || []).map((a) => a.name).join(', '), duration: (x.duration || x.dt || 0) / 1000 })));
  if (!b) return null;
  const id = b.c.id;
  const [l, v1] = await Promise.all([
    getJson(`https://music.163.com/api/song/lyric?id=${id}&lv=-1&kv=-1&tv=-1`, NE_H),
    getJson(`https://music.163.com/api/song/lyric/v1?id=${id}&cp=false&lv=0&tv=0&rv=0&kv=0&yv=0&ytv=0&yrv=0`, NE_H).catch(() => null),
  ]);
  const lrc = neteaseLrc(l && l.lrc && l.lrc.lyric);
  const yrc = v1 && v1.yrc && v1.yrc.lyric ? yrcToLrc(v1.yrc.lyric) : '';
  if (l && (l.nolyric || /纯音乐，请欣赏|純音樂/.test(lrc))) return { ...b.c, instrumental: true, synced: '', plain: '' };
  const synced = yrc || (/\[\d{1,3}:\d{1,2}/.test(lrc) ? lrc : '');
  if (!synced && !lrc) return null;
  return { ...b.c, synced, plain: synced ? '' : lrc, words: !!yrc };
}

// ---------------------------------------------------------------- QQ Music
const QQ_H = { Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com' };
async function qq(t) {
  const artist = firstArtist(t.artist || t.albumArtist), title = cleanTitle(t.title) || t.title;
  const j = await getJson(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${enc(artist + ' ' + title)}&format=json&p=1&n=15&cr=1&new_json=1&t=0&inCharset=utf8&outCharset=utf-8`, QQ_H);
  const list = (j && j.data && j.data.song && j.data.song.list) || [];
  const b = best(t, list.map((x) => ({ mid: x.mid || x.songmid, title: x.name || x.songname || x.title, artist: (x.singer || []).map((s) => s.name).join(', '), duration: x.interval || 0 })).filter((x) => x.mid));
  if (!b) return null;
  const l = await getJson(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${b.c.mid}&format=json&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`, QQ_H);
  if (!l || (l.retcode !== 0 && l.code !== 0) || !l.lyric) return null;
  let text = /^[A-Za-z0-9+/=\s]+$/.test(l.lyric) ? b64utf8(l.lyric) : unent(l.lyric);
  text = text.split(/\r?\n/).filter((x) => !NE_CREDIT.test(x.replace(/^\[[^\]]*\]/, ''))).join('\n');
  if (/此歌曲为没有填词的纯音乐/.test(text)) return { ...b.c, instrumental: true, synced: '', plain: '' };
  const synced = /\[\d{1,3}:\d{1,2}[.:]\d/.test(text) ? text : '';
  return { ...b.c, synced, plain: synced ? '' : text };
}

// ---------------------------------------------------------------- Kugou
async function kugou(t) {
  const artist = firstArtist(t.artist || t.albumArtist), title = cleanTitle(t.title) || t.title, dur = durOf(t);
  const j = await getJson(`https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${enc(artist + ' - ' + title)}${dur ? `&duration=${dur * 1000}` : ''}&hash=`);
  const cands = (j && j.candidates) || [];
  const b = best(t, cands.map((x) => ({ id: x.id, key: x.accesskey, title: x.song, artist: x.singer, duration: (x.duration || 0) / 1000 })));
  if (!b) return null;
  const d = await getJson(`https://lyrics.kugou.com/download?ver=1&client=pc&id=${b.c.id}&accesskey=${b.c.key}&fmt=lrc&charset=utf8`);
  const text = d && d.content ? b64utf8(d.content) : '';
  if (!text) return null;
  const synced = /\[\d{1,3}:\d{1,2}[.:]\d/.test(text) ? text : '';
  return { ...b.c, synced, plain: synced ? '' : text };
}

const IMPL = { lrclib, musixmatch, netease, qq, kugou };
const ORDER = PROVIDERS.map((p) => p.id);
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

/**
 * Ask every enabled provider in parallel. → results sorted best first:
 * [{ src, synced, plain, words, instrumental, title, artist, duration }]
 * Returns early (after a short grace period) once a word-synced or a perfectly matching synced text is in.
 */
export async function searchAll(t, enabled) {
  const ids = ORDER.filter((id) => enabled[id] === true);
  const results = [];
  let settle;
  const early = new Promise((r) => { settle = r; });
  let pending = ids.length;
  const rank = (x) => (x.synced ? 10 : x.instrumental ? 6 : x.plain ? 3 : 0) + (x.words ? 1.5 : 0) + fit(t, x).s - ORDER.indexOf(x.src) * 0.05;
  for (const id of ids) {
    withTimeout(IMPL[id](t).catch((e) => { log('lyrics source failed', id, e); return null; }), 14000).then((r) => {
      if (r && (r.synced || r.plain || r.instrumental)) {
        results.push({ src: id, ...r });
        // a word-synced exact match cannot be beaten: stop waiting for slow providers after a moment
        if (r.synced && r.words && fit(t, r).s > 3.6) setTimeout(() => settle(), 600);
      }
      if (--pending === 0) settle();
    });
  }
  await Promise.race([early, new Promise((r) => setTimeout(r, 16000))]);
  return results.sort((a, b) => rank(b) - rank(a));
}
