(() => {
  const cv = document.createElement('canvas').getContext('2d');
  const out = [];
  const seen = new Set();
  const clipBox = (el) => {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible' || cs.webkitLineClamp !== 'none' && cs.webkitLineClamp) {
        const r = a.getBoundingClientRect();
        const bt = parseFloat(cs.borderTopWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
        // a scrolling container clips too, but its content is meant to scroll: only real clips count
        if (/auto|scroll/.test(cs.overflowY) && a.scrollHeight > a.clientHeight + 1) return null;
        return { el: a, top: r.top + bt, bottom: r.bottom - bb };
      }
    }
    return null;
  };
  const name = (el) => { const p = []; for (let a = el; a && p.length < 3 && a !== document.body; a = a.parentElement) p.unshift(a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (a.classList.length ? '.' + [...a.classList].slice(0, 2).join('.') : '')); return p.join(' > '); };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const text = n.nodeValue; if (!text || !text.trim()) continue;
    const el = n.parentElement; if (!el || !el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const clip = clipBox(el); if (!clip) continue;
    cv.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = cv.measureText(text.trim());
    const range = document.createRange(); range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.bottom < clip.top || r.top > clip.bottom) continue;           // a line not shown at all
      const base = r.bottom - m.fontBoundingBoxDescent;
      const inkTop = base - m.actualBoundingBoxAscent, inkBot = base + m.actualBoundingBoxDescent;
      const over = Math.max(clip.top - inkTop, inkBot - clip.bottom);
      // a line that is mostly inside but loses its accents or descenders
      if (over > 0.6 && r.bottom - 1 <= clip.bottom + (r.height * 0.5) && r.top + 1 >= clip.top - r.height * 0.5) {
        const key = name(el) + '|' + Math.round(over);
        if (seen.has(key)) continue; seen.add(key);
        out.push({ where: name(el), clip: clip.el === el ? 'self' : name(clip.el), text: text.trim().slice(0, 40), px: +over.toFixed(1), side: clip.top - inkTop > inkBot - clip.bottom ? 'top' : 'bottom', lh: cs.lineHeight, fs: cs.fontSize });
      }
    }
  }
  return out;
})()
