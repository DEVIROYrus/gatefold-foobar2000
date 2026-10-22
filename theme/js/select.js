/*
 * Gatefold · select.js — the theme's own drop-down lists.
 *
 * A native <select> opens a list drawn by the WebView host. Inside foobar2000's composited,
 * frameless window that list appears away from the control and gets cut off (like the native
 * tooltips, see tooltip.js). Every <select> in the page is therefore shown as a button that opens
 * the theme's own menu; the <select> stays in the page, hidden, as the single source of truth:
 * code keeps reading and setting `.value` and listening for `change` as before.
 */
import './i18n-boot.js';          // labels are read from options already in the interface language
import { popupMenu } from './ui.js';

const CHEV = '<svg class="sel-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

function label(sel) {
  const o = sel.options[sel.selectedIndex];
  return o ? o.textContent : '';
}
function pick(sel, value) {
  if (sel.value === value) return;
  desc.set.call(sel, value);
  sel.__paint();
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

export function enhance(sel) {
  if (sel.__gfSelect || sel.multiple) return;
  sel.__gfSelect = true;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = sel.className + ' sel-btn';
  if (sel.id) btn.dataset.for = sel.id;
  const ariaLabel = sel.getAttribute('aria-label') || sel.title;
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.innerHTML = `<span class="sel-txt"></span>${CHEV}`;
  sel.__paint = () => { btn.querySelector('.sel-txt').textContent = label(sel); btn.disabled = sel.disabled; };
  sel.after(btn);
  sel.classList.add('sel-native');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');
  // code that sets .value keeps the button in step
  Object.defineProperty(sel, 'value', { configurable: true, get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); this.__paint(); } });
  new MutationObserver(() => sel.__paint()).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
  sel.__paint();

  const open = async () => {
    const r = btn.getBoundingClientRect();
    const items = [...sel.options].map((o) => ({ id: '\u0001' + o.value, label: o.textContent, checked: o.selected, disabled: o.disabled }));
    btn.classList.add('open');
    const id = await popupMenu(items, r.left, r.bottom + 4);
    btn.classList.remove('open');
    btn.focus();
    if (id != null) pick(sel, id.slice(1));
  };
  btn.addEventListener('click', open);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const i = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      pick(sel, sel.options[i].value);
    }
  });
}

/* every select already in the page, and every one added later */
function scan(root) {
  if (root.nodeType !== 1) return;
  if (root.tagName === 'SELECT') enhance(root);
  else root.querySelectorAll && root.querySelectorAll('select').forEach(enhance);
}
scan(document.body);
new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) scan(n); }).observe(document.body, { childList: true, subtree: true });
