/* Gatefold · panels.js — Settings and Covers screens */
import * as LYS from './lyrics-sources.js';
import { esc, fmtTime, plural } from './bridge.js';
import { settings, setSetting, resetSettings, DEFAULTS } from './settings.js';
import { router, $, h, icon, toast } from './ui.js';
import { current, FIXED } from './theme.js';
import * as CF from './coverfetch.js';
import * as AA from './artistart.js';
import { openFolder as openArtistFolder, loadArtists, artistsState } from './artists.js';
import * as Q from './coverquality.js';
import { artDiag } from './artbytes.js';
import * as Lib from './library.js';
import * as TC from './thumbcache.js';
import * as Canvas from './canvas.js';

import { $t, lang, LANGS } from './i18n.js';
import { VERSION } from './version.js';
import { settingsSection as updatesSection } from './update-ui.js';
import { fb2kGroups } from './fb2kprefs.js';
import * as SoundUI from './ml/sound-ui.js';
import * as LoudUI from './loudness-ui.js';
const CF_pl = (n) => plural(n, 'файл', 'файла', 'файлов');

// ---------------------------------------------------------------- control builders
/* settings rows: a label and a control — no explanatory hints in the interface (the `hint`
   arguments are kept in the calls as comments, for whoever reads the code) */
function toggle(key, label, hint, onChange) {
  const el = h(`<div class="row"><div class="lbl"><b>${label}</b></div><label class="toggle"><input type="checkbox"><i></i></label></div>`);
  const inp = el.querySelector('input');
  inp.checked = !!settings[key];
  inp.onchange = () => { setSetting(key, inp.checked); onChange && onChange(inp.checked); };
  return el;
}
function seg(key, label, hint, options, onChange) {
  const el = h(`<div class="row"><div class="lbl"><b>${label}</b></div><div class="seg"></div></div>`);
  const box = el.querySelector('.seg');
  for (const [val, text] of options) {
    const b = h(`<button>${text}</button>`);
    if (String(settings[key]) === String(val)) b.classList.add('on');
    b.onclick = () => { box.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); setSetting(key, val); onChange && onChange(val); };
    box.appendChild(b);
  }
  return el;
}
function range(key, label, hint, min, max, step, fmt) {
  const el = h(`<div class="row"><div class="lbl"><b>${label} <span class="num" style="color:var(--text-3);font-weight:500"></span></b></div><input class="range" type="range" min="${min}" max="${max}" step="${step}"></div>`);
  const inp = el.querySelector('input'), out = el.querySelector('.num');
  const paint = () => { inp.style.setProperty('--p', ((inp.value - min) / (max - min) * 100) + '%'); out.textContent = fmt(+inp.value); };
  inp.value = settings[key]; paint();
  inp.oninput = () => { paint(); setSetting(key, +inp.value); };
  return el;
}
const card = (title, desc, wide) => h(`<div class="card${wide ? ' wide' : ''}"><h3>${title}</h3>${desc ? `<div class="desc">${desc}</div>` : ''}</div>`);

// ---------------------------------------------------------------- settings
/* Two panes: sections on the left (with search), one readable column of grouped rows on the
   right. No masonry: every group is as tall as its content, nothing leaves holes. */
