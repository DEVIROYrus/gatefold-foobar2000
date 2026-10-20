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
  toast($t('Нужен анализ звука нейросетью — включите его в настройках'), { ms: 7000, action: { label: $t('Открыть'), fn: openSettings } });
}

/* ---------------------------------------------------------------- settings */
function statusHtml() {
  const s = Sound.state;
  const bar = (p) => `<span class="snd-bar"><i style="width:${Math.max(2, Math.min(100, p * 100)).toFixed(1)}%"></i></span>`;
  switch (s.phase) {
    case 'off': return $t('Выключено');
    case 'downloading': return $t('Скачиваю модели… {0} из {1} МБ', MB(s.dlDone), MB(s.dlTotal || 1)) + bar(s.dlDone / (s.dlTotal || 1));
    case 'loading': return $t('Загружаю нейросеть…');
    case 'error': return `<span class="sp-bad">${$t('Не получилось: {0}', esc(s.error))}</span>` + (/404|HTTP 4/.test(s.error) ? `<br>${$t('Модели ещё не опубликованы в репозитории Gatefold — попробуйте позже')}` : '');
    default: {
      const left = Math.max(0, s.total - s.done);
      const eta = left && s.rate ? left / s.rate : 0;
      const etaTxt = eta > 5400 ? $t('≈ {0} ч', Math.round(eta / 3600)) : eta > 90 ? $t('≈ {0} мин', Math.round(eta / 60)) : '';
      let t = !s.total ? $t('Ищу треки медиатеки…')
        : !left ? $t('Вся медиатека проанализирована: {0} {1}', s.total.toLocaleString(), plural(s.total, 'трек', 'трека', 'треков'))
          : $t('Проанализировано {0} из {1}', s.done.toLocaleString(), s.total.toLocaleString()) + (etaTxt ? ' · ' + $t('осталось {0}', etaTxt) : '');
      if (s.phase === 'paused') t += ' · ' + (s.why === 'battery' ? $t('пауза: компьютер работает от батареи') : $t('на паузе'));
      if (s.msPerTrack) t += `<br><span class="dim">${$t('На трек: нейросеть {0} мс, чтение файла foobar2000 {1} мс', Math.round(s.msPerTrack), Math.round(s.decodeMs))}${s.rate ? ' · ' + $t('{0} треков в минуту', (s.rate * 60).toFixed(s.rate * 60 < 10 ? 1 : 0)) : ''}${s.workers > 1 ? ' · ' + $t('нейросетей: {0}', s.workers) : ''}${s.decodeMode === 'native' ? ' · ' + $t('пересчёт частоты в Gatefold') : ''}${s.fake ? ' · ' + $t('тестовые модели') : ''}</span>`;
      return t + (s.total && left ? bar(s.done / s.total) : '');
    }
  }
}
function genresHtml() {
  const g = Genres.state;
  return $t('Жанр — это то, что о музыке говорят люди: сеть хорошо слышит звучание, но путает поджанры. Gatefold берёт жанры исполнителей и альбомов из MusicBrainz (запросы по имени исполнителя) и упорядочивает их по звучанию трека')
    + (g.artists ? '<br><span class="dim">' + $t('Исполнителей уточнено: {0} из {1}', g.done, g.artists) + '</span>' : '');
}
let wired = false;
function wire() {
  if (wired) return; wired = true;
  Genres.events.addEventListener('change', () => { const el = document.getElementById('sndGenres'); if (el) el.innerHTML = genresHtml(); });
  Sound.events.addEventListener('change', () => { const el = document.getElementById('sndStatus'); if (el) el.innerHTML = statusHtml(); });
}
/** the settings section (panels.js passes its builders) */
export function settingsSection({ section, group, actions, button, rerender }) {
  wire();
  const on = !!settings.soundAI;
  const sw = h(`<div class="row"><div class="lbl"><b>${$t('Слушать медиатеку нейросетью')}</b><small>${$t('Каждый трек анализируется один раз: стиль, настроение, энергия и «отпечаток» звучания. Радио подбирает треки по звуку, появляются «Похожие треки» и плейлисты по настроению')}</small></div><label class="toggle"><input type="checkbox"><i></i></label></div>`);
  const inp = sw.querySelector('input'); inp.checked = on;
  inp.onchange = async () => { if (inp.checked) { Sound.enable(); } else Sound.disable(); setTimeout(rerender, 30); };
  const status = h(`<div class="row"><div class="lbl"><b>${$t('Состояние')}</b><small id="sndStatus" class="snd-status">${statusHtml()}</small></div></div>`);
  const SP = [['gentle', $t('Бережно')], ['normal', $t('Обычно')], ['fast', $t('Быстро')], ['max', $t('Максимум')]];
  const HINT = { gentle: $t('Почти незаметно: ⅛ ядра, пока вы работаете'), normal: $t('Четверть одного ядра, пока вы за компьютером, половина — когда вас нет'),
    fast: $t('Одно ядро, пока вы за компьютером; без пауз, когда вас нет'), max: $t('Без пауз, до трёх нейросетей сразу и на батарее тоже — вентилятор может зашуметь. Для того, чтобы проанализировать всё за один вечер') };
  const cur = settings.soundSpeed || 'normal';
  const speedRow = h(`<div class="row"><div class="lbl"><b>${$t('Скорость анализа')}</b><small class="snd-hint">${HINT[cur]}</small></div><div class="seg"></div></div>`);
  for (const [v, txt] of SP) {
    const b = h(`<button${v === cur ? ' class="on"' : ''}>${txt}</button>`);
    b.onclick = () => { speedRow.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); speedRow.querySelector('.snd-hint').textContent = HINT[v]; Sound.setSpeed(v); };
    speedRow.querySelector('.seg').append(b);
  }
  const gen = h(`<div class="row"><div class="lbl"><b>${$t('Жанры из MusicBrainz')}</b><small id="sndGenres">${genresHtml()}</small></div><label class="toggle"><input type="checkbox"><i></i></label></div>`);
  const gin = gen.querySelector('input'); gin.checked = settings.soundGenresOnline !== false; gin.onchange = () => { setSetting('soundGenresOnline', gin.checked); if (gin.checked) Genres.start(); };
  const pause = h(`<div class="row"><div class="lbl"><b>${$t('Пауза')}</b><small>${$t('Анализ остановится; играющий трек и радио всё равно анализируются')}</small></div><label class="toggle"><input type="checkbox"><i></i></label></div>`);
  const pin = pause.querySelector('input'); pin.checked = !!settings.soundPaused; pin.onchange = () => Sound.pause(pin.checked);
  const note = h(`<div class="row st-note"><small>${$t('Работает полностью на вашем компьютере, ничего не отправляется. Нагрузка — не больше четверти одного ядра процессора, пока вы за компьютером, и половины, когда вас нет; на батарее анализ ждёт. Модели (≈ 30 МБ) скачиваются один раз из репозитория Gatefold на GitHub.')}<br>${$t('Нейросеть Discogs-EffNet и классификаторы — Music Technology Group, Университет Помпеу Фабра (Essentia). Лицензия CC BY-NC-SA 4.0: только некоммерческое использование.')}</small></div>`);
  section('sound', 'sparkle', $t('Анализ звука (ИИ)'), $t('Радио и подборки по тому, как музыка звучит, а не по тегам'),
    group('', sw, ...(on ? [status, speedRow, gen, pause] : []), note,
      ...(on ? [actions(
        button($t('{0}Пересканировать медиатеку', icon('refresh')), () => { Sound.rescan(); toast($t('Ищу новые треки')); }),
        button($t('Удалить модели и результаты'), async () => { await Sound.removeAll(); rerender(); toast($t('Модели и результаты анализа удалены')); }, 'danger'))] : [])));
}

