/*
 * Gatefold · ml/sound-ui.js — what the sound analysis shows and makes:
 *   · Settings → «Sound analysis (AI)»: turn on (downloads the models once), progress, pause, remove;
 *   · chips on Now Playing: the track's Discogs styles and its strongest moods;
 *   · «Similar tracks»: a playlist of the 50 closest-sounding tracks of the library;
 *   · mood and style playlists (Smart playlist sheet → «By sound»).
 */
import { call, ok, esc, plural } from '../bridge.js';
import { h, icon, toast, router } from '../ui.js';
import { norm, cleanArtist } from '../match.js';
import { settings, setSetting } from '../settings.js';
import { $t } from '../i18n.js';
import * as Sound from './sound.js';
import * as Genres from './genres.js';

export const MOOD_LABEL = () => ({ aggressive: $t('агрессивное'), relaxed: $t('спокойное'), sad: $t('грустное'), happy: $t('радостное'), party: $t('для вечеринки'),
  danceable: $t('танцевальное'), instrumental: $t('инструментальное'), acoustic: $t('акустическое'), electronic: $t('электронное') });
const MB = (b) => (b / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 });
const artistKey = (r) => norm(cleanArtist(r.aa || r.ar || ''));

export function openSettings() { router.go('settings'); setTimeout(() => { const el = document.getElementById('st-sound'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 120); }
function needSound() {
  toast($t('Включите анализ звука в настройках'), { ms: 6000, action: { label: $t('Открыть'), fn: openSettings } });
}

/* ---------------------------------------------------------------- the first-run offer
   The analysis is what sets Gatefold apart, but it is opt-in (it downloads ~30 MB and works the CPU
   for a while), so it is offered once — a quiet card, a while after the start, on a library worth
   analysing, never over a dialog. «Not now» is final; the switch stays in Settings. */
const OFFER = 'gatefold.soundOffer';
export function maybeOffer({ albums = 0 } = {}) {
  try { if (settings.soundAI || localStorage.getItem(OFFER) || albums < 10) return; } catch { return; }
  const tryShow = (left) => {
    if (settings.soundAI) return;
    const busy = document.visibilityState !== 'visible' || document.querySelector('.modal, .sp-veil, .upd-veil.on, .menu, .welcome, .cv.on');
    if (busy) { if (left > 0) setTimeout(() => tryShow(left - 1), 20000); return; }
    show();
  };
  let wait = 45000; try { wait = +localStorage.getItem(OFFER + '.wait') || wait; } catch {}   // the tests shorten it
  setTimeout(() => tryShow(15), wait);
}
function show() {
  try { localStorage.setItem(OFFER, String(Date.now())); } catch {}
  const box = document.getElementById('toasts'); if (!box) return;
  const el = h(`<div class="toast snd-offer" role="dialog" aria-label="${esc($t('Анализ звука'))}">
    <div class="snd-offer-ic">${icon('wave', 20)}</div>
    <div class="snd-offer-body"><b>${$t('Пусть Gatefold послушает вашу музыку')}</b>
      <span>${$t('Нейросеть один раз прослушает медиатеку прямо на компьютере. После этого радио, «Похожие треки» и плейлисты по настроению подбирают музыку по звучанию. Модели ~30 МБ скачиваются один раз, ничего не отправляется.')}</span>
      <div class="snd-offer-act"><button class="btn sm primary" data-a="on">${$t('Включить')}</button><button class="btn sm" data-a="no">${$t('Не сейчас')}</button><button class="btn sm ghost" data-a="more">${$t('Подробнее')}</button></div></div></div>`);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  el.querySelector('[data-a=on]').onclick = () => { close(); setSetting('soundAI', true); toast($t('Анализ звука включён: модели скачиваются, потом медиатека анализируется в фоне'), { ms: 6000, action: { label: $t('Настройки'), fn: openSettings } }); };
  el.querySelector('[data-a=no]').onclick = close;
  el.querySelector('[data-a=more]').onclick = () => { close(); openSettings(); };
  box.appendChild(el);
}

/* ---------------------------------------------------------------- settings
   Kept short on purpose. What the rows mean, for whoever reads the code:
   · the switch downloads the models (≈ 30 MB, once, from this repository's ml-assets branch) and
     analyses every track once, on this computer — nothing is sent anywhere;
   · speed: gentle ≈ ⅛ of a core while you work; normal ¼ (½ when away); fast 1 core; maximum —
     no pauses, up to three networks, on battery too;
   · genres: artist and album genres from MusicBrainz (requests by artist name), ordered by sound;
   · pause: the playing track and the radio are still analysed;
   · the models are by MTG-UPF under CC BY-NC-SA 4.0 (non-commercial) — credited in THIRD_PARTY_NOTICES. */
function statusHtml() {
  const s = Sound.state;
  const bar = (p) => `<span class="snd-bar"><i style="width:${Math.max(2, Math.min(100, p * 100)).toFixed(1)}%"></i></span>`;
  switch (s.phase) {
    case 'off': return '';
    case 'downloading': return $t('Загрузка {0} из {1} МБ', MB(s.dlDone), MB(s.dlTotal || 1)) + bar(s.dlDone / (s.dlTotal || 1));
    case 'loading': return $t('Загрузка…');
    case 'error': return `<span class="sp-bad">${/404|HTTP 4/.test(s.error) ? $t('Модели ещё не опубликованы') : esc(s.error)}</span>`;
    default: {
      const left = Math.max(0, s.total - s.done);
      const eta = left && s.rate ? left / s.rate : 0;
      const etaTxt = eta > 5400 ? $t('≈ {0} ч', Math.round(eta / 3600)) : eta > 90 ? $t('≈ {0} мин', Math.round(eta / 60)) : '';
      let t = !s.total ? '' : !left ? $t('Готово: {0}', s.total.toLocaleString())
        : `${s.done.toLocaleString()} / ${s.total.toLocaleString()}` + (etaTxt ? ' · ' + etaTxt : '');
      if (s.phase === 'paused') t += ' · ' + (s.why === 'battery' ? $t('пауза: батарея') : $t('пауза'));
      return t + (s.total && left ? bar(s.done / s.total) : '');
    }
  }
}
/* the network's cost, for the curious: on the status line's tooltip */
const costTitle = () => { const s = Sound.state; return s.msPerTrack ? `${Math.round(s.msPerTrack)} ms + ${Math.round(s.decodeMs)} ms · ${(s.rate * 60).toFixed(0)}/min${s.workers > 1 ? ' · ×' + s.workers : ''}${s.decodeMode === 'native' ? ' · native' : ''}${s.fake ? ' · test models' : ''}` : ''; };
let wired = false;
function wire() {
  if (wired) return; wired = true;
  Sound.events.addEventListener('change', () => { const el = document.getElementById('sndStatus'); if (el) { el.innerHTML = statusHtml(); el.title = costTitle(); } });
}
/** the settings section (panels.js passes its builders) */
export function settingsSection({ section, group, actions, button, rerender }) {
  wire();
  const on = !!settings.soundAI;
  const row = (label, ctl) => h(`<div class="row"><div class="lbl"><b>${label}</b></div>${ctl}</div>`);
  const sw = h(`<div class="row"><div class="lbl"><b>${$t('Анализ звука')}</b><small id="sndStatus" class="snd-status" title="${costTitle()}">${on ? statusHtml() : ''}</small></div><label class="toggle"><input type="checkbox"><i></i></label></div>`);
  const inp = sw.querySelector('input'); inp.checked = on;
  inp.onchange = async () => { if (inp.checked) { Sound.enable(); } else Sound.disable(); setTimeout(rerender, 30); };
  const SP = [['gentle', $t('Бережно')], ['normal', $t('Обычно')], ['fast', $t('Быстро')], ['max', $t('Максимум')]];
  const cur = settings.soundSpeed || 'normal';
  const speedRow = row($t('Скорость'), '<div class="seg"></div>');
  for (const [v, txt] of SP) {
    const b = h(`<button${v === cur ? ' class="on"' : ''}>${txt}</button>`);
    b.onclick = () => { speedRow.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); Sound.setSpeed(v); };
    speedRow.querySelector('.seg').append(b);
  }
  const gen = row($t('Жанры из MusicBrainz'), '<label class="toggle"><input type="checkbox"><i></i></label>');
  const gin = gen.querySelector('input'); gin.checked = settings.soundGenresOnline !== false; gin.onchange = () => { setSetting('soundGenresOnline', gin.checked); if (gin.checked) Genres.start(); };
  const pause = row($t('Пауза'), '<label class="toggle"><input type="checkbox"><i></i></label>');
  const pin = pause.querySelector('input'); pin.checked = !!settings.soundPaused; pin.onchange = () => Sound.pause(pin.checked);
  section('sound', 'sparkle', $t('Анализ звука (ИИ)'), '',
    group('', sw, ...(on ? [speedRow, gen, pause, actions(
      button($t('{0}Пересканировать', icon('refresh')), () => { Sound.rescan(); toast($t('Ищу новые треки')); }),
      button($t('Удалить данные'), async () => { await Sound.removeAll(); rerender(); toast($t('Данные анализа удалены')); }, 'danger'))] : [])));
}

/* ---------------------------------------------------------------- Now Playing chips */
export function chips(t) {
  if (!t || !settings.soundAI) return '';
  const r = Sound.get(t);
  const L = MOOD_LABEL();
  const SRC = { tag: $t('Ваш тег'), musicbrainz: 'MusicBrainz', sound: $t('По похожим исполнителям'), network: $t('Нейросеть') };
  const raw = r ? Sound.topStyles(r, 6, 0.05).map((s) => `${s.name} ${Math.round(s.p * 100)}%`).join(' · ') : '';
  const st = Genres.describe(t, r, 2).map((g) => `<span class="chip ai" title="${esc(SRC[g.src])}${raw ? '&#10;' + esc($t('Сеть: {0}', raw)) : ''}">${esc(g.name)}</span>`);
  if (!r) return st.join('');
  // a mood is named only when it is clear and its opposite is not heard too (the same idea as the
  // gates of the mood playlists below)
  const OPP = { sad: ['happy', 'party'], happy: ['sad'], relaxed: ['aggressive', 'party'], aggressive: ['relaxed'], party: ['sad', 'relaxed'], danceable: [], acoustic: ['electronic'], electronic: ['acoustic'] };
  const md = Sound.moodNames().filter((n) => Sound.hasMood(n) && n !== 'instrumental').map((n) => [n, Sound.mood(r, n)])
    .filter(([n, v]) => v >= 0.7 && (OPP[n] || []).every((o) => Sound.mood(r, o) <= 0.4))
    .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n, v]) => `<span class="chip ai" title="${Math.round(v * 100)}%">${esc(L[n])}</span>`);
  return [...st, ...md].join('');
}