const ytGet = (k, d) => { try { const v = localStorage.getItem('aurora.yt.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const ytSet = (k, v) => { try { localStorage.setItem('aurora.yt.' + k, JSON.stringify(v)); } catch {} dispatchEvent(new Event('aurora:yt-pref')); };
function lsSeg(label, hint, options, get, set) {
  const el = h(`<div class="row"><div class="lbl"><b>${label}</b></div><div class="seg"></div></div>`);
  const box = el.querySelector('.seg');
  for (const [val, text] of options) {
    const b = h(`<button>${text}</button>`);
    if (String(get()) === String(val)) b.classList.add('on');
    b.onclick = () => { box.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); set(val); };
    box.appendChild(b);
  }
  return el;
}
function lsToggle(label, hint, get, set) {
  const el = h(`<div class="row"><div class="lbl"><b>${label}</b></div><label class="toggle"><input type="checkbox"><i></i></label></div>`);
  const inp = el.querySelector('input'); inp.checked = !!get(); inp.onchange = () => set(inp.checked);
  return el;
}
const group = (title, ...rows) => { const g = h(`<div class="card st-group">${title ? `<div class="st-gt">${title}</div>` : ''}</div>`); g.append(...rows.filter(Boolean)); return g; };
const actions = (...btns) => { const r = h('<div class="row st-acts"></div>'); r.append(...btns); return r; };
const button = (html, fn, cls = '') => { const b = h(`<button class="btn sm ${cls}">${html}</button>`); b.onclick = fn; return b; };
let stSection = '';
/* interface language: applied by reloading the page (i18n.js reads it before anything renders) */
function langRow() {
  const el = h(`<div class="row"><div class="lbl"><b>${$t('Язык')} · Language</b></div><div class="seg"></div></div>`);
  const box = el.querySelector('.seg');
  const cur = settings.language || 'auto';
  for (const [v, txt] of [['auto', $t('Авто')], ...Object.entries(LANGS)]) {
    const b = h(`<button>${txt}</button>`); if (cur === v) b.classList.add('on');
    b.onclick = () => { if (cur === v) return; setSetting('language', v); const target = v === 'auto' ? '' : v; if (target !== lang || v === 'auto') setTimeout(() => location.reload(), 150); else renderSettings(); };
    box.append(b);
  }
  return el;
}

/* Texts that used to explain the settings in the interface (kept for whoever reads the code):
 * · «Авто» — как в Windows. Интерфейс перезагрузится
 * · Из обложки играющего альбома — или постоянная тема, которая не меняется от трека к треку
 * · Доли цветов текущего альбома
 * · Сбросить выбранный вручную вид у всех плейлистов
 * · Коды стран через запятую. RU находит кириллические релизы
 * · 'Источники с пометкой «неофициально» используют закрытые интерфейсы сервисов без их разрешения. Включайте их на свой риск; тексты песен защищены авторским правом и годятся только для личного прослушивания.
 * · ('Бесплатно в Google Cloud Console → YouTube Data API v3 → Credentials → API key. Около 100 поисков в день
 * · Сохранение идёт штатным механизмом foobar2000 (cover.jpg рядом с треками) — его сразу видят все компоненты.
 * · Порядок: iTunes (до 3000 px) → Deezer (1000 px) → MusicBrainz/CAA (1200 px). Лимиты запросов соблюдаются автоматически.
 * · Ищет уже установленные обложки в низком разрешении, сильно пережатые JPEG и не квадратные сканы. Новая картинка ставится автоматически, только если она <b>визуально совпадает</b> с текущей и крупнее; прежняя сохраняется в резервную копию, любую замену можно вернуть.
 * · Совпадение ниже порога автопринятия. Выберите обложку или пропустите альбом.
 * · 'Ещё не проверялось. Проверка идёт в фоне и уступает foobar каждый раз, когда вы работаете с окном, — интерфейс не тормозит. Обычно несколько минут на 2000 альбомов; если обложки читаются «через foobar», дольше.
 */
export function renderSettings() {
  const body = $('settingsBody');
  const scroller = body.parentElement;
  const keepScroll = scroller.scrollTop;
  body.innerHTML = '';
  const secs = [];
  const section = (id, ic, title, sub, ...groups) => {
    const el = h(`<section class="st-sec" id="st-${id}" data-sec="${id}"><header><div class="st-ic">${icon(ic)}</div><div><h3>${title}</h3></div></header></section>`);
    el.append(...groups); secs.push({ id, ic, title, el }); return el;
  };

  // ---- Оформление
  const albumColors = !FIXED[settings.colorSource];
  /* colour source: the playing cover, or one of three calm fixed themes; each card is a tiny live preview */
  const sourcePicker = () => {
    const el = h(`<div class="row st-src"><div class="lbl"><b>${$t('Цвета интерфейса')}</b></div><div class="src-cards" role="radiogroup"></div></div>`);
    const box = el.querySelector('.src-cards');
    const pv = (k) => { const d = FIXED[k]; const c = (v) => `oklch(${v[0] * 100}% ${v[1]} ${v[2]})`; return `--pv-bg:${c(d.bg)};--pv-s:${c(d.surface2)};--pv-t:${c(d.text)};--pv-t3:${c(d.text3)};--pv-a:${c(d.accent)}`; };
    const items = [['album', $t('Из обложки'), ''], ...Object.keys(FIXED).map((k) => [k, FIXED[k].name, pv(k)])];
    for (const [id, name, style] of items) {
      const on = (settings.colorSource || 'album') === id;
      const b = h(`<button class="src-card${on ? ' on' : ''}${id === 'album' ? ' album' : ''}" role="radio" aria-checked="${on}" style="${style}">
        <span class="pv"><i class="pv-side"></i><i class="pv-l1"></i><i class="pv-l2"></i><i class="pv-btn"></i></span><span class="nm">${name}</span></button>`);
      if (id === 'album' && current.palette && !current.palette.fixed) b.style.cssText = `--pv-bg:${current.palette.bg.css};--pv-s:${current.palette.surface2.css};--pv-t:${current.palette.text.css};--pv-t3:${current.palette.text3.css};--pv-a:${current.palette.accent.css}`;
      b.onclick = () => { if (on) return; setSetting('colorSource', id); setTimeout(renderSettings, 60); };
      box.append(b);
    }
    return el;
  };
  const sw = h(`<div class="row"><div class="lbl"><b>${$t('Палитра обложки')}</b></div><div class="swatches"></div></div>`);
  if (current.palette) for (const c of current.palette.swatches) sw.querySelector('.swatches').appendChild(h(`<i style="background:${c.hex}" title="${c.hex} · ${Math.round(c.share * 100)}%"></i>`));
  section('look', 'sparkle', $t('Оформление'), '' /* albumColors ? $t('Интерфейс окрашивается в цвета обложки играющего альбома') : $t('Постоянная тема «{0}» — цвета не зависят от альбома', FIXED[settings.colorSource].name) */,
    group($t('Цвет'),
      sourcePicker(),
      ...(albumColors ? [
        seg('themeMode', $t('Яркость'), '' /* «Авто» — светлая только для светлых обложек */, [['auto', $t('Авто')], ['dark', $t('Тёмная')], ['light', $t('Светлая')]]),
        range('colorIntensity', $t('Насыщенность'), '' /* Насколько сильно цвет альбома окрашивает интерфейс */, 0.4, 1.5, 0.05, (v) => Math.round(v * 100) + '%'),
        range('transitionMs', $t('Смена цветов'), '' /* Плавность перехода к новому альбому */, 200, 2600, 100, (v) => (v / 1000).toFixed(1) + $t(' с')),
        sw] : [])),
    group($t('Текст'),
      seg('fontMode', $t('Шрифт'), '' /* «Гибрид»: Segoe UI для текста, Inter для заголовков */, [['hybrid', $t('Гибрид')], ['system', 'Segoe UI'], ['inter', 'Inter']]),
      seg('baseSize', $t('Размер текста'), '' /* Целые пиксели — буквы ложатся на сетку экрана без размытия. Строки списков растут вместе с текстом */, [13, 14, 15, 16, 17, 18, 19, 20].map((n) => [n, String(n)])),
      toggle('crispText', $t('Максимальная чёткость списков'), '' /* ClearType вместо серого сглаживания */)),
    group($t('Фон и движение'),
      toggle('ambient', $t('Живой фон из обложки'), '' /* Размытая обложка и цветовые пятна */),
      toggle('ambientMotion', $t('Движение фона'), '' /* Медленный дрейф пятен */),
      seg('motionFps', $t('Плавность анимаций'), '' /* settings.motionFps === 'eco' ? $t('Спектр до 60 кадров в секунду, фон 12 — меньше работы видеокарте, разницы почти не видно') : $t('Спектр, обложка и фон — с частотой вашего монитора (120, 144, 240 Гц…)') */, [['max', $t('Как у монитора')], ['eco', $t('Экономно')]], () => setTimeout(renderSettings, 30)),
      toggle('beatReact', $t('Реакция на бас'), '' /* Обложка «дышит» под низкие частоты */),
      toggle('visualizer', $t('Спектр на «Сейчас играет»'), ''),
      toggle('waveformSeek', $t('Волна в полосе перемотки'), '' /* Строится foobar2000 в фоне и кэшируется */)),
    group($t('VU-метры'),
      toggle('vuMeters', $t('VU-метры вместо спектра'), '' /* Два стрелочных индикатора громкости, левый и правый канал */, () => setTimeout(renderSettings, 30)),
      ...(settings.vuMeters ? [
        seg('vuStyle', $t('Вид'), '', [['classic', $t('Классика')], ['album', $t('Цвета альбома')]]),
        seg('vuLayout', $t('Приборы'), '', [['pair', $t('Два')], ['stereo', $t('Один, две стрелки')]]),
        toggle('vuCanvas', $t('Показывать в «Холсте»'), ''),
        seg('vuRef', $t('0 VU соответствует'), '' /* Уровень синусоиды, при котором стрелка стоит на 0. Громкая современная музыка — −14 или −10 */, [[-18, '−18 dBFS'], [-14, '−14 dBFS'], [-10, '−10 dBFS']]),
      ] : [])),
  );

  // ---- Плеер и окно
  section('window', 'monitor2', $t('Окно и запуск'), '',
    group('',
      langRow(),
      seg('startView', $t('Стартовый экран'), '', [['now', $t('Сейчас играет')], ['playlist', $t('Плейлист')], ['artists', $t('Исполнители')], ['library', $t('Медиатека')]]),
      seg('albumTarget', $t('Куда отправлять альбомы'), '' /* При «Слушать» в медиатеке */, [['dedicated', $t('Плейлист «Gatefold»')], ['active', $t('Активный плейлист')]]),
      toggle('fullscreenTopmost', $t('Полный экран поверх всех окон'), '' /* Выключено — другие программы можно открывать поверх полноэкранной Gatefold */),
      toggle('frameless', $t('Собственная рамка окна'), '' /* Заголовок в стиле темы, Snap Layouts сохраняются · после перезагрузки */, () => toast(`${$t('Перезагрузите интерфейс:')} <b>Ctrl+R</b>`)),
      seg('backdrop', $t('Материал окна'), '' /* Mica — системная подложка Windows 11 */, [['none', $t('Нет')], ['mica', 'Mica']])),
    group($t('Панель задач и трей'),
      toggle('taskbarButtons', $t('Кнопки в миниатюре на панели задач'), '' /* Назад, пауза, вперёд и ♡ — при наведении на значок Gatefold */),
      toggle('taskbarProgress', $t('Прогресс трека на значке'), '' /* Полоска на кнопке в панели задач, жёлтая на паузе */),
      toggle('trayIcon', $t('Значок в области уведомлений'), '' /* Меню с обложкой, управлением и лайком; щелчок — открыть окно */, () => setTimeout(renderSettings, 30)),
      ...(settings.trayIcon ? [
        toggle('minimizeToTray', $t('Сворачивать в трей'), '' /* Свёрнутое окно прячется с панели задач */),
        toggle('closeToTray', $t('Закрывать в трей'), '' /* Крестик прячет окно, музыка играет дальше. Выйти — «Выход» в меню значка */),
      ] : []),
      toggle('miniTopmost', $t('Мини-плеер поверх всех окон'), '' /* Открывается кнопкой рядом с Холстом или из меню значка в трее */)),
  );

  // ---- Плейлисты
  section('playlists', 'list', $t('Плейлисты'), '' /* Вид переключается кнопками в заголовке плейлиста и запоминается для каждого */,
    group('',
      seg('plViewDefault', $t('Вид по умолчанию'), '' /* «Авто» — по альбомам, если плейлист из альбомов; иначе с обложками */, [['auto', $t('Авто')], ['albums', $t('Альбомы')], ['covers', $t('С обложками')], ['grid', $t('Плитки')], ['compact', $t('Компактно')]]),
      h(`<div class="row"><div class="lbl"><b>${$t('Свой вид у плейлистов')}</b></div></div>`)),
  );
  const pr = secs[secs.length - 1].el.querySelector('.st-group .row:last-child');
  pr.append(button($t('Сбросить'), () => { Lib.resetPlaylistViews(); toast($t('Вид плейлистов сброшен')); }));

  // ---- Текст песен
  const provs = settings.lyricsOnline ? LYS.PROVIDERS.map((p) => {
    const el = h(`<div class="row sub-row"><div class="lbl"><b>${p.name}${p.official ? '' : ` <span class="tag-unof" title="${$t('Неофициальный клиентский интерфейс сервиса: работает без ключа, но не одобрен им и может перестать работать')}">${$t('неофициально')}</span>`}</b></div><label class="toggle"><input type="checkbox"><i></i></label></div>`);
    const inp = el.querySelector('input'); inp.checked = (settings.lyricsSources || {})[p.id] === true;
    inp.onchange = () => setSetting('lyricsSources', { ...(settings.lyricsSources || {}), [p.id]: inp.checked });
    return el;
  }) : [];
  section('lyrics', 'quote', $t('Текст песен'), '' /* Сначала теги и .lrc рядом с файлом, затем онлайн. <kbd>[</kbd> <kbd>]</kbd> — сдвиг тайминга, щелчок по источнику над текстом — другие варианты */,
    group($t('Поиск'),
      toggle('lyricsOnline', $t('Искать в интернете'), '' /* Все источники сразу, побеждает лучшее совпадение */, () => setTimeout(renderSettings, 30)),
      ...provs,
      ...(settings.lyricsOnline ? [h(`<div class="row st-note"><small>${$t('Неофициальные источники — на ваш риск')}</small></div>`)] : [])),
    group($t('Показ и сохранение'),
      seg('lyricsSave', $t('Найденный текст'), '' /* «Gatefold» — только в кэше темы, папки с музыкой не трогаются */, [['none', 'Gatefold'], ['file', $t('.lrc рядом')], ['embedded', $t('В теги')]]),
      seg('lyricsSize', $t('Размер на «Сейчас играет»'), '', [['s', $t('Мелкий')], ['m', $t('Средний')], ['l', $t('Крупный')]])),
  );

  // ---- Холст
  section('canvas', 'canvas', $t('Холст'), '' /* Полноэкранный «Сейчас играет»: <kbd>F</kbd> — открыть, <kbd>L</kbd> раскладка, <kbd>T</kbd> текст, <kbd>C</kbd> часы */,
    group('',
      seg('canvasLayout', $t('Раскладка'), '', [['cover', $t('Обложка + текст')], ['lyrics', $t('Крупный текст')], ['minimal', $t('Только обложка')]]),
      toggle('canvasMotion', $t('Движение'), '' /* Медленный наезд камеры и дрейф фона */),
      toggle('canvasLyrics', $t('Текст песни'), ''),
      toggle('canvasClock', $t('Часы'), ''),
      seg('canvasIdleMin', $t('Включаться самому'), '' /* Как заставка, если окно не трогают */, [[0, $t('Нет')], [2, $t('2 мин')], [5, '5'], [10, '10'], [20, '20']]),
      actions(button($t('{0}Открыть Холст', icon('canvas')), () => Canvas.open(), 'primary'), button($t('{0}На другом мониторе', icon('monitor2')), () => Canvas.openOnOtherScreen()))),
  );

  // ---- YouTube
  const ytMode = settings.ytSearch || 'off';
  const keyRow = h(`<div class="row"><div class="lbl"><b>${$t('Ключ YouTube Data API')}</b><small>Google Cloud Console → YouTube Data API v3</small></div><input class="st-input" type="password" spellcheck="false" autocomplete="off" placeholder="AIza…"></div>`);
  const kin = keyRow.querySelector('input'); kin.value = settings.ytApiKey || '';
  kin.addEventListener('keydown', (e) => e.stopPropagation());
  kin.addEventListener('change', () => { setSetting('ytApiKey', kin.value.trim()); dispatchEvent(new Event('aurora:yt-pref')); toast(kin.value.trim() ? $t('Ключ сохранён') : $t('Ключ удалён')); });
  section('youtube', 'yt', 'YouTube', '' /* Ссылки на видео и плейлисты играют всегда; поиск включается отдельно */,
    group($t('Поиск'),
      seg('ytSearch', $t('Поиск видео'), '' /* ytMode === 'web' ? $t('Неофициально: разбор страницы результатов YouTube без ключа. Нарушает условия YouTube и может сломаться при изменении сайта') : ytMode === 'api' ? $t('Официальный способ: ваш собственный ключ, запросы идут напрямую в Google') : $t('Только ссылки') */, [['off', $t('Выключен')], ['api', $t('Ключ API')], ['web', $t('Неофициальный')]], () => { dispatchEvent(new Event('aurora:yt-pref')); setTimeout(renderSettings, 30); }),
      ...(ytMode === 'api' ? [keyRow] : [])),
    group($t('Плеер'),
      lsSeg($t('Качество видео'), '' /* YouTube выбирает поток по размеру плеера — Gatefold задаёт его под нужное качество. Скорость сети может ограничить */, [['auto', $t('Авто')], ['hd720', '720p'], ['hd1080', '1080p'], ['hd1440', '1440p'], ['hd2160', '4K']], () => ytGet('quality', 'auto'), (v) => ytSet('quality', v)),
      lsToggle($t('Видео без встраивания — сразу в окне YouTube'), '' /* Иначе сначала спросит */, () => ytGet('autoWindow', false), (v) => ytSet('autoWindow', v)),
      lsToggle($t('Автовоспроизведение'), '' /* Следующее видео очереди начинается само */, () => ytGet('auto', true), (v) => ytSet('auto', v)),
      actions(button($t('{0}Очистить историю', icon('history')), () => { ytSet('history', []); toast($t('История YouTube очищена')); }))),
  );

  // ---- Хранилище
  const t = TC.tstate;
  const thumbs = h(`<div class="row"><div class="lbl"><b>${$t('Кэш миниатюр')}</b><small id="tcInfo">${$t('{0} шт. · {1} МБ', t.count, (t.bytes / 1048576).toFixed(1))}</small></div></div>`);
  thumbs.append(button($t('Очистить'), async () => { await TC.clear(); toast($t('Кэш миниатюр очищен')); renderSettings(); }));
  LoudUI.settingsSection({ section, group, actions, button, rerender: renderSettings });
  SoundUI.settingsSection({ section, group, actions, button, rerender: renderSettings });

  section('foobar', 'disc', 'foobar2000', '' /* Настройки самого плеера — те же, что в его окне Preferences: изменения видны и там */, ...fb2kGroups(group, actions, button));

  section('updates', 'download', $t('Обновления'), '', group('', updatesSection()));

  section('storage', 'folder', $t('Хранилище и сброс'), '',
    group('',
      toggle('thumbCache', $t('Миниатюры обложек на диске'), '' /* Медиатека открывается мгновенно и после перезапуска */),
      seg('thumbCacheMB', $t('Предел кэша'), '', [[200, $t('200 МБ')], [400, $t('400 МБ')], [800, $t('800 МБ')], [1500, $t('1,5 ГБ')]]),
      thumbs,
      actions(
        button($t('{0}Перезагрузить интерфейс', icon('refresh')), () => location.reload()),
        button($t('Очистить кэш палитр'), () => { localStorage.removeItem('aurora.clusters.v2'); toast($t('Кэш палитр очищен')); }),
        button($t('Сбросить все настройки'), () => { resetSettings(); renderSettings(); toast($t('Настройки сброшены')); }, 'danger'))),
  );

  // ---- layout: nav + column
  const nav = h(`<nav class="st-nav"><label class="st-search">${icon('search')}<input type="search" placeholder="${$t('Найти настройку')}" spellcheck="false"></label><div class="st-links"></div></nav>`);
  const links = nav.querySelector('.st-links');
  for (const sct of secs) {
    const a = h(`<button class="st-link" data-sec="${sct.id}">${icon(sct.ic)}<span>${sct.title}</span></button>`);
    a.onclick = () => { stSection = sct.id; scroller.scrollTo({ top: sct.el.offsetTop - 8, behavior: 'smooth' }); mark(sct.id); };
    links.append(a);
  }
  const main = h('<div class="st-main"></div>');
  main.append(...secs.map((x) => x.el), h(`<div class="st-empty">${$t('Ничего не нашлось')}</div>`), h(`<div class="st-foot">${'Gatefold ' + VERSION}</div>`));
  body.append(nav, main);

  const mark = (id) => links.querySelectorAll('.st-link').forEach((b) => b.classList.toggle('on', b.dataset.sec === id));
  // scroll-spy
  const spy = () => {
    const y = scroller.scrollTop + 80;
    let cur = secs[0].id;
    for (const sct of secs) if (sct.el.offsetTop <= y) cur = sct.id;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) cur = secs[secs.length - 1].id;
    mark(cur);
  };
  scroller.onscroll = () => requestAnimationFrame(spy);
  // search
  const q = nav.querySelector('input');
  q.addEventListener('keydown', (e) => e.stopPropagation());
  q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase();
    let any = false;
    for (const sct of secs) {
      let secHit = !s || sct.title.toLowerCase().includes(s);
      for (const g of sct.el.querySelectorAll('.st-group')) {
        let gHit = false;
        for (const r of g.querySelectorAll('.row')) { const hit = !s || secHit || r.textContent.toLowerCase().includes(s); r.hidden = !hit; gHit ||= hit; }
        g.hidden = !gHit; secHit ||= gHit;
      }
      sct.el.hidden = !secHit; any ||= secHit;
      links.querySelector(`[data-sec="${sct.id}"]`).classList.toggle('dim', !secHit);
    }
    main.querySelector('.st-empty').classList.toggle('on', !any);
  });
  scroller.scrollTop = keepScroll;
  mark(stSection || secs[0].id); spy();
  TC.remeasure().then((m) => { const i = $('tcInfo'); if (i) i.textContent = $t('{0} шт. · {1} МБ на диске', m.n, (m.bytes / 1048576).toFixed(1)); });
}