/* ---------------------------------------------------------------- Now Playing chips */
export function chips(t) {
  if (!t || !settings.soundAI) return '';
  const r = Sound.get(t);
  const L = MOOD_LABEL();
  const SRC = { tag: $t('Из вашего тега жанра'), musicbrainz: $t('Жанр по MusicBrainz — голоса его редакторов; порядок — по звучанию этого трека'),
    sound: $t('У MusicBrainz нет этого исполнителя: жанры тех, кто звучит похоже'), network: $t('Стиль по звучанию (Discogs), с учётом альбома и вашей медиатеки') };
  const raw = r ? Sound.topStyles(r, 6, 0.05).map((s) => `${s.name} ${Math.round(s.p * 100)}%`).join(' · ') : '';
  const st = Genres.describe(t, r, 2).map((g) => `<span class="chip ai" title="${esc(SRC[g.src])}${raw ? '&#10;' + esc($t('Сеть слышит: {0}', raw)) : ''}">${esc(g.name)}</span>`);
  if (!r) return st.join('');
  const md = Sound.moodNames().filter((n) => Sound.hasMood(n) && n !== 'instrumental').map((n) => [n, Sound.mood(r, n)]).filter(([, v]) => v >= 0.65)
    .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n, v]) => `<span class="chip ai" title="${$t('Настроение по звучанию')} · ${Math.round(v * 100)}%">${esc(L[n])}</span>`);
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
const coverNote = () => (coverage() < 0.9 ? ' ' + $t('Проанализировано {0}% медиатеки — подборки станут точнее, когда анализ закончится', Math.round(coverage() * 100)) : '');

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
  if (list.length < 2) { toast($t('Пока не с чем сравнивать — анализ медиатеки ещё идёт')); return; }
  await makePlaylist($t('Похоже на «{0}»', t.title || r.ti), list);
  toast($t('Похожих по звучанию: {0}', list.length - 1) + coverNote(), { ms: 6000 });
}

