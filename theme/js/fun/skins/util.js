/* Gatefold · fun/skins/util.js — helpers shared by the skin scripts. */
import * as Theme from '../../theme.js';
import * as App from '../../app.js';
import { fetchArt } from '../../artbytes.js';

/** Resolve any CSS colour expression (custom properties, relative colours, color-mix) to a canvas-usable string. */
let probe = null;
export function color(expr) {
  if (!probe) { probe = document.createElement('i'); probe.style.cssText = 'position:fixed;width:0;height:0;visibility:hidden;pointer-events:none'; document.documentElement.appendChild(probe); }
  probe.style.color = ''; probe.style.color = expr;
  return getComputedStyle(probe).color || '#888';
}
export function dropProbe() { probe?.remove(); probe = null; }

/** Parse a computed colour (rgb()/oklch()/…) into [r, g, b] 0–255 via a 1×1 canvas. */
const one = (() => { let c = null; return () => c || (c = document.createElement('canvas').getContext('2d', { willReadFrequently: true })); })();
export function rgb(expr) {
  const x = one(); x.clearRect(0, 0, 1, 1); x.fillStyle = '#000'; x.fillStyle = color(expr); x.fillRect(0, 0, 1, 1);
  const d = x.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]];
}

/** Call fn now and whenever the album palette changes (after the 1.1 s colour transition settles). */
export function onPalette(rt, fn, settle = 1250) {
  let t = 0;
  const run = () => { clearTimeout(t); t = setTimeout(() => rt.alive() && fn(), settle); };
  fn();
  rt.cleanup(Theme.onPalette(run));
  rt.cleanup(() => clearTimeout(t));
}

/** <svg><defs> owned by a skin. */
export function defs(rt, markup) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', '0'); s.setAttribute('height', '0'); s.setAttribute('aria-hidden', 'true');
  s.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  s.innerHTML = `<defs>${markup}</defs>`;
  document.body.appendChild(s); rt.cleanup(() => s.remove());
  return s;
}

/** An element inside #bg (above the colour, below the veil). */
export function bgLayer(rt, cls, before = '.veil') {
  const bg = document.getElementById('bg');
  const e = document.createElement('div'); e.className = cls;
  bg.insertBefore(e, bg.querySelector(before)); rt.cleanup(() => e.remove());
  return e;
}

export function seeded(str) {
  let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1e6) / 1e6; };
}
export const albumSeed = () => { const t = App.player().track; return (t && (t.albumArtist || t.artist || '') + '|' + (t.album || '')) || 'aurora'; };

/** Current cover as an ImageBitmap of size×size (null when there is no art). */
export async function coverBitmap(size) {
  const u = App.player().art?.url; if (!u) return null;
  try {
    const r = await fetchArt(u, { priority: 'normal' });
    if (!r || !r.blob) return null;
    return await createImageBitmap(r.blob, { resizeWidth: size, resizeHeight: size, resizeQuality: 'medium' });
  } catch {
    try {   // same-origin / test URLs
      const b = await (await fetch(u)).blob();
      return await createImageBitmap(b, { resizeWidth: size, resizeHeight: size, resizeQuality: 'medium' });
    } catch { return null; }
  }
}

/** Re-run fn when the displayed cover changes (cheap poll of one string; the bridge has no "art ready" event). */
export function onCover(rt, fn) {
  let last = null;
  const tick = () => { const u = App.player().art?.url || ''; if (u !== last) { last = u; fn(u); } };
  tick(); rt.every(700, tick);
}
