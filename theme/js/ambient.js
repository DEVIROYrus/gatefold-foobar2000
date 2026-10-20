/*
 * Gatefold · ambient.js — the drifting colour blobs behind the interface, drawn cheaply.
 *
 * They used to be four screen-sized CSS layers animated at 60 frames a second: the GPU blended
 * ~9 megapixels (plus the grain's overlay blend on top) every frame, all the time, for a motion
 * of a few pixels a second. Now the four soft gradients are painted into one small canvas — a
 * quarter of the window's size, scaled up (a soft gradient loses nothing): every frame of the
 * monitor with «Smoothness: as the monitor», 12 times a second with «economical». Still while
 * «Background motion» is off, stopped while the window is hidden.
 */
import { settings } from './settings.js';

const FPS = 12, SCALE = 0.25;
/* the CSS this replaces: size 78vmax; start offsets; drift (translate, scale) over a period, alternating */
const BLOBS = [
  { x: (w, h, m) => -24 * m, y: (w, h, m) => -30 * m, dx: 14, dy: 10, s: 1.15, T: 46, a: 0.62 },
  { x: (w, h, m) => w + 30 * m - 78 * m, y: (w, h, m) => -18 * m, dx: -12, dy: 14, s: 0.9, T: 58, a: 0.62 },
  { x: (w, h, m) => 8 * m, y: (w, h, m) => h + 44 * m - 78 * m, dx: 16, dy: -12, s: 1.1, T: 64, a: 0.62 },
  { x: (w, h, m) => w + 18 * m - 78 * m, y: (w, h, m) => h + 36 * m - 78 * m, dx: -14, dy: -8, s: 1.2, T: 52, a: 0.5 },
];
/* var(--ease) = cubic-bezier(.22, .7, .18, 1) */
function ease(t) {
  const x1 = 0.22, y1 = 0.7, x2 = 0.18, y2 = 1;
  const bx = (u) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const by = (u) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (bx(m) < t) lo = m; else hi = m; }
  return by((lo + hi) / 2);
}

let canvas = null, ctx = null, timer = 0, t0 = performance.now();
const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
const rgbCache = new Map();
function rgb(css) {
  let v = rgbCache.get(css);
  if (!v) {
    probe.clearRect(0, 0, 1, 1); probe.fillStyle = '#000'; probe.fillStyle = css; probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data; v = [d[0], d[1], d[2]];
    if (rgbCache.size > 200) rgbCache.clear();
    rgbCache.set(css, v);
  }
  return v;
}

function draw() {
  const W = innerWidth, H = innerHeight, m = Math.max(W, H) / 100;
  const cw = Math.max(32, Math.round(W * SCALE)), ch = Math.max(32, Math.round(H * SCALE));
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const cs = getComputedStyle(document.documentElement);
  const moving = !document.body.classList.contains('no-motion');
  const t = moving ? (performance.now() - t0) / 1000 : 0;
  ctx.clearRect(0, 0, cw, ch);
  BLOBS.forEach((b, i) => {
    const ph = (t / b.T) % 2, k = ease(ph < 1 ? ph : 2 - ph);            // alternate: there and back
    const r = 39 * m * (1 + (b.s - 1) * k);
    const cx = b.x(W, H, m) + 39 * m + b.dx * m * k, cy = b.y(W, H, m) + 39 * m + b.dy * m * k;
    const [R, G, B] = rgb(cs.getPropertyValue(`--blob-${i + 1}`).trim() || '#333');
    const g = ctx.createRadialGradient(cx * SCALE, cy * SCALE, 0, cx * SCALE, cy * SCALE, r * SCALE);
    g.addColorStop(0, `rgba(${R},${G},${B},${b.a})`);
    g.addColorStop(1, `rgba(${R},${G},${B},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
  });
}
function tick() {
  timer = 0;
  if (!canvas) return;
  const body = document.body;
  if (document.hidden || body.classList.contains('paused-bg') || body.classList.contains('no-ambient')) { timer = setTimeout(tick, 1000); return; }
  draw();
  // still: only colour changes (the palette crossfade) need repainting, 4 times a second is plenty
  if (body.classList.contains('no-motion')) timer = setTimeout(tick, 250);
  else if (settings.motionFps === 'eco') timer = setTimeout(tick, 1000 / FPS);
  else timer = requestAnimationFrame(tick);
}

export function init() {
  const host = document.querySelector('#bg .aurora');
  if (!host || canvas) return;
  canvas = document.createElement('canvas');
  canvas.className = 'aurora-c';
  ctx = canvas.getContext('2d', { alpha: true });
  host.replaceChildren(canvas);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !timer) tick(); });
  addEventListener('resize', () => { if (canvas) draw(); });
  tick();
}
