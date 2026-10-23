/*
 * Gatefold · ambient.js — the drifting colour blobs behind the interface, drawn cheaply.
 *
 * They used to be four screen-sized CSS layers animated at 60 frames a second: the GPU blended
 * ~9 megapixels (plus the grain's overlay blend on top) every frame, all the time, for a motion
 * of a few pixels a second. Now the four soft gradients are painted into one small canvas — a
 * quarter of the window's size, scaled up (a soft gradient loses nothing): every frame of the
 * monitor with «Smoothness: as the monitor», 12 times a second with «economical». Still while
 * «Background motion» is off, stopped while the window is hidden.
 *
 * Sharp text (Settings → Look → «Sharpest text», on by default): Chromium draws text with ClearType
 * only into an opaque layer. A live background is a layer of its own, so everything above it goes
 * into a transparent layer and gets grey antialiasing — soft on a 96–120 dpi monitor. So on every
 * screen but Now Playing the background stands still: once a change of colours or cover has faded
 * in, the cover art, the blobs, the veil and the grain are painted into one opaque picture that
 * becomes the page's own background, and the live layers go away. It looks the same; the text is
 * crisp. (With Mica the window itself is transparent, so this cannot apply.)
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

let canvas = null, ctx = null, timer = 0, clock = 0, last = performance.now();
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
  const t = moving ? clock / 1000 : 0;
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
  const now = performance.now();
  if (!stillOn) clock += Math.min(now - last, 250);       // the drift pauses while the background stands still
  last = now;
  if (stillOn) { timer = setTimeout(tick, 1000); return; }
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
  addEventListener('resize', () => { if (canvas) draw(); if (stillOn || stillWanted()) { clearTimeout(resizeT); resizeT = setTimeout(() => schedule(0), 300); } });
  // a new cover fades in on the backdrop: live while it fades, still again after
  for (const el of document.querySelectorAll('#bg .bg-art')) new MutationObserver(() => changed()).observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
  tick();
  schedule(0);
}

/* ---------------------------------------------------------------- the still background */
let stillOn = false, stillView = true, stillT = 0, resizeT = 0, stillUrl = '', grainImg = null, token = 0;
const root = document.documentElement;
const stillWanted = () => settings.crispText !== false && stillView && !root.classList.contains('mica') && !document.body.classList.contains('paused-bg');
const settleMs = () => {
  const tx = parseFloat(getComputedStyle(root).getPropertyValue('--tx')) || 1100;
  return Math.round(tx * 1.6 + 120);                    // the cover crossfade lasts --tx × 1.4
};
function setStill(on) {
  if (stillOn === on) return;
  stillOn = on;
  root.classList.toggle('still-bg', on);
  if (!on && !timer) tick();
}
function schedule(ms = settleMs()) {
  clearTimeout(stillT);
  if (!canvas) return;
  if (!stillWanted()) { setStill(false); return; }
  const my = ++token;
  stillT = setTimeout(async () => {
    if (my !== token || !stillWanted()) return;
    const url = await renderStill().catch(() => '');
    if (my !== token || !url || !stillWanted()) return;
    const old = stillUrl; stillUrl = url;
    root.style.setProperty('--still', `url("${url}")`);
    setStill(true);
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
  }, ms);
}
/** colours or the cover changed: show the live background while they fade, then stand still again */
export function changed() {
  if (!canvas) return;
  if (stillOn) setStill(false);
  schedule();
}
/** the screen shown: Now Playing keeps the live background, every other screen the still one */
export function setView(view) {
  const want = view !== 'now';
  if (want === stillView && (stillOn || !want)) return;
  stillView = want;
  if (!want) { token++; clearTimeout(stillT); setStill(false); } else schedule(0);
}
/** a setting that affects it changed (sharp text, Mica, ambient) */
export function refresh() { if (stillOn) setStill(false); schedule(0); }

const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const urlOf = (el) => { const m = String(el && el.style.backgroundImage || '').match(/url\(["']?(.*?)["']?\)/); return m ? m[1] : ''; };
/** #bg painted into one opaque picture (what the live layers show, frozen) → an object URL */
async function renderStill() {
  const W = Math.max(64, innerWidth), H = Math.max(64, innerHeight);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { alpha: false });
  const cs = getComputedStyle(root);
  const [bR, bG, bB] = rgb(cs.getPropertyValue('--bg').trim() || '#111');
  const bga = (a) => `rgba(${bR},${bG},${bB},${a})`;
  x.fillStyle = bga(1); x.fillRect(0, 0, W, H);
  const light = root.dataset.scheme === 'light';
  if (!document.body.classList.contains('no-ambient')) {
    // the blurred cover: background-size cover over inset −6 %
    const art = document.querySelector('#bg .bg-art.on'), src = urlOf(art);
    if (src) {
      try {
        const im = await loadImg(src);
        const bx = -0.06 * W, by = -0.06 * H, bw = W * 1.12, bh = H * 1.12;
        const sc = Math.max(bw / im.naturalWidth, bh / im.naturalHeight), dw = im.naturalWidth * sc, dh = im.naturalHeight * sc;
        x.globalAlpha = light ? 0.5 : 0.62;
        x.imageSmoothingQuality = 'high';
        x.drawImage(im, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
        x.globalAlpha = 1;
      } catch {}
    }
    draw();                                               // the blobs, as they stand now
    x.drawImage(canvas, 0, 0, W, H);
  }
  // the veil: radial-gradient(120% 90% at 30% 20%, transparent, bg 55% at 70%) + linear 180deg bg 20% → 70%
  x.save(); x.translate(W * 0.3, H * 0.2); x.scale(W * 1.2, H * 0.9);
  const rg = x.createRadialGradient(0, 0, 0, 0, 0, 1);
  rg.addColorStop(0, bga(0)); rg.addColorStop(0.7, bga(0.55)); rg.addColorStop(1, bga(0.55));
  x.fillStyle = rg; x.fillRect(-2, -2, 4, 4); x.restore();
  const lg = x.createLinearGradient(0, 0, 0, H);
  lg.addColorStop(0, bga(0.2)); lg.addColorStop(1, bga(0.7));
  x.fillStyle = lg; x.fillRect(0, 0, W, H);
  // the grain (overlay), which keeps large dark gradients from banding
  const gsrc = urlOf(document.querySelector('#bg .grain'));
  if (gsrc) {
    try {
      grainImg = grainImg && grainImg.src === gsrc ? grainImg : await loadImg(gsrc);
      x.globalCompositeOperation = 'overlay'; x.globalAlpha = light ? 0.05 : 0.07;
      x.fillStyle = x.createPattern(grainImg, 'repeat'); x.fillRect(0, 0, W, H);
      x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
    } catch {}
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  return blob ? URL.createObjectURL(blob) : '';
}
