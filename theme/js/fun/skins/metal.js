/* Gatefold · skin «Мелодик-дэт» — moonlit forest by a lake (per album), fog, blade spectrum mirrored in the water. */
import * as Viz from '../../viz.js';
import { color, onPalette, bgLayer, seeded, albumSeed, dropProbe } from './util.js';

function pine(x, base, h, w, rnd) {
  // a spiky fir: stacked jagged tiers, narrow trunk; drawn into the current path
  const tiers = 5 + Math.floor(rnd() * 4), top = base - h;
  x += (rnd() - 0.5) * 2;
  const pts = [[x, top]];
  for (let k = 1; k <= tiers; k++) {
    const t = k / tiers, y = top + h * 0.86 * t, half = w * (0.18 + 0.82 * t) / 2 * (0.85 + rnd() * 0.3);
    pts.push([x + half, y], [x + half * 0.38, y - h * 0.04]);
  }
  const right = pts.slice(1), left = right.map(([px, py]) => [2 * x - px, py]).reverse();
  const tw = Math.max(1.5, w * 0.06);
  const shape = [[x, top], ...right, [x + tw, top + h * 0.86], [x + tw, base], [x - tw, base], [x - tw, top + h * 0.86], ...left];
  return shape;
}
function fillShape(x, shape) { x.moveTo(shape[0][0], shape[0][1]); for (let i = 1; i < shape.length; i++) x.lineTo(shape[i][0], shape[i][1]); x.closePath(); }