// ---------------------------------------------------------------- covers
let manual = null; // { job, cands, loading }

/* Covers view is re-rendered on every progress event of three background engines.
   Rebuilding the whole view each time re-created hundreds of nodes and reloaded
   every thumbnail. Now it is built off-document and only cards whose markup
   actually changed are swapped (signature = markup as built, before runtime
   changes such as image load classes). */
function morph(live, next) {
  const kids = [...next.children];
  kids.forEach((n, i) => {
    const sig = n.outerHTML;
    const old = live.children[i];
    if (old && old.__sig === sig) return;          // unchanged: keep node, its images and listeners
    n.__sig = sig;
    if (old) live.replaceChild(n, old); else live.appendChild(n);
  });
  while (live.children.length > kids.length) live.lastElementChild.remove();
}

export function renderCovers(arg) {
  if (arg && arg.manual) startManual(arg.manual);
  const live = $('coversBody');
  const body = document.createElement('div');
  const st = CF.getStats();
  const s = CF.state;

  // manual search card
  if (manual) {
    const c = card($t('Ручной поиск: {0}', esc(manual.job.album)), esc(manual.job.artist) + $t(' · все источники, отсортировано по совпадению'), true);
    if (manual.loading) c.append(h(`<div class="row"><div class="spinner"></div><div class="lbl">${$t('Опрашиваю iTunes, Deezer, MusicBrainz…')}</div></div>`));
    else if (!manual.cands.length) c.append(h(`<div class="empty"><b>${$t('Ничего не найдено')}</b></div>`));
    else {
      const grid = h('<div class="cands"></div>');
      manual.cands.slice(0, 18).forEach((cd) => grid.appendChild(candEl(manual.job, cd)));
      c.append(grid);
    }
    c.append(h(`<div class="row"><button class="btn sm" id="manClose">${$t('Закрыть')}</button></div>`));
    body.append(c);
    c.querySelector('#manClose').onclick = () => { manual = null; renderCovers(); };
  }

  // damage from 1.1: covers written into folders shared by several albums
  const d = CF.diag;
  if (s.diagRunning || s.repairing) {
    body.append(h(`<div class="card wide"><div class="row" style="border:0"><div class="spinner"></div><div class="lbl"><b>${s.repairing ? $t('Исправляю…') : $t('Проверяю папки, общие для нескольких альбомов…')}</b></div></div></div>`));
  } else if (d && (d.files.length || d.foreign.length)) {
    const rc = card(d.files.length ? $t('⚠ Обложки, записанные в общие папки') : $t('Общие папки с обложками'), '', true);
    rc.classList.add('warn');
    rc.append(h(`<div class="desc">${$t('foobar2000 ищет обложку <b>по папке</b>: файл cover.jpg применяется ко <b>всем</b> трекам в ней и перекрывает встроенные обложки. Ранняя версия темы записала такой файл в папки, где лежат несколько альбомов, — поэтому у них у всех стала одна обложка. Музыкальные файлы не изменялись.')}</div>`));
    if (d.files.length) {
      rc.append(h(`<div class="desc">${$t('Найдено <b>{0}</b> {1} темы в {2} общих папках (из {3} папок с несколькими альбомами). Исправление переместит их в <b>Корзину</b> (можно восстановить), после чего встроенные обложки вернутся, а затронутые альбомы получат правильные обложки — встроенные в их собственные треки.', d.files.length, CF_pl(d.files.length), d.files.length, d.sharedDirs)}</div>`));
      const list = h('<div class="log" style="max-height:180px"></div>');
      for (const f of d.files.slice(0, 40)) list.append(h(`<div class="log-row" style="grid-template-columns:1fr auto"><div class="s">${esc(f.path)}</div><div class="s">${f.albums} ${$t('альб.')}</div></div>`));
      rc.append(list);
    }
    if (d.foreign.length) rc.append(h(`<div class="desc" style="margin-top:8px">${$t('Ещё {0} файлов обложек в общих папках появились <b>до</b> установки темы — они не трогаются.', d.foreign.length)} ${d.files.length ? '' : $t('Если это тоже ошибка — можно убрать их в Корзину.')}</div>`));
    const act = h('<div class="row" style="gap:8px;flex-wrap:wrap;border:0"></div>');
    const ab = (txt, fn, cls = '') => { const e = h(`<button class="btn ${cls}">${txt}</button>`); e.onclick = fn; act.append(e); };
    if (d.files.length) ab($t('{0}Исправить: убрать в Корзину и пересканировать', icon('refresh')), async () => {
      const r = await CF.repairSharedCovers();
      toast($t('Исправлено: {0} {1} в Корзине', r.moved, CF_pl(r.moved)) + (r.failed ? $t(', не удалось: {0}', r.failed) : '') + $t('. Перепроверяю медиатеку…'), { ms: 8000 });
      CF.sweepLibrary(true);
    }, 'primary');
    if (d.foreign.length) ab($t('Убрать в Корзину и их тоже'), async () => { if (!confirm($t('Переместить в Корзину ещё {0} файлов обложек из общих папок?', d.foreign.length))) return; const r = await CF.repairSharedCovers({ includeForeign: true }); toast($t('В Корзине: {0}', r.moved)); CF.sweepLibrary(true); });
    ab($t('Проверить заново'), () => CF.diagnoseSharedCovers());
    rc.append(act);
    body.append(rc);
  } else if (d) {
    body.append(h(`<div class="card wide"><div class="desc" style="margin:0">${$t('✓ Проверка общих папок: ошибочно записанных обложек нет (папок с несколькими альбомами: {0}). Новые обложки для таких папок встраиваются в треки альбома.', d.sharedDirs)}</div></div>`));
  }

  // status
  const stc = card($t('Состояние'), s.busy ? `${$t('Сейчас:')} <b>${esc(s.busy.artist)} — ${esc(s.busy.album)}</b>` : (s.paused ? $t('Пауза') : (s.queue.length ? $t('В очереди…') : $t('Ожидание'))), true);
  stc.append(h(`<div class="stat-grid"><div class="stat"><b class="status-ok">${st.ok}</b><span>${$t('установлено')}</span></div><div class="stat"><b class="status-rev">${st.rev}</b><span>${$t('на проверке')}</span></div><div class="stat"><b>${st.nf}</b><span>${$t('не найдено')}</span></div><div class="stat"><b class="status-err">${st.err}</b><span>${$t('ошибки')}</span></div></div>`));
  if (s.total && (s.sweeping || s.sweepDone || s.scanned)) {
    const phase = s.sweeping ? $t('Проверка медиатеки') : s.sweepDone ? $t('Проверка завершена') : $t('Проверка остановлена');
    stc.append(
      h(`<div class="desc"><b>${phase}:</b> ${$t('{0} из {1} альбомов · с обложкой <b>{2}</b> · <b class="status-rev">без обложки {3}</b>', s.scanned, s.total, s.withArt, s.missing)}${s.skipped ? $t(' · пропущено (уже обработаны) {0}', s.skipped) : ''} ${$t('· в очереди поиска <b>{0}</b>', s.queue.length)}</div>`),
      h(`<div class="progress"><i style="width:${(s.scanned / s.total * 100).toFixed(1)}%"></i></div>`));
  } else stc.append(h(`<div class="desc">${$t('Проверка медиатеки ещё не запускалась в этой сессии.')}</div>`));
  const actions = h(`<div class="row" style="gap:8px;flex-wrap:wrap;border:0"></div>`);
  const b = (txt, fn, cls = '') => { const e = h(`<button class="btn ${cls}">${txt}</button>`); e.onclick = fn; actions.append(e); };
  b(`${icon('search')}${s.sweeping ? $t('Идёт проверка…') : $t('Проверить медиатеку')}`, () => { if (s.sweeping) return; CF.sweepLibrary(true); toast($t('Проверяю каждый альбом на наличие обложки')); }, 'primary');
  b(s.paused ? $t('Продолжить') : $t('Приостановить'), () => CF.setPaused(!s.paused));
  b($t('Повторить «не найдено» и ошибки'), () => { CF.resetStatus('nf'); CF.resetStatus('err'); CF.sweepLibrary(true); });
  b($t('Сбросить историю'), () => { if (confirm($t('Сбросить все статусы обложек?'))) CF.resetStatus(); });
  stc.append(actions);
  if (s.lastError) stc.append(h(`<div class="desc">${$t('Последняя ошибка:')} ${esc(s.lastError)}</div>`));
  body.append(stc);

  // quality of existing covers
  body.append(qualityCard());

  // artist photos
  const as = AA.stats(), ast = AA.astate;
  const ac = card($t('Фото исполнителей'), '' /* Deezer (1000 px) → MusicBrainz/Wikidata; an artist is accepted only when its discography contains your album */, true);
  ac.append(h(`<div class="stat-grid"><div class="stat"><b class="status-ok">${as.files}</b><span>${$t('фото в папке')}</span></div><div class="stat"><b>${as.queue + (ast.busy ? 1 : 0)}</b><span>${$t('в очереди')}${ast.busy ? ' · ' + esc(ast.busy.name) : ''}</span></div><div class="stat"><b>${as.nf}</b><span>${$t('не найдено')}</span></div><div class="stat"><b class="status-err">${as.err}</b><span>${$t('ошибки')}</span></div></div>`));
  if (ast.lastError) ac.append(h(`<div class="desc">${$t('Последняя ошибка:')} ${esc(ast.lastError)}</div>`));
  const aact = h('<div class="row" style="gap:8px;flex-wrap:wrap;border:0"></div>');
  const ab = (txt, fn, cls = '') => { const e = h(`<button class="btn ${cls}">${txt}</button>`); e.onclick = fn; aact.append(e); };
  ab($t('{0}Скачать для всех', icon('search')), async () => { await loadArtists(false); for (const x of artistsState.list) AA.want({ name: x.name, albums: x.albums.map((a) => a.name) }); toast($t('Ищу фото для всех исполнителей')); renderCovers(); }, 'primary');
  ab(ast.paused ? $t('Продолжить') : $t('Приостановить'), () => AA.setPaused(!ast.paused));
  ab($t('Повторить ненайденные'), () => { AA.resetNotFound(); toast($t('Статусы сброшены — откройте «Исполнители» или нажмите «Скачать для всех»')); });
  ab($t('{0}Открыть папку', icon('folder')), () => openArtistFolder());
  ac.append(aact, toggle('artistAuto', $t('Скачивать автоматически'), '' /* При открытии «Исполнителей» — сначала видимые, затем все остальные */));
  body.append(ac);

  // review queue
  const rev = CF.getReview();
  if (rev.length) {
    const rc = card($t('Требуют подтверждения · {0}', rev.length), '', true);
    for (const item of rev.slice(0, 12)) {
      const box = h(`<div style="padding:10px 0;border-top:1px solid var(--line)"><div style="display:flex;align-items:center;gap:10px"><div style="flex:1;min-width:0"><b>${esc(item.job.album)}</b> <span style="color:var(--text-3)">· ${esc(item.job.artist)}</span></div><button class="btn sm" data-a="more">${$t('Искать ещё')}</button><button class="btn sm" data-a="skip">${$t('Пропустить')}</button></div><div class="cands"></div></div>`);
      const grid = box.querySelector('.cands');
      item.cands.slice(0, 6).forEach((cd) => grid.appendChild(candEl(item.job, cd)));
      box.querySelector('[data-a=skip]').onclick = () => { CF.skipReview(item.key); renderCovers(); };
      box.querySelector('[data-a=more]').onclick = () => { startManual(item.job); };
      rc.append(box);
    }
    body.append(rc);
  }

  // settings
  const sc = card($t('Параметры поиска'), '');
  sc.append(
    toggle('coverAuto', $t('Искать для играющего альбома'), '' /* Сразу при старте трека без обложки */),
    toggle('coverSweep', $t('Фоновая проверка медиатеки'), '' /* Обходит все альбомы при запуске, с паузами — не мешает воспроизведению */),
    seg('coverMinSize', $t('Минимальный размер'), '' /* Отбраковка мелких картинок */, [[500, '500'], [600, '600'], [800, '800'], [1000, '1000']]),
    seg('coverMaxSize', $t('Максимальный размер'), '' /* Крупнее — уменьшается (JPEG 93%) */, [[0, $t('Оригинал')], [3000, '3000'], [2000, '2000'], [1400, '1400']]),
    seg('coverThreshold', $t('Строгость совпадения'), '' /* Ниже порога — в «Требуют подтверждения» */, [[0.78, $t('Мягко')], [0.82, $t('Норма')], [0.88, $t('Строго')]]),
    seg('coverTarget', $t('Куда сохранять'), '' /* Для папки с одним альбомом. «+ в теги» также встраивает обложку в первый трек */, [['file', 'cover.jpg'], ['all', $t('cover.jpg + теги')]]),
    seg('coverSharedDir', $t('Папка с несколькими альбомами'), '' /* cover.jpg там нельзя — он лёг бы на все альбомы папки. Встраивание пишет обложку (до 1400 px) только в треки нужного альбома */, [['embed', $t('Встраивать в треки')], ['skip', $t('Пропускать')]]),
  );
  const src = card($t('Источники'), '');
  const srcToggle = (k, label, hint) => {
    const el = h(`<div class="row"><div class="lbl"><b>${label}</b></div><label class="toggle"><input type="checkbox"><i></i></label></div>`);
    const inp = el.querySelector('input'); inp.checked = !!settings.coverSources[k];
    inp.onchange = () => setSetting('coverSources', { ...settings.coverSources, [k]: inp.checked });
    return el;
  };
  const ctry = h(`<div class="row"><div class="lbl"><b>${$t('Витрины iTunes')}</b></div><input class="filter" style="width:120px" value="${esc(settings.coverCountries)}"></div>`);
  ctry.querySelector('input').onchange = (e) => setSetting('coverCountries', e.target.value.toUpperCase());
  src.append(srcToggle('itunes', 'iTunes / Apple Music', $t('Лучшее качество, мейджоры и инди')), srcToggle('deezer', 'Deezer', $t('Широкий каталог, СНГ')), srcToggle('musicbrainz', 'MusicBrainz + Cover Art Archive', $t('Редкие издания, винил, бутлеги')), ctry);
  body.append(sc, src);

  // log
  const lg = card($t('Журнал'), '', true);
  const list = h('<div class="log"></div>');
  const label = { ok: $t('установлена'), nf: $t('не найдена'), err: $t('ошибка'), rev: $t('на проверке') };
  for (const e of CF.getLog().slice(0, 60)) {
    list.append(h(`<div class="log-row">${e.thumb ? `<img class="th" src="${esc(e.thumb)}" alt="" loading="lazy">` : '<div class="th"></div>'}<div style="min-width:0"><div class="t">${esc(e.album)} <span style="color:var(--text-3);font-weight:400">· ${esc(e.artist)}</span></div><div class="s"><span class="status-${e.s}">${label[e.s] || e.s}</span>${e.src ? ' · ' + esc(e.src) : ''}${e.w ? ` · ${e.w}×${e.h}` : ''}${e.sc ? $t(' · совпадение {0}%', Math.round(e.sc * 100)) : ''}${e.err ? ' · ' + esc(e.err) : ''}</div></div><div class="s num">${new Date(e.t).toLocaleTimeString().slice(0, 5)}</div></div>`));
  }
  if (!CF.getLog().length) list.append(h(`<div class="desc">${$t('Пока пусто')}</div>`));
  lg.append(list);
  body.append(lg);
  $('coverBadge').textContent = rev.length || '';
  morph(live, body);
}