/* ---------------------------------------------------------------- playlists */
async function makePlaylist(name, recs) {
  const c = await call('playlist.create', { name });
  if (!ok(c)) { toast($t('Не удалось создать плейлист')); return null; }
  for (let i = 0; i < recs.length; i += 200) await call('playlist.addHandles', { playlistGuid: c.guid, handles: recs.slice(i, i + 200).map(Sound.handleOfRec) });
  await call('playlist.setActive', { playlistGuid: c.guid });
  router.go('playlist', c.guid);
  return c.guid;
}
/** variety: at most `cap` tracks per artist, no title twice */
function vary(list, n, cap = 3, seen = new Set(), albumCap = 2) {
  const per = new Map(), perAlb = new Map(), out = [];
  for (const r of list) {
    const a = artistKey(r), dup = a + '|' + norm(r.ti || ''), al = a + '|' + norm(r.al || '');
    if ((per.get(a) || 0) >= cap || (perAlb.get(al) || 0) >= albumCap || seen.has(dup)) continue;
    per.set(a, (per.get(a) || 0) + 1); perAlb.set(al, (perAlb.get(al) || 0) + 1); seen.add(dup); out.push(r);
    if (out.length >= n) break;
  }
  return out;
}
const coverage = () => { const s = Sound.state; return s.total ? s.done / s.total : 1; };
const coverNote = () => '';   // (the selection improves as the analysis covers more of the library)

