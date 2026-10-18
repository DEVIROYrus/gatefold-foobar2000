/* Gatefold · fun/kit.js — modal window shared by the panel and the trophy room. */
import { html, esc } from './core.js';

import { $t } from '../i18n.js';
/** opts: { title, body (html|Element), cls, onClose, actions:[{label, fn, primary}] } — fn returning false keeps it open */
export function modal(opts) {
  const back = html(`<div class="fun-modal-back ${opts.cls || ''}"><div class="fun-modal" role="dialog" aria-modal="true">
    ${opts.title ? `<div class="fun-modal-h"><b>${esc(opts.title)}</b><button class="fun-x" aria-label="${$t('Закрыть')}"><svg width="16" height="16"><use href="#i-x"/></svg></button></div>` : ''}
    <div class="fun-modal-b"></div><div class="fun-modal-a"></div></div></div>`);
  const body = back.querySelector('.fun-modal-b');
  if (typeof opts.body === 'string') body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
  const acts = back.querySelector('.fun-modal-a');
  let closed = false;
  const close = (why) => {
    if (closed) return; closed = true;
    removeEventListener('keydown', onKey, true);
    back.classList.add('out'); setTimeout(() => back.remove(), 200);
    opts.onClose && opts.onClose(why);
  };
  for (const a of opts.actions || []) {
    const b = html(`<button class="btn${a.primary ? ' primary' : ''}">${esc(a.label)}</button>`);
    b.onclick = () => { const r = a.fn ? a.fn() : undefined; if (r !== false) close('action'); };
    acts.appendChild(b);
  }
  if (!acts.children.length) acts.remove();
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close('key'); } };
  addEventListener('keydown', onKey, true);
  back.querySelector('.fun-x')?.addEventListener('click', () => close('x'));
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close('outside'); });
  document.body.appendChild(back);
  return { el: back, body, close };
}
