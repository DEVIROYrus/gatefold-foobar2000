/*
 * Gatefold · tooltip.js — the theme's own tooltips.
 *
 * Native `title` tooltips are drawn by the WebView host. Inside foobar2000's composited,
 * frameless window they appear away from the cursor and get cut off at the window edge.
 * This module takes over every `title` in the page: the attribute moves to `data-tip` as soon
 * as the pointer reaches the element (or the moment code changes it), so the native tooltip
 * never shows, and a styled tooltip is positioned next to the element, kept inside the window.
 * Icon-only buttons keep an accessible name: the title becomes their aria-label when they have none.
 * In the collapsed sidebar the items are bare icons, so their own labels become tooltips there.
 */
// the page is in the interface language before any title is taken over (i18n.js loads the
// language with a top-level await, so a module that does not import it could run first)
import './i18n-boot.js';

const DELAY = 450, QUICK = 60, GAP = 8, EDGE = 8;
let tip = null, cur = null, showT = 0, lastHide = 0;

function ensure() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'gf-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  return tip;
}

const AUTO = 'body.side-collapsed #sidebar .nav-item, body.side-collapsed #sidebar .upd-pill';
const words = (n) => (n ? (n.children.length ? [...n.children].map((c) => c.textContent).join(' ') : n.textContent) : '').replace(/\s+/g, ' ').trim();
const textOf = (el) => el.dataset.tip || (el.matches(AUTO) ? words(el.querySelector('span:not(.upd-dot)')) : '');

function stash(el) {
  const t = el.getAttribute('title');
  if (t == null) return;
  el.removeAttribute('title');
  if (t) {
    el.dataset.tip = t;
    if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t);
  } else delete el.dataset.tip;
  if (el === cur && tip && tip.classList.contains('on')) { if (t) { tip.textContent = t; place(el); } else hide(true); }
}

function place(el) {
  const r = el.getBoundingClientRect();
  const W = innerWidth, H = innerHeight;
  tip.style.left = '0px'; tip.style.top = '0px';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  // below the element, or above when that would leave the window (player bar, bottom rows)
  let top = r.bottom + GAP, below = true;
  if (top + th > H - EDGE || r.top > H * 0.72) { top = r.top - GAP - th; below = false; }
  if (top < EDGE) { top = Math.min(H - th - EDGE, r.bottom + GAP); below = true; }
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(EDGE, Math.min(W - tw - EDGE, left));
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
  tip.dataset.side = below ? 'below' : 'above';
  // the little nose points at the element even when the bubble was pushed inside the window
  tip.style.setProperty('--nose', Math.round(Math.max(10, Math.min(tw - 10, r.left + r.width / 2 - left))) + 'px');
}

function show(el) {
  const text = el.isConnected && textOf(el);
  if (!text) return;
  ensure();
  tip.textContent = text;
  tip.classList.remove('on');
  place(el);
  requestAnimationFrame(() => tip.classList.add('on'));
}

function hide(now) {
  clearTimeout(showT);
  if (tip && tip.classList.contains('on')) lastHide = performance.now();
  if (tip) tip.classList.remove('on');
  cur = null;
  if (now && tip) tip.style.top = '-999px';
}

document.addEventListener('pointerover', (e) => {
  const el = e.target && e.target.closest ? e.target.closest('[title], [data-tip]') || e.target.closest(AUTO) : null;
  if (!el) return;
  stash(el);
  if (el === cur) return;
  hide();
  if (!textOf(el) || e.pointerType === 'touch') return;
  cur = el;
  showT = setTimeout(() => { if (cur === el) show(el); }, performance.now() - lastHide < 400 ? QUICK : DELAY);
}, true);
document.addEventListener('pointerout', (e) => {
  if (cur && !(e.relatedTarget && cur.contains(e.relatedTarget))) hide();
}, true);
for (const ev of ['pointerdown', 'wheel', 'keydown']) document.addEventListener(ev, () => hide(true), true);
addEventListener('scroll', () => hide(true), true);
addEventListener('blur', () => hide(true));

// a title set or changed by code while the page runs is taken over at once
new MutationObserver((list) => { for (const m of list) if (m.target.nodeType === 1 && m.target.hasAttribute('title')) stash(m.target); })
  .observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['title'] });
// and everything already in the static markup
for (const el of document.querySelectorAll('[title]')) stash(el);