export async function start(rt, opt) {
  const C = {};
  const read = () => { C.glow = color('var(--mg)'); C.glowD = color('var(--mg-d)'); C.glowL = color('var(--mg-l)'); C.sky = color('oklch(from var(--src-accent) 0.16 0.05 h)'); C.mist = color('oklch(from var(--src-accent) 0.32 0.05 h)'); C.halo = color('color-mix(in oklab, var(--mg) 20%, transparent)'); };
  read();

  const sky = document.createElement('canvas'); sky.className = 'mt-sky';
  document.getElementById('bg').prepend(sky); rt.cleanup(() => sky.remove());
  bgLayer(rt, 'mt-fog', '.veil'); bgLayer(rt, 'mt-fog f2', '.veil');

  const draw = () => {
    const W = 1440, H = Math.round(W * Math.min(0.75, Math.max(0.45, innerHeight / Math.max(1, innerWidth))));
    sky.width = W; sky.height = H;
    const x = sky.getContext('2d'), rnd = seeded(albumSeed()), hz = Math.round(H * 0.64);
    // sky
    let g = x.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, '#030407'); g.addColorStop(0.55, C.sky); g.addColorStop(1, C.mist);
    x.fillStyle = g; x.fillRect(0, 0, W, hz);
    // stars (sparse, cold)
    for (let i = 0; i < 140; i++) { x.globalAlpha = 0.15 + rnd() * 0.5; x.fillStyle = '#dfe6f0'; const s = rnd() < 0.08 ? 1.6 : 1; x.fillRect(rnd() * W, rnd() * hz * 0.7, s, s); }
    x.globalAlpha = 1;
    // moon + halo in the album colour
    const mx = W * (0.885 + rnd() * 0.05), my = H * (0.085 + rnd() * 0.03), mr = H * 0.04;
    g = x.createRadialGradient(mx, my, mr * 0.8, mx, my, mr * 7);
    g.addColorStop(0, 'rgba(225,232,245,.35)'); g.addColorStop(0.25, C.halo); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.globalAlpha = 0.9; x.fillStyle = g; x.fillRect(0, 0, W, hz); x.globalAlpha = 1;
    x.fillStyle = '#e9eef5'; x.beginPath(); x.arc(mx, my, mr, 0, Math.PI * 2); x.fill();
    x.fillStyle = 'rgba(150,160,180,.28)';
    for (let i = 0; i < 6; i++) { const a = rnd() * 6.28, r = rnd() * mr * 0.6; x.beginPath(); x.arc(mx + Math.cos(a) * r, my + Math.sin(a) * r, mr * (0.08 + rnd() * 0.16), 0, 7); x.fill(); }
    // thin clouds across the moon
    x.fillStyle = 'rgba(8,10,16,.55)';
    for (let i = 0; i < 4; i++) { x.beginPath(); x.ellipse(mx + (rnd() - 0.5) * mr * 6, my + (rnd() - 0.3) * mr * 2.2, mr * (2 + rnd() * 3), mr * (0.12 + rnd() * 0.12), 0, 0, 7); x.fill(); }
    // distant ridge of firs, lit by mist
    x.save(); x.filter = 'blur(1.2px)';
    x.fillStyle = C.mist; x.globalAlpha = 0.55; x.beginPath();
    for (let px = -10; px < W + 10; px += 7 + rnd() * 9) fillShape(x, pine(px, hz + 2, 18 + rnd() * 40, 12 + rnd() * 12, rnd));
    x.fill(); x.restore(); x.globalAlpha = 1;
    // lake: mirrored sky, darker
    g = x.createLinearGradient(0, hz, 0, H); g.addColorStop(0, C.mist); g.addColorStop(0.25, C.sky); g.addColorStop(1, '#020305');
    x.fillStyle = g; x.fillRect(0, hz, W, H - hz);
    // reflection of the ridge
    x.save(); x.translate(0, 2 * hz + 4); x.scale(1, -1); x.globalAlpha = 0.18; x.fillStyle = C.mist; x.filter = 'blur(2px)'; x.beginPath();
    const r2 = seeded(albumSeed());
    for (let px = -10; px < W + 10; px += 7 + r2() * 9) fillShape(x, pine(px, hz + 2, 18 + r2() * 40, 12 + r2() * 12, r2));
    x.fill(); x.restore();
    // moon path on the water
    for (let y = hz + 6; y < H; y += 3 + (y - hz) * 0.02) {
      const k = 1 - (y - hz) / (H - hz), w = mr * (0.6 + (1 - k) * 2.4) * (0.5 + rnd());
      x.globalAlpha = 0.08 + k * 0.35; x.fillStyle = rnd() < 0.3 ? C.glowL : '#dfe6f0';
      x.fillRect(mx - w / 2 + (rnd() - 0.5) * mr, y, w, 1.2);
    }
    x.globalAlpha = 1;
    // mist on the shoreline
    g = x.createLinearGradient(0, hz - 30, 0, hz + 30); g.addColorStop(0, 'rgba(200,210,230,0)'); g.addColorStop(0.5, 'rgba(200,210,230,.10)'); g.addColorStop(1, 'rgba(200,210,230,0)');
    x.fillStyle = g; x.fillRect(0, hz - 30, W, 60);
    // foreground firs framing the edges
    x.fillStyle = '#020304'; x.beginPath();
    for (let px = -40; px < W + 40; px += 14 + rnd() * 26) {
      const edge = Math.min(px, W - px) / (W / 2);                     // 0 at the edges → 1 in the middle
      if (edge > 0.42 && rnd() < 0.85) continue;
      const h = H * (0.25 + (1 - edge) * 0.75) * (0.6 + rnd() * 0.4);
      fillShape(x, pine(px, H + 4, h, h * (0.26 + rnd() * 0.1), rnd));
    }
    x.fill();
  };
  let rz = 0;
  rt.listen(window, 'resize', () => { clearTimeout(rz); rz = setTimeout(draw, 300); });
  rt.cleanup(() => clearTimeout(rz));

  // spectrum: blades rising from the waterline, mirrored below
  const reflect = opt('reflect');
  Viz.painters.spectrum = (c, w, h, bars, peaks, d) => {
    const n = bars.length; if (!n) return;
    const N = Math.max(24, Math.min(72, Math.floor(w / (9 * d)))), g = Math.max(1, Math.floor(n / N));
    const step = w / N, bw = step * 0.62, base = reflect ? Math.round(h * 0.74) : h;
    const path = new Path2D(), tips = new Path2D();
    for (let i = 0; i < N; i++) {
      let v = 0, p = 0; for (let j = i * g; j < Math.min(n, (i + 1) * g); j++) { v = Math.max(v, bars[j]); p = Math.max(p, peaks[j]); }
      const x0 = i * step + (step - bw) / 2, bh = Math.max(2 * d, v * (base - 4 * d));
      path.moveTo(x0, base); path.lineTo(x0 + bw / 2, base - bh); path.lineTo(x0 + bw, base); path.closePath();
      const py = base - Math.max(2 * d, p * (base - 4 * d)) - 3 * d;
      if (p > v + 0.02) { tips.moveTo(x0 + bw / 2, py - 2.5 * d); tips.lineTo(x0 + bw / 2 + 1.6 * d, py); tips.lineTo(x0 + bw / 2, py + 2.5 * d); tips.lineTo(x0 + bw / 2 - 1.6 * d, py); tips.closePath(); }
    }
    const gr = c.createLinearGradient(0, base, 0, 0);
    gr.addColorStop(0, C.glowD); gr.addColorStop(0.55, C.glow); gr.addColorStop(1, '#ffffff');
    c.save(); c.shadowColor = C.glow; c.shadowBlur = 10 * d; c.fillStyle = gr; c.fill(path); c.restore();
    c.fillStyle = '#e9eef5'; c.fill(tips);
    if (reflect) {
      c.save(); c.globalAlpha = 0.22; c.translate(0, base + 2 * d); c.scale(1, -(h - base - 2 * d) / base); c.translate(0, -base); c.fillStyle = gr; c.fill(path); c.restore();
      c.fillStyle = 'rgba(170,180,194,.35)'; c.fillRect(0, base, w, Math.max(1, d));
    }
  };
  // waveform: diamond blades
  Viz.painters.wave = {
    step: 4, bw: 3,
    bar: (c, x, mid, bw, h) => { const hh = Math.max(bw * 1.2, h); c.beginPath(); c.moveTo(x + bw / 2, mid - hh / 2); c.lineTo(x + bw, mid); c.lineTo(x + bw / 2, mid + hh / 2); c.lineTo(x, mid); c.closePath(); c.fill(); },
  };
  Viz.painters.colors = () => ({ a: C.glowL, b: C.glow, dim: 'rgba(170,180,194,.24)', text3: 'rgba(170,180,194,.45)' });

  onPalette(rt, () => { read(); draw(); Viz.repaint(); });
  rt.cleanup(dropProbe);
}
export function stop() {}