/** «Similar tracks»: the closest-sounding 50 tracks of the library */
export async function similar(t) {
  if (!Sound.ready()) return needSound();
  const r = Sound.get(t) || (toast($t('Слушаю трек…'), { ms: 2500 }), await Sound.analyzeNow(t, 20000));
  if (!r) { toast($t('Не удалось проанализировать этот трек')); return; }
  const T = Sound.target(r);
  const all = Sound.nearest(T, 600, (x) => x.k !== r.k);
  // only what really sounds close: a small library should give a short playlist, not a padded one
  const d10 = all.length ? all[Math.min(9, all.length - 1)].d : 0;
  const near = all.filter((x) => x.d <= Math.max(0.35, d10 * 1.8 + 0.1)).map((x) => x.r);
  const list = [r, ...vary(near, 49, 3, new Set([artistKey(r) + '|' + norm(r.ti || '')]))];
  if (list.length < 2) { toast($t('Пока не с чем сравнить')); return; }
  await makePlaylist($t('Похоже на «{0}»', t.title || r.ti), list);
  
}

/* «Sounds like» on the album page: the albums of other artists in the library whose tracks sound
   closest to this album (its songs averaged into one sound). An album's distance is the mean of its
   three closest songs, so an intro or a bonus remix does not decide it. */