// ---------------------------------------------------------------- quality card
let qShow = 40, qOpen = '';
function qualityCard() {
  if (!Q.qstate.loaded) { Q.load(); }
  const qs = Q.qstate, sum = Q.summary();
  const c = card($t('Качество обложек'), '', true);
  if (qs.scanning) {
    c.append(h(`<div class="desc">${$t('<b>Проверка:</b> {0} из {1} альбомов · с обложкой {2} · найдено слабых {3}', qs.scanned, qs.total || '…', qs.withArt, Q.rows.filter((r) => r.flags.length).length)}</div>`),
      h(`<div class="progress"><i style="width:${qs.total ? (qs.scanned / qs.total * 100).toFixed(1) : 2}%"></i></div>`));
  } else if (qs.scannedAt) {
    c.append(h(`<div class="stat-grid"><div class="stat"><b>${qs.withArt}</b><span>${$t('проверено обложек')}</span></div><div class="stat"><b class="status-rev">${sum.lowres}</b><span>${$t('низкое разрешение')}</span></div><div class="stat"><b class="status-rev">${sum.jpegq}</b><span>${$t('сильно сжаты')}</span></div><div class="stat"><b>${sum.aspect}</b><span>${$t('не квадратные')}</span></div><div class="stat"><b class="status-ok">${sum.upgraded}</b><span>${$t('улучшено')}</span></div></div>`));
    c.append(h(`<div class="desc">${$t('Последняя проверка:')} ${new Date(qs.scannedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}${sum.review ? ` · <b class="status-rev">${$t('ждут решения:')} ${sum.review}</b>` : ''}${sum.todo ? $t(' · не обработано: {0}', sum.todo) : ''}</div>`));
  } else c.append(h(`<div class="desc">${$t('Ещё не проверялось')}</div>`));
  const act = h('<div class="row" style="gap:8px;flex-wrap:wrap;border:0"></div>');
  const b = (txt, fn, cls = '') => { const e = h(`<button class="btn ${cls}">${txt}</button>`); e.onclick = fn; act.append(e); return e; };
  b(`${icon('search')}${qs.scanning ? $t('Идёт проверка…') : qs.scannedAt ? $t('Проверить заново') : $t('Проверить качество')}`, () => { if (!qs.scanning) Q.scan(); }, qs.scannedAt ? '' : 'primary');
  if (qs.scannedAt && sum.todo) b(`${icon('sparkle')}${qs.auto ? $t('Остановить') : $t('Улучшить автоматически ({0})', sum.todo)}`, () => (qs.auto ? Q.stopAll() : Q.upgradeAll()), qs.auto ? '' : 'primary');
  if (qs.scanning || qs.auto) b(qs.paused ? $t('Продолжить') : $t('Приостановить'), () => Q.setPaused(!qs.paused));
  c.append(act);
  c.append(
    seg('qualityMinRes', $t('Низкое разрешение — меньше'), '' /* По короткой стороне */, [[500, '500'], [600, '600'], [800, '800'], [1000, '1000']]),
    seg('qualityAuto', $t('Автозамена'), '' /* «Если совпадает» — только та же картинка, крупнее и с высокой оценкой совпадения альбома */, [['same', $t('Если совпадает')], ['never', $t('Всегда спрашивать')]]),
  );
  if (artDiag.mode) c.append(h(`<div class="desc">${$t('Чтение обложек:')} ${{ fb2k: $t('напрямую (fb2k://)'), same: $t('напрямую (локальный адрес)'), bridge: $t('через foobar — медленнее, но работает всегда'), plain: $t('напрямую') }[artDiag.mode] || artDiag.mode}</div>`));
  if (qs.lastError) c.append(h(`<div class="desc">${$t('Последняя ошибка:')} ${esc(qs.lastError)}</div>`));

  const list = Q.rows.filter((r) => r.flags.length || r.st === 'upgraded');
  if (list.length) {
    const box = h('<div class="qlist"></div>');
    const label = { flag: '', busy: $t('ищу замену…'), review: $t('нужно решение'), nobetter: $t('лучше не найдено'), err: $t('ошибка'), kept: $t('оставлена'), upgraded: $t('улучшена'), ok: $t('в порядке') };
    const shown = list.slice(0, qShow);
    for (const r of shown) {
      const el = h(`<div class="qrow st-${r.st}"><div class="th"><img alt=""></div><div class="qi"><div class="t">${esc(r.album)} <span>· ${esc(r.artist)}</span></div><div class="s">${Q.flagText(r).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}${r.fmt && !r.flags.includes('jpegq') && r.fmt !== 'JPEG' ? `<span class="chip">${r.fmt}</span>` : ''}<span class="qst">${r.st === 'busy' ? '<span class="spinner"></span>' : ''}${esc(label[r.st] || '')}${r.note ? ' · ' + esc(r.note) : ''}</span></div></div><div class="qa"></div></div>`);
      const qa = el.querySelector('.qa');
      const qb = (txt, fn, cls = 'btn sm') => { const e = h(`<button class="${cls}">${txt}</button>`); e.onclick = async (ev) => { ev.stopPropagation(); e.disabled = true; try { await fn(); } catch (err) { toast(esc(err.message)); } e.disabled = false; }; qa.append(e); };
      if (r.st === 'flag' || r.st === 'err' || r.st === 'nobetter' || r.st === 'kept') qb($t('Найти лучше'), () => Q.upgrade(Q.rows.find((x) => x.key === r.key) || r));
      if (r.st === 'review') qb(qOpen === r.key ? $t('Скрыть') : $t('Выбрать'), () => { qOpen = qOpen === r.key ? '' : r.key; renderCovers(); }, 'btn sm primary');
      if (r.st === 'upgraded' && r.jid) qb($t('Вернуть прежнюю'), async () => { await Q.undo(r.jid); toast($t('Прежняя обложка возвращена')); });
      box.append(el);
      if (r.st === 'review' && qOpen === r.key && r.cands) {
        const grid = h('<div class="cands qcands"></div>');
        for (const cd of r.cands) {
          const v = { same: [$t('совпадает с текущей'), 'ok'], similar: [$t('похожа'), 'rev'], different: [$t('другая картинка'), 'err'] }[cd.verdict] || ['', ''];
          const ce = h(`<div class="cand"><img src="${esc(Q.previewFor(r.key, cd))}" alt="" loading="lazy"><div class="ct">${cd.w}×${cd.h} · ${esc(cd.src)}</div><div class="cs"><span class="status-${v[1]}">${v[0]}</span> ${$t('· альбом')} ${Math.round(cd.score * 100)}%</div><div class="cs">${esc(cd.title || '')}</div></div>`);
          ce.onclick = async () => { ce.style.opacity = '.5'; ce.style.pointerEvents = 'none'; await Q.applyCandidate(r.key, cd); qOpen = ''; };
          grid.append(ce);
        }
        const keep = h(`<div class="row" style="border:0;gap:8px"><button class="btn sm">${$t('Оставить текущую')}</button></div>`);
        keep.querySelector('button').onclick = () => { Q.keep(r.key); qOpen = ''; };
        box.append(grid, keep);
      }
    }
    if (list.length > qShow) { const more = h(`<button class="btn sm" style="margin-top:8px">${$t('Показать ещё ({0})', list.length - qShow)}</button>`); more.onclick = () => { qShow += 60; renderCovers(); }; box.append(more); }
    c.append(box);
    Lib.coversFor(shown.map((r) => r.path), 96).then((get) => {
      box.querySelectorAll('.qrow').forEach((el, i) => { const u = get(shown[i].path); const im = el.querySelector('img'); if (u) { im.onload = () => { im.classList.add('on'); Lib.coverLoaded(u); }; im.src = u; } });
    });
  }
  const jr = Q.getJournal().slice(0, 12);
  if (jr.length) {
    const jl = h('<div class="log" style="max-height:220px;margin-top:10px"></div>');
    jl.append(h(`<div class="desc" style="margin:0 0 4px"><b>${$t('История замен')}</b> ${$t('· резервные копии: {0}', '%profile%\\aurora\\backup\\covers')}</div>`));
    for (const e of jr) {
      const row = h(`<div class="log-row" style="grid-template-columns:1fr auto auto"><div style="min-width:0"><div class="t">${esc(e.album)} <span style="color:var(--text-3);font-weight:400">· ${esc(e.artist)}</span></div><div class="s">${esc(e.from)} → ${esc(e.to)} · ${esc(e.src || '')} · ${e.mode === 'embed' ? $t('встроена в {0} тр.', (e.tracks || []).length) : e.mode === 'add-file' ? $t('cover.jpg добавлен') : $t('файл заменён')}${e.undone ? ` · <b>${$t('возвращено')}</b>` : ''}</div></div><div class="s num">${new Date(e.t).toLocaleDateString()}</div><div></div></div>`);
      if (!e.undone) { const ub = h(`<button class="btn sm">${$t('Вернуть')}</button>`); ub.onclick = async () => { ub.disabled = true; try { await Q.undo(e.id); toast($t('Возвращено')); } catch (err) { toast(esc(err.message)); ub.disabled = false; } }; row.lastChild.append(ub); }
      jl.append(row);
    }
    c.append(jl);
  }
  return c;
}
Q.events.addEventListener('change', () => { if (router.current === 'covers') scheduleCovers(); });

