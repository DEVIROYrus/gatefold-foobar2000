/* Gatefold · fun/achievements.js — achievements and the trophy room. Silent; never interrupts playback. */
import * as App from '../app.js';
import { store, now, html, esc, router, emit, isEnabled, runtime } from './core.js';
import { modal } from './kit.js';

import { $t, locale } from '../i18n.js';
const day = () => new Date().toDateString();
const LOSSLESS = /flac|alac|wav|ape|wavpack|tak|aiff|pcm|dsd|dsf|dff/i;
const SHUFFLE = new Set([3, 4, 5, 6]);

// [id, icon, title, condition, punchline, hidden]
export const ACH = [
  ['first', '▶️', $t('Поехали'), $t('Первый трек с включённым режимом'), $t('Счётчик запущен. Отступать некуда.')],
  ['night', '🌙', $t('Час волка'), $t('Музыка в 3 часа ночи'), $t('Утром это будет называться «просто не спалось».')],
  ['lark', '🌅', $t('Ранняя пташка'), $t('Трек между 5 и 6 утра'), $t('Либо вы рано встали, либо поздно не легли. Засчитано в обоих случаях.')],
  ['polar', '☀️', $t('Полярный день'), $t('В один день — музыка и до 6 утра, и после 23:00'), $t('Сон — это просто пауза, которую вы так и не нажали.')],
  ['stuck', '🔁', $t('Заело'), $t('Один трек 10 раз подряд'), $t('На десятом круге это уже не прослушивание, а отношения.')],
  ['vintage', '📻', $t('Винтаж'), $t('Запись старше 1970 года'), $t('Она старше вашего плеера, компьютера и, вполне возможно, интернета.')],
  ['shellac', '🎙️', $t('Эпоха шеллака'), $t('Запись старше 1950 года'), $t('Где-то внутри этого файла до сих пор потрескивает пластинка.'), true],
  ['hires', '🦇', $t('Слышу разницу'), $t('24 бит и от 176,4 кГц'), $t('Особенно чисто звучат частоты, которых вы не слышите.')],
  ['dumplings', '⏳', $t('Выносливость'), $t('Трек длиннее 20 минут — дослушан до конца'), $t('За это время можно было сварить пельмени. Дважды.')],
  ['feature', '🎬', $t('Полнометражный'), $t('Трек длиннее 40 минут'), $t('Это не трек. Это альбом, который притворяется треком.')],
  ['blitz', '⚡', $t('Блиц'), $t('Трек короче минуты — целиком'), $t('Вступление, куплет, конец. Никакой воды.')],
  ['seeker', '🔎', $t('В поисках той самой'), $t('10 пропусков за минуту'), $t('Она точно в следующем треке. Или через один.')],
  ['reunion', '🧳', $t('Встреча выпускников'), $t('Трек, который не включали больше трёх лет'), $t('Он не обижается. Он просто запомнил.')],
  ['cover2cover', '📖', $t('От корки до корки'), $t('Альбом целиком, с первого трека до последнего, без пропусков'), $t('Как задумывали авторы. Редкий навык, берегите его.')],
  ['nightshow', '🌌', $t('Ночной сеанс'), $t('Альбом целиком между полуночью и пятью утра'), $t('Лучшее время для альбомов: никто не звонит и не спрашивает, что это играет.'), true],
  ['unknown', '🗺️', $t('Терра инкогнита'), $t('10 ни разу не игравших треков за сессию'), $t('Медиатека, оказывается, больше, чем сорок любимых песен.')],
  ['thousand', '🧮', $t('Тысяча'), $t('1000 треков с включённым режимом'), $t('Статистически хотя бы один из них был шедевром.')],
  ['hundred', '💯', $t('Сотня'), $t('Трек, прослушанный 100 раз'), $t('На сотом разе трек начинает слушать вас.')],
  ['neighbors', '📢', $t('Соседи в курсе'), $t('Громкость на 100%'), $t('Теперь ваш вкус знает весь подъезд. Поздравляем с должностью куратора.')],
  ['whisper', '🤫', $t('Шёпотом'), $t('Минута музыки на громкости 5% и тише'), $t('Либо все спят, либо это что-то очень личное.')],
  ['directors', '✂️', $t('Режиссёрская версия'), $t('10 перемоток в одном треке'), $t('Вы явно что-то искали. Надеемся, нашли то самое место.')],
  ['lossless', '💎', $t('Без потерь'), $t('20 lossless-треков за сессию'), $t('Ни один бит не пострадал.')],
  ['dialup', '📟', $t('Привет из 2003-го'), $t('MP3 на 128 кбит/с или меньше'), $t('Звучит как скачанное по модему. Скорее всего, так и было.')],
  ['brickwall', '🧱', $t('Громкость любой ценой'), $t('Трек с DR5 и ниже'), $t('Компрессор работал без выходных. Ему бы в отпуск.')],
  ['breathing', '🌬️', $t('Живой звук'), $t('Трек с DR16 и выше'), $t('Тихие места тут правда тихие. Не крутите громкость: громкие тоже настоящие.')],
  ['omnivore', '🍱', $t('Всеядность'), $t('5 разных жанров подряд'), $t('Рекомендательные алгоритмы сдались и ушли домой.')],
  ['discography', '📚', $t('Это уже дискография'), $t('20 треков одного исполнителя подряд'), $t('Плейлистом это называть уже неловко.')],
  ['saturday', '🛋️', $t('Суббота прошла правильно'), $t('3 часа музыки в субботу'), $t('Продуктивность — ноль, настроение — отличное. Баланс найден.')],
  ['shift', '💼', $t('Рабочая смена'), $t('8 часов музыки за одну сессию'), $t('Если это был фон для работы — вы герой. Если нет — тем более.')],
  ['hundredh', '⏱️', $t('Сто часов'), $t('100 часов музыки с включённым режимом'), $t('Больше четырёх суток без перерыва. Условно, но внушает.')],
  ['patience', '⏸️', $t('Я на минутку'), $t('Пауза дольше часа — и снова воспроизведение'), $t('Музыка ждала терпеливо. В отличие от чая.')],
  ['gazer', '👁️', $t('Созерцатель'), $t('В сумме час на экране «Сейчас играет»'), $t('Обложка уже выучила ваше лицо.')],
  ['chaos', '🎲', $t('Доверие к хаосу'), $t('50 треков подряд в случайном порядке'), $t('Вы отдали контроль случайности. Она справилась не хуже.')],
  ['timetravel', '🕰️', $t('Машина времени'), $t('Музыка из пяти разных десятилетий за сессию'), $t('Хронологию вы не соблюдаете. И правильно делаете.')],
  ['mono', '🔈', $t('Моно'), $t('Трек в моно'), $t('Обе колонки поют одно и то же. Зато дружно.')],
  ['surround', '🔊', $t('Окружение'), $t('Многоканальный трек'), $t('Что-то играет и у вас за спиной. Не оборачивайтесь.')],
  ['onebit', '1️⃣', $t('Однобитный'), $t('DSD-запись'), $t('Всего один бит, но какой.'), true],
  ['novel', '📜', $t('Название-роман'), $t('Трек с названием длиннее 60 символов'), $t('Пока дочитали название, песня закончилась.')],
  ['tagless', '🏷️', $t('Без имени'), $t('Трек без названия или с названием вида «Track 07»'), $t('Кто-то когда-то поленился с тегами. Возможно, вы.')],
  ['taster', '🍷', $t('Дегустатор'), $t('50 разных альбомов за неделю'), $t('Неделя как фестиваль, только без грязи и очередей.')],
  ['fitting', '👔', $t('Примерочная'), $t('Попробовать все три стиля интерфейса'), $t('Музыка подождёт: сначала надо подобрать плееру наряд.')],
  ['muted', '🙊', $t('Музыка для глаз'), $t('10 минут воспроизведения с выключенным звуком'), $t('Смотреть на обложку тоже считается.')],
  ['newyear', '🎆', $t('Первый трек года'), $t('Музыка в первый час 1 января'), $t('Пока все чокались, вы выбирали трек. Приоритеты.'), true],
  ['friday13', '🐈‍⬛', $t('Пятница, 13-е'), $t('Музыка в пятницу 13-го'), $t('Суеверия побеждены. Перемешивание всё равно выбрало что-то странное.'), true],
  ['midnight', '🕛', $t('Ровно в полночь'), $t('Трек начался в 00:00'), $t('Карета не превратилась в тыкву, плеер — в Winamp. Повезло.'), true],
];

