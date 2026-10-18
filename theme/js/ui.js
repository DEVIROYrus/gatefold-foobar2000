/* Gatefold · ui.js — router, toasts, popup menus, small DOM helpers */
import { esc } from './bridge.js';

import { $t } from './i18n.js';
export const $ = (id) => document.getElementById(id);
export const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
export const icon = (name, size) => `<svg${size ? ` width="${size}" height="${size}"` : ''}><use href="#i-${name}"/></svg>`;

// ---------------------------------------------------------------- router
const handlers = new Map();
const stack = [], fwd = [];
const TITLES = { now: $t('Сейчас играет'), playlist: $t('Плейлист'), artists: $t('Исполнители'), library: $t('Альбомы'), queue: $t('Очередь'), search: $t('Поиск'), covers: $t('Обложки'), settings: $t('Настройки'), youtube: 'YouTube', liked: $t('Понравившиеся') };
const titleOf = ([v, a]) => (v === 'album' && a && a.name) ? a.name : (v === 'artist' && a) ? (typeof a === 'string' ? a : a.name || $t('Исполнитель')) : TITLES[v] || '';
export const router = {
  current: '',
  arg: null,
  on(view, fn) { handlers.set(view, fn); },
  go(view, arg, { push = true, keepFwd = false } = {}) {
    if (push && this.current && (this.current !== view || arg)) stack.push([this.current, this.arg]);
    if (push && !keepFwd) fwd.length = 0;
    if (stack.length > 40) stack.shift();
    this.current = view; this.arg = arg;
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    document.querySelectorAll('.nav-item[data-view]').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
    const fn = handlers.get(view);
    if (fn) fn(arg);
    for (const l of listeners) l(view, arg);
  },
  /** previous screen, or `fallback` when there is no history (e.g. an album opened straight from Now Playing) */
  back(fallback) {
    const p = stack.pop();
    if (p) { fwd.push([this.current, this.arg]); this.go(p[0], p[1], { push: false }); }
    else if (fallback && fallback !== this.current) this.go(fallback, null, { push: false });
  },
  forward() { const n = fwd.pop(); if (n) { stack.push([this.current, this.arg]); this.go(n[0], n[1], { push: false }); } },
  /** label for a «← …» button: where back() will lead */
  backLabel(fallback) { const p = stack[stack.length - 1]; return p ? titleOf(p) : (fallback ? TITLES[fallback] : ''); },
};
/** «← Альбомы» button for a page header; returns the element. */
export function backButton(fallback) {
  const label = router.backLabel(fallback) || $t('Назад');
  const b = h(`<button class="btn sm back-btn" title="${$t('Назад (Alt+←, Esc, боковая кнопка мыши)')}"><svg><use href="#i-back"/></svg><span></span></button>`);
  b.querySelector('span').textContent = label;
  b.onclick = () => router.back(fallback);
  return b;
}
const listeners = new Set();
export const onRoute = (fn) => listeners.add(fn);

// ---------------------------------------------------------------- toasts
export function toast(msg, { img = '', ms = 3600, action = null } = {}) {
  const el = h(`<div class="toast">${img ? `<img src="${esc(img)}" alt="">` : ''}<div style="flex:1">${msg}</div></div>`);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  if (action) {
    const b = h(`<button class="btn sm primary">${esc(action.label)}</button>`);
    b.onclick = () => { close(); action.fn(); };
    const x = h(`<button class="icon-btn" aria-label="${$t('Закрыть')}" style="width:28px;height:28px"><svg width="14" height="14"><use href="#i-x"/></svg></button>`);
    x.onclick = close;
    el.append(b, x);
  }
  $('toasts').appendChild(el);
  if (Number.isFinite(ms)) setTimeout(close, ms);
}

// ---------------------------------------------------------------- popup menu
// items: [{ id, label, checked, disabled, children:[…] } | { type: 'sep' }]
let openMenus = [];
export function closeMenus() { openMenus.forEach((m) => m.remove()); openMenus = []; }

export function popupMenu(items, x, y) {
  closeMenus();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeMenus(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); resolve(v); };
    const outside = (e) => { if (!openMenus.some((m) => m.contains(e.target))) finish(null); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } };
    const build = (list, px, py, depth, flipX = 0) => {
      openMenus.filter((m) => +m.dataset.depth >= depth).forEach((m) => m.remove());
      openMenus = openMenus.filter((m) => +m.dataset.depth < depth);
      const m = h('<div class="menu"></div>');
      m.dataset.depth = depth;
      list.forEach((it) => {
        if (it.type === 'sep') { m.appendChild(h('<div class="ms"></div>')); return; }
        const row = h(`<div class="mi${it.disabled ? ' dis' : ''}"><span class="chk">${it.checked ? '✓' : ''}</span><span>${esc(it.label)}</span>${it.children ? '<span class="arr">›</span>' : ''}</div>`);
        row.addEventListener('pointerenter', () => {
          m.querySelectorAll('.mi.hl').forEach((r) => r.classList.remove('hl'));
          if (it.children) { row.classList.add('hl'); const r = row.getBoundingClientRect(); build(it.children, r.right + 2, r.top - 5, depth + 1, m.getBoundingClientRect().left); }
          else openMenus.filter((mm) => +mm.dataset.depth > depth).forEach((mm) => { mm.remove(); openMenus = openMenus.filter((o) => o !== mm); });
        });
        if (!it.children) row.addEventListener('click', () => finish(it.id));
        m.appendChild(row);
      });
      $('layer').appendChild(m);
      openMenus.push(m);
      const r = m.getBoundingClientRect();
      const W = innerWidth, H = innerHeight;
      let lx = px, ly = py;
      if (lx + r.width > W - 6) lx = depth ? flipX - r.width - 2 : W - r.width - 6;
      if (ly + r.height > H - 6) ly = Math.max(6, H - r.height - 6);
      m.style.left = Math.max(6, lx) + 'px'; m.style.top = ly + 'px';
    };
    build(items, x, y, 0);
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true); }, 0);
  });
}

// ---------------------------------------------------------------- misc
const hash = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; };
/** Placeholder cover: deterministic two-hue gradient + initials. */
export function placeholder(name, artist) {
  const hh = hash((artist || '') + '|' + (name || '')) % 360;
  const ini = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '♪';
  return { bg: `linear-gradient(135deg, oklch(55% 0.13 ${hh}), oklch(32% 0.09 ${(hh + 50) % 360}))`, ini };
}

export function confirmInline(text) { return window.confirm ? window.confirm(text) : true; }
