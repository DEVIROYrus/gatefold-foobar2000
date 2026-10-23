/*
 * Gatefold · albumcolors.js — «Цвета альбома»: your colours for one album (or one edition of it).
 *
 * The colours Gatefold reads from a cover are usually right; sometimes the cover is mostly black with a
 * small red logo that is the album's real colour, or you simply see it differently. Here you pick the
 * accent (from the cover's own colours, or any colour) and, if you like, the background tint. They are
 * used wherever the album shows its colours — its page, and the whole interface while it plays
 * (with «Цвета интерфейса: из обложки»). Text stays readable whatever you pick: an accent too close to
 * the background is moved just enough to be seen, and the sheet says so.
 */
import { esc, albumKeyOf } from './bridge.js';
import { h, icon } from './ui.js';
import { settings, setSetting } from './settings.js';
import { $t } from './i18n.js';
import * as Theme from './theme.js';

let veil = null, S = null;
export const keyOf = (a) => a.edKey || albumKeyOf(a.albumArtist, a.name);
export const has = (a) => !!(settings.albumColors || {})[keyOf(a)];
export const events = new EventTarget();

export async function open(a) {
  S = { a, key: keyOf(a), ov: { ...((settings.albumColors || {})[keyOf(a)] || {}) }, token: (S ? S.token : 0) + 1 };
  if (!veil) build();
  const tk = S.token;
  veil.querySelector('.ac-body').innerHTML = `<div class="ac-head"><div class="kicker">${$t('Цвета альбома')}</div><h3>${esc(a.name)}</h3></div><div class="spinner"></div>`;
  requestAnimationFrame(() => veil.classList.add('on'));
  const { clusters } = await Theme.previewPalette(a, null);
  if (!S || S.token !== tk) return;
  S.clusters = clusters;
  render();
}
export function close() { if (veil) veil.classList.remove('on'); S = null; }