// ---------------------------------------------------------------- popup (top-right, ~5 s, no sound, no focus steal)
let queue = [], showing = false;
function popup(a) {
  queue.push(a); if (showing) return;
  const next = () => {
    const x = queue.shift(); if (!x || !isEnabled()) { queue = []; showing = false; return; }
    showing = true;
    const el = html(`<div class="fun-ach" role="status"><div class="ic">${x[1]}</div><div class="tx"><small>${$t('Достижение')}</small><b>${esc(x[2])}</b><span>${esc(x[4])}</span></div></div>`);
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
    setTimeout(() => { el.classList.remove('on'); setTimeout(() => { el.remove(); next(); }, 420); }, 5200);
  };
  next();
}
export function unlock(id) {
  if (!running) return false;
  const st = store('ach', { got: {} });
  if (st.got[id]) return false;
  const a = ACH.find((x) => x[0] === id); if (!a) return false;
  st.got[id] = Date.now(); st.save(); popup(a);
  return true;
}
export const progress = () => { const st = store('ach', { got: {} }); return { got: ACH.filter((a) => st.got[a[0]]).length, total: ACH.length }; };

export function trophyRoom() {
  const st = store('ach', { got: {} });
  const { got, total } = progress();
  const order = [...ACH].sort((a, b) => (st.got[b[0]] ? 1 : 0) - (st.got[a[0]] ? 1 : 0) || (st.got[b[0]] || 0) - (st.got[a[0]] || 0));
  const body = html(`<div class="fun-trophies">
    <div class="sum">${$t('<b>{0}</b> из {1}', got, total)}<div class="bar"><i style="width:${(got / total * 100).toFixed(1)}%"></i></div></div>
    <div class="grid">${order.map((a) => {
      const g = st.got[a[0]], hidden = a[5] && !g;
      return `<div class="tr ${g ? 'got' : ''} ${hidden ? 'secret' : ''}"><div class="ic">${hidden ? '?' : a[1]}</div><div class="tx"><b>${hidden ? $t('Скрытое') : esc(a[2])}</b>
        <span>${hidden ? $t('Условие откроется вместе с достижением') : esc(a[3])}</span>${g ? `<em>${esc(a[4])}</em><i>${new Date(g).toLocaleDateString(locale)}</i>` : ''}</div></div>`;
    }).join('')}</div></div>`);
  modal({ title: $t('Достижения'), body, cls: 'fun-trophy-back', actions: [{ label: $t('Закрыть'), primary: true }] });
}