const albumKeyR = (r) => artistKey(r) + '|' + norm(r.al || '');
let albCache = { n: -1, groups: null, res: new Map() };
function albumGroups() {
  const n = Sound.count();
  if (albCache.groups && albCache.n === n) return albCache.groups;
  const groups = new Map();
  for (const r of Sound.all()) { if (!r.al) continue; const k = albumKeyR(r); let g = groups.get(k); if (!g) groups.set(k, (g = [])); g.push(r); }
  albCache = { n, groups, res: new Map() };
  return groups;
}
export function similarAlbums(a, n = 8) {
  if (!a || !Sound.ready()) return [];
  const groups = albumGroups();
  const key = norm(cleanArtist(a.albumArtist || a.artist || '')) + '|' + norm(a.name || '');
  if (albCache.res.has(key)) return albCache.res.get(key);
  const own = groups.get(key);
  if (!own || !own.length) return [];
  const songs = own.filter(isSong).length >= 2 ? own.filter(isSong) : own;
  let T = null; songs.forEach((r, i) => { T = Sound.blend(T, r, 1 / (i + 1)); });
  const ownArtist = artistKey(own[0]), scored = [];
  for (const [k, list] of groups) {
    if (k === key || artistKey(list[0]) === ownArtist) continue;
    const ds = (list.filter(isSong).length ? list.filter(isSong) : list).map((r) => Sound.distance(T, r)).sort((x, y) => x - y);
    const top = ds.slice(0, 3);
    scored.push({ d: top.reduce((s, v) => s + v, 0) / top.length, r: list[0] });
  }
  scored.sort((x, y) => x.d - y.d);
  // only what really sounds close: a small library gives a short row, not a padded one
  const lim = Math.max(0.45, (scored[0] ? scored[0].d : 0) * 1.6 + 0.12);
  const res = scored.slice(0, n).filter((x) => x.d <= lim).map((x) => ({ name: x.r.al, albumArtist: x.r.aa || x.r.ar, path: x.r.p, d: x.d }));
  albCache.res.set(key, res);
  return res;
}

