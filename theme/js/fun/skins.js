/*
 * Gatefold · fun/skins.js — interface skins.
 *
 * A skin = css/skins/<id>.css (restyles the real components, keyed on
 * :root[data-skin]) + js/fun/skins/<id>.js (background art, canvas painters
 * for the spectrum and waveform, small DOM ornaments). The album palette keeps
 * driving every skin: theme.js publishes the raw colours as --src-*, the skin
 * bends them into its own look with relative colour syntax.
 */
import * as Viz from '../viz.js';
import * as App from '../app.js';
import { store, runtime, emit, isEnabled } from './core.js';

import { $t } from '../i18n.js';
export const SKINS = [
  { id: 'none', title: 'Gatefold', desc: $t('Обычный интерфейс') },
  { id: 'toon', title: $t('Мультик'), desc: $t('Гротескная анимация для взрослых: жирный чернильный контур, кремовые панели, жёсткие тени, капающие заголовки'),
    opts: [['boil', $t('Живой контур'), $t('Обводка обложки слегка «дышит», как в рисованной анимации'), true], ['doodles', $t('Рисунки на фоне'), $t('Чернильные каракули на обоях'), true]] },
  { id: 'pixel', title: $t('16 бит'), desc: $t('Меню и HUD экшен-платформеров эпохи SNES: пиксельные рамки, шкалы энергии, ночной город'),
    opts: [['pixcover', $t('Пиксельная обложка'), $t('Обложка в «Сейчас играет» — 96 точек и 16-битная палитра'), true], ['crt', $t('Строки развёртки'), $t('Едва заметные линии кинескопа поверх всего'), true], ['ready', $t('«READY» на смене трека'), $t('Мигает над обложкой полторы секунды'), true]] },
  { id: 'metal', title: $t('Мелодик-дэт'), desc: $t('Финский мелодик-дэт нулевых: хром, ночной лес у озера, холодный туман, острые как лезвие линии'),
    opts: [['fog', $t('Туман'), $t('Медленно плывёт над лесом'), true], ['reflect', $t('Отражение'), $t('Спектр отражается в «озере»'), true]] },
];
const VALID = new Set(SKINS.map((s) => s.id));
export const state = () => store('skin', { id: 'none', opt: {} });
export const optOn = (skin, key) => { const s = SKINS.find((x) => x.id === skin); const o = state().opt || {}; const d = s?.opts?.find((x) => x[0] === key); return o[key] === undefined ? (d ? d[3] : true) : !!o[key]; };

let cur = null;   // { id, rt, mod }
const linkOf = () => document.getElementById('skinCss');

function loadCss(id) {
  return new Promise((res) => {
    let l = linkOf();
    const href = new URL(`../../css/skins/${id}.css`, import.meta.url).href;
    if (l && l.href === href) { res(); return; }   // already there (applied before first paint by skin-boot.js)
    const nl = document.createElement('link');
    nl.rel = 'stylesheet'; nl.href = href; nl.id = 'skinCss';
    l?.removeAttribute('id');
    nl.onload = nl.onerror = () => { l?.remove(); res(); };     // the old skin stays until the new one is ready: no unstyled flash
    document.head.appendChild(nl);
  });
}
function clearRoot() {
  const r = document.documentElement;
  delete r.dataset.skin;
  for (const k of Object.keys(r.dataset)) if (k.startsWith('skinOpt')) delete r.dataset[k];
}
function teardown() {
  if (!cur) return;
  try { cur.mod?.stop?.(); } catch (e) { console.warn('[skin] stop', e); }
  cur.rt.dispose();
  Viz.painters.spectrum = Viz.painters.wave = Viz.painters.colors = Viz.painters.beat = null;
  cur = null;
}

export async function apply(id, { persist = true } = {}) {
  if (!VALID.has(id)) id = 'none';
  teardown();
  if (persist) { const s = state(); s.id = id; s.save(true); }
  if (id === 'none') { linkOf()?.remove(); clearRoot(); Viz.repaint(); App.refreshSpectrum(); return; }
  await loadCss(id);
  if (!isEnabled()) return;
  const r = document.documentElement;
  clearRoot();
  r.dataset.skin = id;
  const s = SKINS.find((x) => x.id === id);
  for (const [k] of s.opts || []) r.dataset['skinOpt' + k[0].toUpperCase() + k.slice(1)] = optOn(id, k) ? '1' : '0';
  const rt = runtime('skin:' + id);
  cur = { id, rt, mod: null };
  try {
    const mod = await import(`./skins/${id}.js`);
    if (!cur || cur.rt !== rt) return;                 // switched again while loading
    cur.mod = mod;
    await mod.start(rt, (k) => optOn(id, k));
  } catch (e) { console.warn('[skin] start', id, e); }
  Viz.repaint(); App.refreshSpectrum();
  emit('skin', { id });
}
export async function setOpt(key, on) {
  const s = state(); s.opt = { ...(s.opt || {}), [key]: !!on }; s.save(true);
  if (cur) await apply(cur.id);
}
export const current = () => cur?.id || 'none';
export async function start() { await apply(state().id, { persist: false }); }
export function stop() { teardown(); linkOf()?.remove(); clearRoot(); Viz.repaint(); App.refreshSpectrum(); }