// ---------------------------------------------------------------- tracking
let rt = null, running = false;
export function start() {
  if (running) return;
  running = true; rt = runtime('ach');
  const c = store('achc', { tracks: 0, sec: 0, stare: 0, perDay: {}, albumsWeek: {}, skins: [] });
  const sess = { fresh: 0, lossless: 0, seeks: 0, genres: [], artists: [], chain: null, quietSec: 0, mutedSec: 0, decades: new Set(), sec: 0, shuffle: 0 };
  rt.sub('ach', (e) => unlock(e.detail.id));
  rt.sub('skin', (e) => { if (!e.detail.id || e.detail.id === 'none' || c.skins.includes(e.detail.id)) return; c.skins.push(e.detail.id); c.save(); if (c.skins.length >= 3) unlock('fitting'); });
  rt.sub('track', (e) => {
    const { t, info: i, prev, initial } = e.detail; if (!i) return;
    const d = new Date(), h = d.getHours(), m = d.getMinutes();
    if (!initial) { c.tracks++; unlock('first'); if (c.tracks >= 1000) unlock('thousand'); }
    if (h === 3) unlock('night');
    if (h === 5) unlock('lark');
    const pd = c.perDay[day()] || (c.perDay[day()] = { early: false, late: false, min: 0 });
    if (h < 6) pd.early = true; if (h >= 23) pd.late = true; if (pd.early && pd.late) unlock('polar');
    if (now.session.sameRun >= 10) unlock('stuck');
    if (i.year && i.year < 1970) unlock('vintage');
    if (i.year && i.year < 1950) unlock('shellac');
    if (i.year) { sess.decades.add(Math.floor(i.year / 10)); if (sess.decades.size >= 5) unlock('timetravel'); }
    if (i.bits >= 24 && i.sr >= 176400) unlock('hires');
    if (/dsd|dsf|dff/i.test(i.codec)) unlock('onebit');
    if (i.channels === 1) unlock('mono');
    if (i.channels > 2) unlock('surround');
    if (i.lastPlayedTs && Date.now() - i.lastPlayedTs > 3 * 365 * 864e5) unlock('reunion');
    if (i.plays === 0 && !initial) { sess.fresh++; if (sess.fresh >= 10) unlock('unknown'); }
    if (i.plays >= 100) unlock('hundred');
    if (LOSSLESS.test(i.codec)) { sess.lossless++; if (sess.lossless >= 20) unlock('lossless'); }
    if (/mp3/i.test(i.codec) && i.bitrate > 0 && i.bitrate <= 128) unlock('dialup');
    if (i.dr > 0 && i.dr <= 5) unlock('brickwall');
    if (i.dr >= 16) unlock('breathing');
    if (i.len > 2400) unlock('feature');
    const title = String(t.title || i.title || '').trim();
    if (title.length > 60) unlock('novel');
    if (!title || /^(track|трек|untitled|без названия)\s*\d*$/i.test(title)) unlock('tagless');
    if (d.getMonth() === 0 && d.getDate() === 1 && h === 0) unlock('newyear');
    if (d.getDay() === 5 && d.getDate() === 13) unlock('friday13');
    if (h === 0 && m === 0 && !initial) unlock('midnight');
    sess.shuffle = SHUFFLE.has(App.player().order) ? sess.shuffle + 1 : 0; if (sess.shuffle >= 50) unlock('chaos');
    sess.genres = [...sess.genres, (i.genre || '').toLowerCase()].slice(-5);
    if (sess.genres.length === 5 && sess.genres.every(Boolean) && new Set(sess.genres).size === 5) unlock('omnivore');
    const art = (t.albumArtist || t.artist || '').toLowerCase();
    sess.artists = [...sess.artists, art].slice(-20);
    if (sess.artists.length === 20 && art && sess.artists.every((x) => x === art)) unlock('discography');
    const wk = Math.floor(Date.now() / (7 * 864e5)); const w = c.albumsWeek[wk] || (c.albumsWeek[wk] = []);
    const ak = art + '\u0001' + (t.album || '').toLowerCase(); if (t.album && !w.includes(ak)) { w.push(ak); if (w.length >= 50) unlock('taster'); }
    for (const k of Object.keys(c.albumsWeek)) if (+k < wk - 1) delete c.albumsWeek[k];
    if (prev && prev.completed) {
      const pl = prev.info?.len || prev.t.duration || 0;
      if (pl > 1200) unlock('dumplings');
      if (pl > 0 && pl < 60) unlock('blitz');
    }
    // whole album in order: track 1 → total, each one played to the end
    const same = sess.chain && sess.chain.album === (t.album || '') && sess.chain.artist === art;
    if (i.no === 1) sess.chain = { album: t.album || '', artist: art, next: 2, total: i.total, startH: h };
    else if (same && prev && prev.completed && i.no === sess.chain.next) sess.chain.next++;
    else sess.chain = null;
    sess.seeks = 0;
    c.save();
  });
  rt.sub('albumDone', () => {
    if (!(sess.chain && sess.chain.total && sess.chain.next - 1 === sess.chain.total)) return;
    unlock('cover2cover');
    const h = new Date().getHours(); if (sess.chain.startH < 5 && h < 5) unlock('nightshow');
  });
  rt.sub('skip', () => { if (now.session.skips.filter((x) => Date.now() - x < 60000).length >= 10) unlock('seeker'); });
  rt.sub('seek', () => { if (++sess.seeks >= 10) unlock('directors'); });
  rt.sub('volume', (e) => { if (Math.round(e.detail.volume ?? 0) >= 100) unlock('neighbors'); });
  let pausedAt = 0;
  rt.sub('state', (e) => {
    if (e.detail.state === 'paused') pausedAt = Date.now();
    else if (e.detail.state === 'playing' && pausedAt && Date.now() - pausedAt > 3600e3) unlock('patience');
    if (e.detail.state !== 'paused') pausedAt = 0;
  });
  rt.every(10000, () => {
    if (router.current === 'now' && document.visibilityState === 'visible') { c.stare += 10; if (c.stare >= 3600) unlock('gazer'); }
  });
  rt.every(60000, () => {
    const p = App.player(); if (p.state !== 'playing') return;
    c.sec += 60; if (c.sec >= 100 * 3600) unlock('hundredh');
    sess.sec += 60; if (sess.sec >= 8 * 3600) unlock('shift');
    const pd = c.perDay[day()] || (c.perDay[day()] = { early: false, late: false, min: 0 }); pd.min++;
    if (new Date().getDay() === 6 && pd.min >= 180) unlock('saturday');
    for (const k of Object.keys(c.perDay)) if (k !== day()) delete c.perDay[k];
    if (p.volume <= 5 && !p.muted && p.volume > 0) { sess.quietSec += 60; if (sess.quietSec >= 60) unlock('whisper'); } else sess.quietSec = 0;
    if (p.muted) { sess.mutedSec += 60; if (sess.mutedSec >= 600) unlock('muted'); } else sess.mutedSec = 0;
    c.save();
  });
}
export function stop() {
  if (!running) return;
  running = false; rt?.dispose(); rt = null;
  queue = []; document.querySelectorAll('.fun-ach').forEach((e) => e.remove());
}
export { emit };