function candEl(job, cd) {
  const el = h(`<div class="cand"><img src="${esc(cd.thumb)}" alt="" loading="lazy"><div class="ct">${esc(cd.title)}</div><div class="cs">${esc(cd.artist || '')}${cd.year ? ' · ' + cd.year : ''}</div><div class="cs">${esc(cd.src)} · ${$t('до {0}px', cd.res)} · ${Math.round((cd.score || 0) * 100)}%</div></div>`);
  el.onclick = async () => {
    el.style.opacity = '.5'; el.style.pointerEvents = 'none';
    try {
      await CF.applyCandidate(job, cd);
      if (manual && manual.job.key === job.key) manual = null;
      renderCovers();
    } catch (e) { toast($t('Не подошла: ') + esc(e.message)); el.style.opacity = ''; el.style.pointerEvents = ''; }
  };
  return el;
}

async function startManual(job) {
  if (!job) { toast($t('Этот альбом не на локальном диске — сохранить обложку некуда')); return; }
  manual = { job, cands: [], loading: true };
  if (router.current === 'covers') renderCovers();
  const cands = await CF.findCandidates(job, { exhaustive: true });
  if (!manual || manual.job.key !== job.key) return;
  manual.cands = cands; manual.loading = false;
  if (router.current === 'covers') renderCovers();
}

CF.events.addEventListener('repaired', () => { if (router.current === 'covers') renderCovers(); });
CF.events.addEventListener('change', () => { if (router.current === 'covers') scheduleCovers(); else $('coverBadge').textContent = CF.getReview().length || ''; });
AA.events.addEventListener('change', () => { if (router.current === 'covers') scheduleCovers(); });
let covT = 0;
/* at most ~1 render per 800 ms while engines report progress; none while the window is hidden */
let covLast = 0, covPending = false;
function scheduleCovers() {
  if (covT) return;
  if (document.visibilityState === 'hidden') { covPending = true; return; }
  covT = setTimeout(() => {
    covT = 0; covLast = performance.now();
    if (router.current !== 'covers') return;
    const sc = $('view-covers').querySelector('.scroller'); const y = sc.scrollTop; renderCovers(); sc.scrollTop = y;
  }, Math.max(120, 800 - (performance.now() - covLast)));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && covPending) { covPending = false; scheduleCovers(); } });

router.on('settings', renderSettings);
router.on('covers', renderCovers);