/* mood and style recipes for the smart-playlist sheet */
/* a mood playlist is made of songs: intros, interludes, outros and other short pieces are quiet
   and atmospheric, so they would otherwise fill «Calm» */
const BRIDGE = /\b(intro|introduction|interlude|outro|prelude|overture|skit|reprise|segue|intermezzo|interval|coda|hidden track|интро|вступление|интерлюдия|аутро|увертюра)\b|^(intro|outro)\s*[-–:]/i;
export const isSong = (r) => !BRIDGE.test(r.ti || '') && (!(r.du > 0) || r.du >= 140);
const SCORE = {
  // calm with a voice: «Calm» means ballads and quiet songs, not ambient pieces (those are in «Instrumental»)
  calm: (r) => Sound.mood(r, 'relaxed') - 0.6 * Sound.mood(r, 'aggressive') - 0.15 * Sound.mood(r, 'instrumental'),
  energy: (r) => 0.6 * Sound.mood(r, 'aggressive') + 0.3 * Sound.mood(r, 'party') + 0.2 * Sound.mood(r, 'danceable') - 0.3 * Sound.mood(r, 'relaxed'),
  sad: (r) => Sound.mood(r, 'sad') - 0.5 * Sound.mood(r, 'happy'),
  happy: (r) => Sound.mood(r, 'happy') - 0.5 * Sound.mood(r, 'sad'),
  party: (r) => 0.6 * Sound.mood(r, 'party') + 0.5 * Sound.mood(r, 'danceable'),
  instrumental: (r) => Sound.mood(r, 'instrumental'),
  acoustic: (r) => Sound.mood(r, 'acoustic') - 0.3 * Sound.mood(r, 'electronic'),
};
export const MOOD_RECIPES = () => [
  ['calm', $t('Спокойное'), $t('Расслабленное, без агрессии')], ['energy', $t('Энергичное'), $t('Громкое, быстрое, напористое')],
  ['sad', $t('Грустное'), $t('Меланхолия по звучанию')], ['happy', $t('Радостное'), $t('Светлое и весёлое')],
  ['party', $t('Для вечеринки'), $t('Танцевальное и заводное')], ['instrumental', $t('Инструментальное'), $t('Без вокала')],
  ['acoustic', $t('Акустическое'), $t('Живые инструменты, без электроники')],
];
function ranked(kind, style) {
  const list = Sound.all();
  if (kind === 'style') return list.filter(isSong).map((r) => ({ r, d: Genres.describe(null, r, 3, { neighbours: false }).find((x) => x.name === style) })).filter((x) => x.d).sort((a, b) => b.d.w - a.d.w).map((x) => x.r);
  const f = SCORE[kind]; if (!f) return [];
  return list.filter(isSong).map((r) => ({ r, s: f(r) })).filter((x) => x.s >= 0.35).sort((a, b) => b.s - a.s).map((x) => x.r);
}
export const countFor = (kind, style) => (Sound.ready() ? ranked(kind, style).length : 0);
export async function moodPlaylist(kind, name, n = 50, style = '') {
  if (!Sound.ready()) return needSound();
  const list = vary(ranked(kind, style), n, 4);
  if (!list.length) { toast($t('Пока ничего не подходит') + coverNote(), { ms: 6000 }); return; }
  // a little shuffle within the best ones so that the same playlist is not made twice
  for (let i = list.length - 1; i > 0; i--) { const j = Math.max(0, i - 6 + Math.floor(Math.random() * 7)); [list[i], list[j]] = [list[j], list[i]]; }
  await makePlaylist(name, list);
  toast($t('Плейлист «{0}»: {1} {2}', esc(name), list.length, plural(list.length, 'трек', 'трека', 'треков')) + coverNote(), { ms: 6000 });
}

/** the genres of the analysed library: [{ name, n }] (tracks whose first two genres include it) */
export function libraryGenres() {
  const cnt = new Map();
  for (const r of Sound.all()) for (const g of Genres.describe(null, r, 2, { neighbours: false })) cnt.set(g.name, (cnt.get(g.name) || 0) + 1);
  return [...cnt].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
}
