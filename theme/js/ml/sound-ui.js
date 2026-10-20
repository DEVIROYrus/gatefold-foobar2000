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
import { settings } from '../settings.js';
import { $t } from '../i18n.js';
import * as Sound from './sound.js';

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
      const eta = left && s.wall ? left * s.wall / 1000 : 0;
      const etaTxt = eta > 5400 ? $t('≈ {0} ч', Math.round(eta / 3600)) : eta > 90 ? $t('≈ {0} мин', Math.round(eta / 60)) : '';
      let t = !s.total ? $t('Ищу треки медиатеки…')
        : !left ? $t('Вся медиатека проанализирована: {0} {1}', s.total.toLocaleString(), plural(s.total, 'трек', 'трека', 'треков'))
          : $t('Проанализировано {0} из {1}', s.done.toLocaleString(), s.total.toLocaleString()) + (etaTxt ? ' · ' + $t('осталось {0}', etaTxt) : '');
      if (s.phase === 'paused') t += ' · ' + (s.why === 'battery' ? $t('пауза: компьютер работает от батареи') : $t('на паузе'));
      if (s.msPerTrack) t += `<br><span class="dim">${$t('{0} мс работы нейросети на трек', Math.round(s.msPerTrack))}${s.fake ? ' · ' + $t('тестовые модели') : ''}</span>`;
      return t + (s.total && left ? bar(s.done / s.total) : '');
    }
  }
}
let wired = false;
function wire() {
  if (wired) return; wired = true;
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
  const pause = h(`<div class="row"><div class="lbl"><b>${$t('Пауза')}</b><small>${$t('Анализ остановится; играющий трек и радио всё равно анализируются')}</small></div><label class="toggle"><input type="checkbox"><i></i></label></div>`);
  const pin = pause.querySelector('input'); pin.checked = !!settings.soundPaused; pin.onchange = () => Sound.pause(pin.checked);
  const note = h(`<div class="row st-note"><small>${$t('Работает полностью на вашем компьютере, ничего не отправляется. Нагрузка — не больше четверти одного ядра процессора, пока вы за компьютером, и половины, когда вас нет; на батарее анализ ждёт. Модели (≈ 30 МБ) скачиваются один раз из репозитория Gatefold на GitHub.')}<br>${$t('Нейросеть Discogs-EffNet и классификаторы — Music Technology Group, Университет Помпеу Фабра (Essentia). Лицензия CC BY-NC-SA 4.0: только некоммерческое использование.')}</small></div>`);
  section('sound', 'sparkle', $t('Анализ звука (ИИ)'), $t('Радио и подборки по тому, как музыка звучит, а не по тегам'),
    group('', sw, ...(on ? [status, pause] : []), note,
      ...(on ? [actions(
        button($t('{0}Пересканировать медиатеку', icon('refresh')), () => { Sound.rescan(); toast($t('Ищу новые треки')); }),
        button($t('Удалить модели и результаты'), async () => { await Sound.removeAll(); rerender(); toast($t('Модели и результаты анализа удалены')); }, 'danger'))] : [])));
}

/* ---------------------------------------------------------------- Now Playing chips */
export function chips(t) {
  const r = t && Sound.get(t);
  if (!r) return '';
  const L = MOOD_LABEL();
  const st = Sound.topStyles(r, 2, 0.15).map((s) => `<span class="chip ai" title="${$t('Стиль по звучанию (Discogs)')} · ${Math.round(s.p * 100)}%">${esc(s.name)}</span>`);
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
function vary(list, n, cap = 3, seen = new Set()) {
  const per = new Map(), out = [];
  for (const r of list) {
    const a = artistKey(r), dup = a + '|' + norm(r.ti || '');
    if ((per.get(a) || 0) >= cap || seen.has(dup)) continue;
    per.set(a, (per.get(a) || 0) + 1); seen.add(dup); out.push(r);
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
const SCORE = {
  calm: (r) => Sound.mood(r, 'relaxed') - 0.6 * Sound.mood(r, 'aggressive'),
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
  if (kind === 'style') return list.map((r) => ({ r, s: r.st ? r.st[style] / 255 : 0 })).filter((x) => x.s >= 0.2).sort((a, b) => b.s - a.s).map((x) => x.r);
  const f = SCORE[kind]; if (!f) return [];
  return list.map((r) => ({ r, s: f(r) })).filter((x) => x.s >= 0.35).sort((a, b) => b.s - a.s).map((x) => x.r);
}
export const countFor = (kind, style) => (Sound.ready() ? ranked(kind, style).length : 0);
export async function moodPlaylist(kind, name, n = 50, style = -1) {
  if (!Sound.ready()) return needSound();
  const list = vary(ranked(kind, style), n, 4);
  if (!list.length) { toast($t('Пока ничего не подходит') + coverNote(), { ms: 6000 }); return; }
  // a little shuffle within the best ones so that the same playlist is not made twice
  for (let i = list.length - 1; i > 0; i--) { const j = Math.max(0, i - 6 + Math.floor(Math.random() * 7)); [list[i], list[j]] = [list[j], list[i]]; }
  await makePlaylist(name, list);
  toast($t('Плейлист «{0}»: {1} {2}', esc(name), list.length, plural(list.length, 'трек', 'трека', 'треков')) + coverNote(), { ms: 6000 });
}
