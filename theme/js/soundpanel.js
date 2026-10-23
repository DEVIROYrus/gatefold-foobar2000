/*
 * Gatefold · soundpanel.js — «Звук»: foobar2000's DSP from the player bar.
 *
 * foo_ui_webview2 lets a theme read the DSP chain and switch DSP presets, but not read or set the bands
 * of foobar2000's equalizer (its settings are private to the DSP). So the panel does what can be done
 * well today: one click between your DSP presets («Headphones», «Speakers», «Night» — saved in
 * foobar2000's DSP Manager), the chain that is playing now, and buttons that open foobar2000's own
 * equalizer and DSP Manager. Bands drawn in the theme need the component to expose DSP settings —
 * see docs/upstream/dsp-config-request.md.
 */
import { call, ok, on, esc, log } from './bridge.js';
import { h, icon, toast } from './ui.js';
import { $t } from './i18n.js';

const EQ = /equali[sz]er|эквалайзер|entzerrer|ecualizador|égaliseur|均衡/i;
const DSPM = /^dsp/i, PREFS = /pref|настро|einstell|config|ajust|параметр|设置|首选/i;
let pop = null, btn = null, menuCache = null;

/** the player-bar button: lit while a DSP chain is active */
export function init(button) {
  btn = button;
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (pop) close(); else open(); });
  on('audio:dspPresetChanged', () => { paintButton(); if (pop) render(); });
  paintButton();
}
async function state() {
  const [c, p] = await Promise.all([call('dsp.getChain'), call('dsp.getPresets')]);
  return {
    ok: ok(c) || ok(p),
    chain: ok(c) ? c.dsps || [] : [],
    active: ok(c) ? c.activePreset : null,
    presets: ok(p) ? p.presets || [] : [],
    selected: ok(p) ? p.selectedIndex : -1,
  };
}
async function paintButton() {
  if (!btn) return;
  const s = await state();
  btn.classList.toggle('on', s.chain.length > 0);
  const what = s.active || (s.chain.length ? s.chain.map((d) => d.name).join(' → ') : $t('без обработки'));
  btn.dataset.tip = `${$t('Звук')}: ${what}`;
  btn.setAttribute('aria-label', btn.dataset.tip);
}

export async function open() {
  close();
  pop = h(`<div class="menu snd-pop" role="dialog" aria-label="${$t('Звук')}"><div class="snd-body"><div class="spinner"></div></div></div>`);
  document.getElementById('layer').append(pop);
  place();
  setTimeout(() => { addEventListener('mousedown', outside, true); addEventListener('keydown', esc_, true); }, 0);
  await render();
}
export function close() {
  if (!pop) return;
  pop.remove(); pop = null;
  removeEventListener('mousedown', outside, true); removeEventListener('keydown', esc_, true);
}
const outside = (e) => { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(); };
const esc_ = (e) => { if (e.key === 'Escape' && pop) { e.stopPropagation(); e.preventDefault(); close(); } };
function place() {
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth, hh = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
  pop.style.top = Math.max(8, r.top - hh - 8) + 'px';
}

async function render() {
  if (!pop) return;
  const s = await state();
  if (!pop) return;
  const body = pop.querySelector('.snd-body');
  if (!s.ok) { body.innerHTML = `<div class="snd-h">${$t('Звук')}</div><div class="snd-empty">${$t('DSP недоступен в этой версии компонента')}</div>`; place(); return; }
  const presets = s.presets.length
    ? s.presets.map((p) => `<button class="mi snd-p${p.active || p.index === s.selected ? ' on' : ''}" data-i="${p.index}" role="menuitemradio" aria-checked="${!!(p.active || p.index === s.selected)}"><span class="chk">${p.active || p.index === s.selected ? '✓' : ''}</span><span>${esc(p.name)}</span></button>`).join('')
    : `<div class="snd-empty">${$t('Пресетов пока нет. Соберите цепочку в менеджере DSP foobar2000 и сохраните её как пресет — он появится здесь.')}</div>`;
  const chain = s.chain.length
    ? `<div class="snd-chain">${s.chain.map((d) => `<span class="chip">${esc(d.name)}</span>`).join('<span class="snd-arr">→</span>')}</div>`
    : `<div class="snd-empty">${$t('Цепочка пуста — звук идёт без обработки')}</div>`;
  body.innerHTML = `
    <div class="snd-h">${$t('Звук')}${s.active ? '' : s.chain.length ? `<small>${$t('своя цепочка')}</small>` : ''}</div>
    <div class="snd-sec">${$t('Пресет DSP')}</div>${presets}
    <div class="snd-sec">${$t('Сейчас играет через')}</div>${chain}
    <div class="ms"></div>
    <button class="mi" data-act="eq">${icon('sliders', 15)}<span>${$t('Эквалайзер foobar2000…')}</span></button>
    <button class="mi" data-act="dsp">${icon('gear', 15)}<span>${$t('Менеджер DSP…')}</span></button>`;
  body.querySelectorAll('.snd-p').forEach((b) => {
    b.onclick = async () => {
      const r = await call('dsp.applyPreset', { index: +b.dataset.i });
      if (!ok(r)) { toast(esc(r.error || $t('Не удалось включить пресет'))); return; }
      // the tick in the panel says it; no toast under the panel
      render(); paintButton();
    };
  });
  body.querySelector('[data-act=eq]').onclick = () => { close(); openEqualizer(); };
  body.querySelector('[data-act=dsp]').onclick = () => { close(); openDspManager(); };
  place();
}

/* foobar2000's own windows, found in its main menu by name (the GUIDs differ between versions and
   components; the labels are matched in several languages) */
async function commands() {
  if (menuCache) return menuCache;
  const r = await call('menu.getMainMenu', { withAvailability: false });
  const out = [];
  const walk = (items, trail) => { for (const it of items || []) { if (it.type === 'submenu') walk(it.children, [...trail, it.label || '']); else if (it.type === 'command') out.push({ ...it, trail }); } };
  if (ok(r)) walk(r.items, []);
  return (menuCache = out);
}
async function run(cmd) {
  const r = cmd.guid ? await call('menu.runMainMenuCommand', { command: cmd.guid, ...(cmd.subGuid ? { subGuid: cmd.subGuid } : {}) }) : await call('menu.runMainMenuCommand', { command: cmd.path });
  return ok(r);
}
export async function openEqualizer() {
  const list = await commands();
  const eq = list.find((c) => EQ.test(c.label || '') || EQ.test(c.displayLabel || ''));
  if (eq && (await run(eq))) return;
  log('sound: no equalizer command in the main menu');
  toast($t('В меню foobar2000 нет команды эквалайзера — открываю менеджер DSP: добавьте «Equalizer» в цепочку и настройте его там.'), { ms: 8000 });
  openDspManager();
}
export async function openDspManager() {
  const list = await commands();
  const m = list.find((c) => c.trail.some((t) => DSPM.test(t)) && PREFS.test(c.label || ''));
  if (m && (await run(m))) return;
  call('misc.showPreferences');
}
