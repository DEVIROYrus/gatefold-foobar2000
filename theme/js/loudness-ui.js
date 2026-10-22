/*
 * Gatefold · loudness-ui.js — Settings → «Volume levelling» (the work is in loudness.js).
 * One switch for everybody; under it, how to level (whole albums by default), the target
 * loudness, whether to analyse tracks that have no ReplayGain values yet, and the progress.
 */
import { esc } from './bridge.js';
import { h, icon, toast } from './ui.js';
import { settings } from './settings.js';
import { $t } from './i18n.js';
import * as Loud from './loudness.js';

const TARGET_LABEL = () => ({
  [-18]: $t('−18 LUFS — стандарт ReplayGain'),
  [-16]: $t('−16 LUFS — как Apple Music'),
  [-14]: $t('−14 LUFS — как Spotify и YouTube'),
  [-23]: $t('−23 LUFS — как радио и ТВ'),
});

function statusHtml() {
  const s = Loud.state;
  if (!settings.level) return '';
  if (!settings.levelScan) return $t('Выравниваются треки с метками ReplayGain');
  const bar = (p) => `<span class="snd-bar"><i style="width:${Math.max(2, Math.min(100, p * 100)).toFixed(1)}%"></i></span>`;
  const bad = s.failed + s.unwritable;
  const nw = (s.nowrite || []).length ? ` · <span class="sp-bad" title="${esc($t('foobar2000 не сохраняет метки ReplayGain в файлах этого формата'))}">${$t('без меток: {0}', s.nowrite.map((x) => '.' + x).join(', '))}</span>` : '';
  const tail = nw + (bad ? ` · <span class="sp-bad" title="${esc($t('Эти файлы не удалось прочитать или записать: они звучат с предусилением для треков без меток'))}">${$t('не удалось: {0}', bad)}</span>` : '');
  switch (s.phase) {
    case 'off': case 'idle': return $t('Подготовка…');
    case 'scanning': return $t('Ищу треки без меток ReplayGain…');
    case 'error': return `<span class="sp-bad">${s.error === 'LIBRARY' ? $t('Медиатека не настроена — добавьте папку с музыкой') : esc(s.error)}</span>`;
    case 'waiting': return $t('Альбом, который играет, получит метки, когда закончится') + tail;
    case 'done': return $t('Готово: у всех альбомов есть метки') + (s.albums ? ` · ${$t('выровнено сейчас: {0}', s.albumsDone.toLocaleString())}` : '') + tail;
    default: {
      const left = Math.max(0, s.secondsTotal - s.secondsDone);
      const eta = left && s.rate ? left / s.rate : 0;
      const etaTxt = eta > 5400 ? $t('≈ {0} ч', Math.round(eta / 3600)) : eta > 90 ? $t('≈ {0} мин', Math.round(eta / 60)) : '';
      // only the albums that still lack ReplayGain values are counted: the rest of the library already has them
      let t = `<span title="${esc($t('Альбомы, у которых уже есть метки ReplayGain, анализировать не нужно'))}">${$t('Анализ: {0} из {1} альбомов без меток', s.albumsDone.toLocaleString(), s.albums.toLocaleString())}</span>` + (etaTxt ? ' · ' + etaTxt : '');
      if (s.phase === 'paused') t += ' · ' + (s.why === 'battery' ? $t('пауза: батарея') : $t('пауза'));
      const cur = s.current && s.phase !== 'paused' ? `<br><span class="dim">${esc(s.current)}</span>` : '';
      return t + tail + cur + bar(s.secondsTotal ? s.secondsDone / s.secondsTotal : 0);
    }
  }
}

let wired = false;
export function settingsSection({ section, group, actions, button, rerender }) {
  if (!wired) { wired = true; Loud.events.addEventListener('change', () => { const el = document.getElementById('lvlStatus'); if (el) el.innerHTML = statusHtml(); }); }
  const on = !!settings.level;
  const row = (label, ctl, sub = '') => h(`<div class="row"><div class="lbl"><b>${label}</b>${sub}</div>${ctl}</div>`);

  const sw = row($t('Выравнивать громкость'), '<label class="toggle"><input type="checkbox"><i></i></label>', `<small id="lvlStatus" class="snd-status">${statusHtml()}</small>`);
  const inp = sw.querySelector('input'); inp.checked = on;
  inp.onchange = async () => {
    inp.disabled = true;
    if (inp.checked) {
      const done = await Loud.enable();
      if (!done) toast($t('foobar2000 не принял настройки ReplayGain'));
      else if (settings.levelScan) toast($t('Громкость выравнивается. Треки без меток ReplayGain проанализируются в фоне'), { ms: 6000 });
    } else await Loud.disable();
    setTimeout(rerender, 30);
  };
  if (!on) { section('level', 'vol', $t('Выравнивание громкости'), '', group('', sw)); return; }

  // how: whole albums (the default — an album keeps its own quiet and loud moments), smart, per track
  const MODES = [
    ['album', $t('Альбомами'), $t('Альбомы звучат одинаково громко, а тихие и громкие треки внутри альбома остаются такими, как их задумал артист')],
    ['auto', $t('Умно'), $t('Альбомами, когда альбом играет по порядку; по трекам — в случайном порядке')],
    ['track', $t('Каждый трек'), $t('Каждый трек отдельно: ровно для сборников, но тихие интерлюдии станут такими же громкими, как всё остальное')],
  ];
  const how = row($t('Как выравнивать'), '<div class="seg"></div>');
  for (const [v, txt, tip] of MODES) {
    const b = h(`<button title="${esc(tip)}"${(settings.levelMode || 'album') === v ? ' class="on"' : ''}>${txt}</button>`);
    b.onclick = () => { how.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); Loud.setMode(v); };
    how.querySelector('.seg').append(b);
  }

  const L = TARGET_LABEL();
  // above −18 LUFS the preamp adds gain; clipping prevention keeps quiet, dynamic albums below the
  // target rather than distorting them (foobar2000 limits the gain by the stored peak)
  const tgt = row($t('Целевая громкость'), `<select class="st-input lvl-target">${Loud.TARGETS.map((v) => `<option value="${v}"${+settings.levelTarget === v ? ' selected' : ''}>${L[v]}</option>`).join('')}</select>`);
  tgt.querySelector('select').onchange = (e) => Loud.setTarget(+e.target.value);

  const scan = row($t('Анализировать треки без меток'), '<label class="toggle"><input type="checkbox"><i></i></label>',
    `<small class="snd-status dim">${$t('Пишет в файлы теги ReplayGain, как сканер foobar2000. Сам звук не меняется')}</small>`);
  const sin = scan.querySelector('input'); sin.checked = settings.levelScan !== false;
  sin.onchange = () => { Loud.setScan(sin.checked); setTimeout(rerender, 30); };

  const busy = settings.levelScan && !['done', 'off', 'error'].includes(Loud.state.phase);
  const acts = settings.levelScan ? actions(
    busy ? button(settings.levelPaused ? $t('Продолжить') : $t('Пауза\u0004action'), () => { Loud.pause(!settings.levelPaused); setTimeout(rerender, 30); }) : null,
    button($t('{0}Проверить медиатеку', icon('refresh')), () => { Loud.start(); Loud.rescan(); toast($t('Ищу треки без меток ReplayGain…')); }),
  ) : null;

  section('level', 'vol', $t('Выравнивание громкости'), '', group('', sw, how, tgt, scan, acts));
}
