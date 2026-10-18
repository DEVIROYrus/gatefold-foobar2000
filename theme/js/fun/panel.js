/* Gatefold · fun/panel.js — the mode's settings: interface style, its options, achievements. */
import { html, esc, cfg, setAchievements, setSetting } from './core.js';
import { modal } from './kit.js';
import * as Skins from './skins.js';
import * as Ach from './achievements.js';

import { $t } from '../i18n.js';
// miniature of each style, drawn with plain CSS (fun.css .pv-*)
const PREVIEW = {
  none: '<div class="pv pv-none"><i class="art"></i><b>Aa</b><s></s><s class="s2"></s></div>',
  toon: '<div class="pv pv-toon"><i class="art"></i><b>Aa</b><s></s><s class="s2"></s><em></em></div>',
  pixel: '<div class="pv pv-pixel"><i class="art"></i><b>Aa</b><s></s><s class="s2"></s><em></em></div>',
  metal: '<div class="pv pv-metal"><i class="art"></i><b>Aa</b><s></s><s class="s2"></s><em></em></div>',
};

let open1 = null;
export function open() {
  if (open1) return;
  const body = html('<div class="fun-panel"></div>');

  const sec1 = html(`<section><h4>${$t('Стиль интерфейса')}</h4><div class="fun-skins"></div><div class="fun-skin-opts"></div></section>`);
  const grid = sec1.querySelector('.fun-skins'), optsBox = sec1.querySelector('.fun-skin-opts');
  const renderOpts = () => {
    const id = Skins.current(), s = Skins.SKINS.find((x) => x.id === id);
    optsBox.innerHTML = '';
    for (const [k, title, desc] of s?.opts || []) {
      const row = html(`<label class="fun-row"><div><b>${esc(title)}</b><small>${esc(desc)}</small></div><span class="toggle"><input type="checkbox"><i></i></span></label>`);
      const inp = row.querySelector('input'); inp.checked = Skins.optOn(id, k);
      inp.onchange = () => Skins.setOpt(k, inp.checked);
      optsBox.appendChild(row);
    }
  };
  const sync = () => grid.querySelectorAll('.fun-skin').forEach((b) => b.classList.toggle('on', b.dataset.id === Skins.current()));
  for (const s of Skins.SKINS) {
    const b = html(`<button class="fun-skin" data-id="${s.id}">${PREVIEW[s.id]}<b>${esc(s.title)}</b><small>${esc(s.desc)}</small></button>`);
    b.onclick = async () => { grid.classList.add('busy'); await Skins.apply(s.id); grid.classList.remove('busy'); sync(); renderOpts(); };
    grid.appendChild(b);
  }
  sync(); renderOpts();
  body.appendChild(sec1);

  const p = Ach.progress();
  const sec2 = html(`<section><h4>${$t('Достижения')}</h4>
    <label class="fun-row"><div><b>${$t('Собирать достижения')}</b><small>${$t('Тихо всплывают в углу на пять секунд. Без звука, без окон, воспроизведение не трогают.')}</small></div><span class="toggle"><input type="checkbox"><i></i></span></label>
    <div class="fun-row"><div><b>${$t('{0} из {1}', p.got, p.total)}</b><small>${$t('Часть условий скрыта до получения')}</small></div><button class="btn">${$t('Открыть все')}</button></div></section>`);
  const inp = sec2.querySelector('input'); inp.checked = cfg().ach;
  inp.onchange = () => setAchievements(inp.checked);
  sec2.querySelector('.btn').onclick = () => { m.close(); Ach.trophyRoom(); };
  body.appendChild(sec2);
  body.appendChild(html(`<p class="fun-hint">${$t('Это окно открывается правым щелчком по надписи «Gatefold» в заголовке. Десять щелчков по ней же включают и выключают режим.')}</p>`));

  const m = modal({ title: $t('Режим приколов'), body, cls: 'fun-panel-back', onClose: () => { open1 = null; },
    actions: [{ label: $t('Выключить режим и стереть данные'), fn: () => { setSetting('funMode', false); } }, { label: $t('Готово'), primary: true }] });
  open1 = m;
}
export const close = () => open1 && open1.close();