/* mood and style recipes for the smart-playlist sheet */
/* a mood playlist is made of songs: intros, interludes, outros and other short pieces are quiet
   and atmospheric, so they would otherwise fill «Calm» */
const BRIDGE = /\b(intro|introduction|interlude|outro|prelude|overture|skit|reprise|segue|intermezzo|interval|coda|hidden track|интро|вступление|интерлюдия|аутро|увертюра)\b|^(intro|outro)\s*[-–:]/i;
export const isSong = (r) => !BRIDGE.test(r.ti || '') && (!(r.du > 0) || r.du >= 140);
/* Each mood playlist: a gate (hard limits — a track that fails one is not that mood, however it
   ranks) and a score that orders the ones inside. The heads are binary classifiers whose outputs
   are averaged over the patches of a track (sound.js); the gates keep them away from the
   middle, where they are guesses: Essentia's mood models are 87–98 % accurate on clear cases and
   say ~0.5 for distorted guitars and dense electronics, whatever is sung over them. */
const m = (r, n) => Sound.mood(r, n), share = (r, n) => Sound.moodShare(r, n);
/* «(Instrumental)», «Instrumental version», «инструментал» in the title */
const INSTR_TITLE = /\binstrumental\b|\binst\.?\)|\boff ?vocal\b|\bkaraoke\b|инструментал|минус(?:овка)?\b/i;
/** no voice in it: the voice must win (almost) no patch, not merely lose on average — a song with
    a long solo averages «half instrumental». Records made before the share was kept need a
    clearer average (they are re-analysed in the background, sound.js). */