function build() {
  veil = h(`<div class="upd-veil ac-veil"><div class="upd-sheet ac-sheet" role="dialog" aria-modal="true" aria-label="${$t('Цвета альбома')}">
    <button class="icon-btn upd-x" title="${$t('Закрыть')}">${icon('x', 16)}</button><div class="ac-body"></div></div></div>`);
  document.body.append(veil);
  veil.addEventListener('click', (e) => { if (e.target === veil || e.target.closest('.upd-x')) close(); });
  addEventListener('keydown', (e) => { if (veil.classList.contains('on') && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
}

/* the cover's colours worth offering: accents are the colourful ones, backgrounds the dark (or light) ones */
const swatches = (clusters, kind) => {
  const seen = new Set();
  return clusters
    .filter((c) => (kind === 'accent' ? c.C > 0.03 && c.L > 0.2 && c.L < 0.95 : c.share > 0.02))
    .sort((x, y) => (kind === 'accent' ? y.C * Math.sqrt(y.share) - x.C * Math.sqrt(x.share) : y.share - x.share))
    .map(Theme.clusterHex).filter((x) => !seen.has(x) && seen.add(x)).slice(0, 7);
};

async function render() {
  if (!S) return;
  const { a, ov } = S;
  const tk = S.token;
  const { palette: p } = await Theme.previewPalette(a, ov.accent ? ov : null);
  if (!S || S.token !== tk) return;
  const fixed = Theme.fixedId();
  const row = (kind, title) => {
    const cur = ov[kind] || '';
    const sw = swatches(S.clusters, kind);
    return `<div class="ac-row" data-kind="${kind}"><div class="ac-rt">${title}</div><div class="ac-sw">
      <button class="ac-auto${cur ? '' : ' on'}" data-v="" aria-pressed="${!cur}">${$t('Из обложки')}</button>
      ${sw.map((x) => `<button class="ac-chip${cur.toLowerCase() === x ? ' on' : ''}" data-v="${x}" style="--c:${x}" title="${x}" aria-label="${x}" aria-pressed="${cur.toLowerCase() === x}"></button>`).join('')}
      <label class="ac-pick${cur && !sw.includes(cur.toLowerCase()) ? ' on' : ''}" title="${$t('Свой цвет')}"><input type="color" value="${esc(cur || (kind === 'accent' ? p.accent.hex : p.bg.hex))}">${icon('plus', 14)}<span>${$t('Свой')}</span></label>
    </div></div>`;
  };
  const moved = ov.accent && p.adjusted > 0.02;
  const pv = `--pv-bg:${p.bg.css};--pv-s:${p.surface2.css};--pv-t:${p.text.css};--pv-t3:${p.text3.css};--pv-a:${p.accent.css};--pv-on:${p.onAccent.css};--pv-g:${p.glow.css}`;
  veil.querySelector('.ac-body').innerHTML = `
    <div class="ac-head"><div class="kicker">${$t('Цвета альбома')}</div><h3>${esc(a.name)}${a.edition ? ` <span class="cp-ed">${esc(a.edition)}</span>` : ''}</h3><div class="sub">${esc(a.artist || a.albumArtist || '')}</div></div>
    <div class="ac-pv" style="${pv}" aria-hidden="true">
      <div class="ac-pv-side"><i></i><i></i><i></i></div>
      <div class="ac-pv-main"><b>${esc(a.name)}</b><span>${esc(a.artist || a.albumArtist || '')}</span>
        <div class="ac-pv-bar"><i style="width:42%"></i></div><div class="ac-pv-btns"><em>${icon('play', 12)}</em><u></u><u></u></div></div>
    </div>
    ${row('accent', $t('Акцент'))}
    ${ov.accent ? row('bg', $t('Фон')) : ''}
    <div class="ac-note${moved ? ' warn' : ''}">${moved ? icon('info', 14) + $t('Цвет чуть изменён, чтобы оставаться заметным на фоне') : ''}${ov.accent ? `<span class="dim">${$t('Контраст {0}:1', p.accentContrast.toFixed(1))}</span>` : `<span class="dim">${$t('Цвета подобраны по обложке. Выберите акцент, чтобы задать свои.')}</span>`}</div>
    ${fixed ? `<div class="ac-note">${icon('info', 14)}${$t('Сейчас включена постоянная тема: свои цвета альбома видны, когда в «Оформлении» выбраны цвета из обложки')}</div>` : ''}
    <div class="ac-acts"><button class="btn sm" data-act="reset"${has(a) ? '' : ' disabled'}>${$t('Сбросить')}</button><span class="grow"></span><button class="btn sm primary" data-act="done">${$t('Готово')}</button></div>`;
  const body = veil.querySelector('.ac-body');
  body.querySelectorAll('.ac-row').forEach((r) => {
    const kind = r.dataset.kind;
    r.querySelectorAll('button[data-v]').forEach((b) => { b.onclick = () => set(kind, b.dataset.v); });
    const inp = r.querySelector('input[type=color]');
    let t = 0;
    inp.oninput = () => { clearTimeout(t); t = setTimeout(() => set(kind, inp.value), 60); };
  });
  body.querySelector('[data-act=reset]').onclick = () => { S.ov = {}; save(); render(); };
  body.querySelector('[data-act=done]').onclick = close;
}

function set(kind, v) {
  if (!S) return;
  if (v) S.ov[kind] = v.toLowerCase(); else delete S.ov[kind];
  if (!S.ov.accent) delete S.ov.bg;                 // a background tint only goes with your accent
  save(); render();
}
function save() {
  const all = { ...(settings.albumColors || {}) };
  if (S.ov.accent) all[S.key] = { ...S.ov }; else delete all[S.key];
  setSetting('albumColors', all);
  Theme.reapply();
  events.dispatchEvent(new CustomEvent('change', { detail: { key: S.key, album: S.a } }));
}
