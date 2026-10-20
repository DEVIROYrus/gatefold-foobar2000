// overlap-audit.js — evaluated by tests/e2e.py (test_layout): text over text, text out of its box,
// text cut without an ellipsis, controls over controls or text. Returns a list of findings.
(() => {
  const vis = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; } return true; };
  const label = (e) => (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') || e.tagName;
  const items = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!n.nodeValue.trim()) continue; const el = n.parentElement; if (!el || !vis(el) || el.closest('#layer, .toast, svg, script, style, [aria-hidden=true]')) continue;
    const rg = document.createRange(); rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) if (r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) items.push({ el, r, t: n.nodeValue.trim().slice(0, 30) });
  }
  const out = [];
  // 1. text over text
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j]; if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (!(x > 2 && y > 3)) continue;
    // both must actually paint there: the topmost element at the spot is one of them, and nothing
    // opaque between it and their common ancestor hides the other
    const px = Math.max(a.r.left, b.r.left) + x / 2, py = Math.max(a.r.top, b.r.top) + y / 2;
    const top = document.elementFromPoint(px, py); if (!top) continue;
    const topIsA = a.el.contains(top) || top.contains(a.el), topIsB = b.el.contains(top) || top.contains(b.el);
    if (!topIsA && !topIsB) continue;
    const upper = topIsA ? a.el : b.el, lower = topIsA ? b.el : a.el;
    let hidden = false;
    for (let e = upper; e && !e.contains(lower); e = e.parentElement) { const s = getComputedStyle(e); const bg = s.backgroundColor; if ((bg !== 'rgba(0, 0, 0, 0)' && !/, 0\)$/.test(bg)) || s.backgroundImage !== 'none' || s.backdropFilter !== 'none') { hidden = true; break; } }
    if (hidden) continue;
    // clipped away by a scrolling ancestor?
    const clipped = (el, X, Y) => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.overflow !== 'visible') { const q = e.getBoundingClientRect(); if (X < q.left || X > q.right || Y < q.top || Y > q.bottom) return true; } } return false; };
    if (clipped(a.el, px, py) || clipped(b.el, px, py)) continue;
    if (x > 2 && y > 3) out.push(`text over text: "${a.t}" (${label(a.el)}) × "${b.t}" (${label(b.el)})`);
  }
  // 2. text sticking out of its box (a box = nearest ancestor with a background, border or clipping)
  for (const it of items) {
    let box = it.el;
    for (; box && box !== document.body; box = box.parentElement) { const s = getComputedStyle(box); if (s.overflow !== 'visible' || s.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(s.borderTopWidth) > 0 || s.backgroundImage !== 'none') break; }
    if (!box || box === document.body) continue;
    const b = box.getBoundingClientRect(), s = getComputedStyle(box);
    if (s.overflow !== 'visible') continue;   // clipped: it cannot paint outside
    if (it.r.right > b.right + 1.5 || it.r.left < b.left - 1.5 || it.r.bottom > b.bottom + 1.5 || it.r.top < b.top - 1.5) out.push(`text out of its box: "${it.t}" (${label(it.el)}) in ${label(box)}`);
  }
  // 3. text cut by its own box without an ellipsis
  for (const it of items) {
    const s = getComputedStyle(it.el);
    if (it.el.scrollWidth > it.el.clientWidth + 2 && s.overflow !== 'visible' && s.textOverflow !== 'ellipsis' && it.el.clientWidth > 0 && !/auto|scroll/.test(s.overflowX)) out.push(`text cut: "${it.t}" (${label(it.el)})`);
  }
  // 4. controls over controls or over text (an icon button on top of a label, two buttons crossing)
  const ctl = [...document.querySelectorAll('button, input, select, textarea, a[href], [role=button], .chip')].filter((e) => vis(e) && !e.closest('#layer, .toast'))
    .map((e) => ({ el: e, r: e.getBoundingClientRect() })).filter((c) => c.r.width > 2 && c.r.height > 2 && c.r.bottom > 0 && c.r.top < innerHeight && c.r.right > 0 && c.r.left < innerWidth);
  const hitBoth = (a, b, ra, rb) => {
    const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (!(x > 3 && y > 3)) return false;
    const px = Math.max(ra.left, rb.left) + x / 2, py = Math.max(ra.top, rb.top) + y / 2;
    for (const el of [a, b]) for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.overflow !== 'visible') { const q = e.getBoundingClientRect(); if (px < q.left || px > q.right || py < q.top || py > q.bottom) return false; } }
    const top = document.elementFromPoint(px, py); if (!top) return false;
    const ta = a.contains(top), tb = b.contains(top); if (!ta && !tb) return false;
    // layers meant to sit on top (dialogs, the player bar, sticky headers) are not overlaps
    const root = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') return e; } return document.body; };
    return root(a) === root(b);
  };
  for (let i = 0; i < ctl.length; i++) {
    for (let j = i + 1; j < ctl.length; j++) { const a = ctl[i], b = ctl[j]; if (a.el.contains(b.el) || b.el.contains(a.el)) continue; if (hitBoth(a.el, b.el, a.r, b.r)) out.push(`control over control: ${label(a.el)} × ${label(b.el)}`); }
    for (const it of items) { const a = ctl[i]; if (a.el.contains(it.el) || it.el.contains(a.el)) continue; if (hitBoth(a.el, it.el, a.r, it.r)) out.push(`control over text: ${label(a.el)} × "${it.t}" (${label(it.el)})`); }
  }
  return [...new Set(out)];
})()