export function instrumental(r, vocalArtist = false) {
  if (INSTR_TITLE.test(r.ti || '')) return true;
  const s = share(r, 'instrumental'), v = m(r, 'instrumental');
  // a band that sings on (nearly) everything else needs a clearer case: one odd track is more
  // likely a voice the network missed than an instrumental
  if (vocalArtist) return s == null ? v >= 0.95 : s >= 0.97 && v >= 0.9;
  return s == null ? v >= 0.88 : s >= 0.88 && v >= 0.8;
}
/** artists whose analysed tracks are mostly sung (median «instrumental» under 0.4, four tracks or more) */
function vocalArtists(list) {
  const by = new Map();
  for (const r of list) { const k = (r.aa || r.ar || '').toLowerCase(); if (!k) continue; (by.get(k) || by.set(k, []).get(k)).push(m(r, 'instrumental')); }
  const out = new Set();
  for (const [k, v] of by) if (v.length >= 4) { v.sort((a, b) => a - b); if (v[v.length >> 1] < 0.4) out.add(k); }
  return out;
}
const RECIPE = {
  // calm with a voice: «Calm» means ballads and quiet songs, not ambient pieces (those are in «Instrumental»)
  calm: { gate: (r) => m(r, 'relaxed') >= 0.65 && m(r, 'aggressive') <= 0.25 && m(r, 'party') <= 0.5 && m(r, 'danceable') <= 0.75,
    score: (r) => m(r, 'relaxed') - 0.6 * m(r, 'aggressive') - 0.3 * m(r, 'party') - 0.15 * m(r, 'instrumental') },
  energy: { gate: (r) => (m(r, 'aggressive') >= 0.6 || (m(r, 'party') >= 0.65 && m(r, 'danceable') >= 0.6)) && m(r, 'relaxed') <= 0.4,
    score: (r) => 0.6 * m(r, 'aggressive') + 0.3 * m(r, 'party') + 0.2 * m(r, 'danceable') - 0.3 * m(r, 'relaxed') },
  sad: { gate: (r) => m(r, 'sad') >= 0.65 && m(r, 'happy') <= 0.35 && m(r, 'party') <= 0.35 && m(r, 'aggressive') <= 0.6,
    score: (r) => m(r, 'sad') - 0.5 * m(r, 'happy') },
  happy: { gate: (r) => m(r, 'happy') >= 0.6 && m(r, 'sad') <= 0.4 && m(r, 'aggressive') <= 0.5,
    score: (r) => m(r, 'happy') - 0.5 * m(r, 'sad') },
  party: { gate: (r) => m(r, 'party') >= 0.65 && m(r, 'danceable') >= 0.65 && m(r, 'sad') <= 0.5 && m(r, 'relaxed') <= 0.6,
    score: (r) => 0.6 * m(r, 'party') + 0.5 * m(r, 'danceable') },
  instrumental: { gate: (r, ctx) => instrumental(r, ctx.vocal.has((r.aa || r.ar || '').toLowerCase())), score: (r) => m(r, 'instrumental') + (share(r, 'instrumental') ?? 0) },
  acoustic: { gate: (r) => m(r, 'acoustic') >= 0.75 && m(r, 'electronic') <= 0.25 && (share(r, 'acoustic') ?? 1) >= 0.7,
    score: (r) => m(r, 'acoustic') - 0.3 * m(r, 'electronic') },
};
export const MOOD_RECIPES = () => [
  ['calm', $t('Спокойное'), ''], ['energy', $t('Энергичное'), ''], ['sad', $t('Грустное'), ''], ['happy', $t('Радостное'), ''],
  ['party', $t('Для вечеринки'), ''], ['instrumental', $t('Инструментальное'), ''], ['acoustic', $t('Акустическое'), ''],
];
function ranked(kind, style) {
  const list = Sound.all();
  if (kind === 'style') return list.filter(isSong).map((r) => ({ r, d: Genres.describe(null, r, 3, { neighbours: false }).find((x) => x.name === style) })).filter((x) => x.d).sort((a, b) => b.d.w - a.d.w).map((x) => x.r);
  const R = RECIPE[kind]; if (!R) return [];
  // instrumental pieces may be shorter than songs, but album intros and interludes still stay out
  const keep = kind === 'instrumental' ? (r) => !BRIDGE.test(r.ti || '') && (!(r.du > 0) || r.du >= 90) : isSong;
  const ctx = { vocal: kind === 'instrumental' ? vocalArtists(list) : new Set() };
  return list.filter((r) => keep(r) && R.gate(r, ctx)).map((r) => ({ r, s: R.score(r) })).sort((a, b) => b.s - a.s).map((x) => x.r);
}
export const countFor = (kind, style) => (Sound.ready() ? ranked(kind, style).length : 0);
/** what the recipe picks right now (best first): the count and a few examples for the smart-playlist sheet */
export function matching(kind, style) {
  if (!Sound.ready()) return { n: 0, top: [] };
  const list = ranked(kind, style);
  return { n: list.length, top: vary(list, 6, 1).map((r) => ({ artist: r.aa || r.ar || '', title: r.ti || '' })) };
}
export async function moodPlaylist(kind, name, n = 50, style = '') {
  if (!Sound.ready()) return needSound();
  const list = vary(ranked(kind, style), n, 4);
  if (!list.length) { toast($t('Пока ничего не подходит') + coverNote(), { ms: 6000 }); return; }
  // a little shuffle within the best ones so that the same playlist is not made twice
  for (let i = list.length - 1; i > 0; i--) { const j = Math.max(0, i - 6 + Math.floor(Math.random() * 7)); [list[i], list[j]] = [list[j], list[i]]; }
  await makePlaylist(name, list);
  
}

/** the genres of the analysed library: [{ name, n }] (tracks whose first two genres include it) */
export function libraryGenres() {
  const cnt = new Map();
  for (const r of Sound.all()) for (const g of Genres.describe(null, r, 2, { neighbours: false })) cnt.set(g.name, (cnt.get(g.name) || 0) + 1);
  return [...cnt].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
}
