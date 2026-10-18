/* Gatefold · skin «16 бит» — pixel cursor, dithered night city per album, 16-bit cover, READY, LED spectrum. */
import * as Viz from '../../viz.js';
import { router } from '../../ui.js';
import { color, rgb, onPalette, bgLayer, seeded, albumSeed, coverBitmap, onCover, dropProbe } from './util.js';

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** bitmap rows → crisp SVG data URI (horizontal runs merged) */
function bitmap(rows, pal, scale) {
  let rects = '';
  rows.forEach((r, y) => { for (let x = 0; x < r.length;) { const ch = r[x]; let n = 1; while (r[x + n] === ch) n++; if (pal[ch]) rects += `<rect x='${x}' y='${y}' width='${n}' height='1' fill='${pal[ch]}'/>`; x += n; } });
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${rows[0].length * scale}' height='${rows.length * scale}' viewBox='0 0 ${rows[0].length} ${rows.length}' shape-rendering='crispEdges'>${rects}</svg>`;
  return `url("data:image/svg+xml,${svg.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}")`;
}
const ARROW = ['B..........', 'BB.........', 'BWB........', 'BWWB.......', 'BWWWB......', 'BWWWWB.....', 'BWWWWWB....', 'BWWWWWWB...', 'BWWWWWWWB..', 'BWWWWWWWWB.',
  'BWWWWWBBBBB', 'BWWBWWB....', 'BWB.BWWB...', 'BB..BWWB...', 'B....BWWB..', '.....BWWB..', '......BB...'];
const GEM = ['..BBBB..', '.BCCWWB.', 'BCCWWCCB', 'BDCCCCCB', 'BDDCCCDB', '.BDDDDB.', '..BDDB..', '...BB...'];

export async function start(rt, opt) {
  const root = document.documentElement;
  root.style.setProperty('--px-cursor', `${bitmap(ARROW, { B: '#000', W: '#fff' }, 2)} 0 0, default`);
  root.style.setProperty('--px-gem', bitmap(GEM, { B: '#070818', C: '#58c8f8', W: '#f8f8f8', D: '#2858b8' }, 3));
  rt.cleanup(() => { root.style.removeProperty('--px-cursor'); root.style.removeProperty('--px-gem'); });

  const C = {};
  const readColors = () => { for (const k of ['0', '1', '2', '3', '4', '5']) C['p' + k] = color(`var(--p-${k})`); C.yel = '#f8d830'; C.red = '#e8482a'; C.hi = '#f8f8f8'; C.grn = '#58d858'; };
  readColors();

  // ---------------------------------------------------------------- backdrop: night city, 320 px wide, dithered
  const sky = document.createElement('canvas'); sky.className = 'px-sky';
  document.getElementById('bg').prepend(sky); rt.cleanup(() => sky.remove());
  const drawSky = () => {
    const W = 320, H = Math.max(160, Math.round(W * innerHeight / Math.max(1, innerWidth)));
    sky.width = W; sky.height = H;
    const x = sky.getContext('2d'), img = x.createImageData(W, H), d = img.data;
    const rnd = seeded(albumSeed());
    const P = ['0', '1', '2', '3'].map((k) => rgb(`var(--p-${k})`)), p4 = rgb('var(--p-4)'), p5 = rgb('var(--p-5)');
    const put = (px, py, c) => { if (px < 0 || py < 0 || px >= W || py >= H) return; const i = (py * W + px) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; };
    const horizon = Math.round(H * 0.74);
    // sky: four bands, ordered dither between them
    const bands = [P[0], P[0], P[1], P[2], P[3]];
    for (let py = 0; py < H; py++) {
      const t = Math.min(1, py / horizon) * (bands.length - 1), b = Math.min(bands.length - 2, Math.floor(t)), f = t - b;
      for (let px = 0; px < W; px++) put(px, py, f > BAYER[(py & 3) * 4 + (px & 3)] ? bands[b + 1] : bands[b]);
    }
    // stars
    for (let i = 0; i < 70; i++) { const sx = Math.floor(rnd() * W), sy = Math.floor(rnd() * horizon * 0.62); put(sx, sy, rnd() < 0.25 ? [200, 200, 210] : P[3]); }
    for (let i = 0; i < 5; i++) { const sx = 4 + Math.floor(rnd() * (W - 8)), sy = 4 + Math.floor(rnd() * horizon * 0.45); for (const [a, b] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) put(sx + a, sy + b, a || b ? P[3] : [230, 230, 240]); }
    // moon with dithered terminator
    const mx = Math.floor(W * (0.66 + rnd() * 0.28)), my = Math.floor(horizon * (0.08 + rnd() * 0.1)), mr = 9;
    for (let py = -mr; py <= mr; py++) for (let px = -mr; px <= mr; px++) {
      if (px * px + py * py > mr * mr) continue;
      const shade = (px + mr * 0.5) / mr;                    // lit from the left
      put(mx + px, my + py, shade > 0.9 + BAYER[((py + 64) & 3) * 4 + ((px + 64) & 3)] * 0.5 ? P[2] : (px * px + py * py > (mr - 1) * (mr - 1) ? P[3] : p4));
    }
    // skyline: far (lighter, hazy) then near (dark, lit windows)
    const city = (base, maxH, minW, maxW, col, windows) => {
      for (let bx = -2; bx < W;) {
        const bw = minW + Math.floor(rnd() * (maxW - minW)), bh = Math.floor(maxH * (0.3 + rnd() * 0.7)), top = base - bh;
        for (let py = top; py < H; py++) for (let px = bx; px < bx + bw; px++) put(px, py, col);
        if (rnd() < 0.25) for (let py = top - 6; py < top; py++) put(bx + (bw >> 1), py, col);   // antenna
        if (windows) for (let py = top + 3; py < base - 2; py += 3) for (let px = bx + 2; px < bx + bw - 2; px += 3) if (rnd() < 0.12) put(px, py, rnd() < 0.25 ? [200, 170, 40] : P[3]);
        bx += bw + (rnd() < 0.3 ? 1 + Math.floor(rnd() * 3) : 0);
      }
    };
    city(horizon + 6, horizon * 0.3, 8, 22, P[1], false);
    city(horizon + 14, horizon * 0.2, 10, 26, P[0], true);
    // highway
    for (let px = 0; px < W; px++) { put(px, horizon + 14, p4); for (let py = horizon + 15; py < H; py++) put(px, py, P[0]); if ((px >> 3) % 2 === 0) put(px, horizon + 19, P[3]); }
    x.putImageData(img, 0, 0);
  };
  let rz = 0;
  rt.listen(window, 'resize', () => { clearTimeout(rz); rz = setTimeout(drawSky, 250); });
  rt.cleanup(() => clearTimeout(rz));

  // ---------------------------------------------------------------- 16-bit cover: 96 px, 6 levels per channel, Bayer dither
  const art = document.getElementById('npArt');
  let pc = null, coverTok = 0;
  const dropCover = () => { pc?.remove(); pc = null; };
  rt.cleanup(dropCover);
  if (opt('pixcover')) onCover(rt, async (u) => {
    const tok = ++coverTok;
    if (!u) { dropCover(); return; }
    const bmp = await coverBitmap(96);
    if (tok !== coverTok || !rt.alive()) { bmp?.close?.(); return; }
    if (!bmp) { dropCover(); return; }
    const c = document.createElement('canvas'); c.width = c.height = 96; c.className = 'px-cover';
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0, 96, 96); bmp.close?.();
    const im = x.getImageData(0, 0, 96, 96), d = im.data, L = 6;
    for (let i = 0; i < d.length; i += 4) {
      const p = i >> 2, th = (BAYER[((p / 96 | 0) & 3) * 4 + ((p % 96) & 3)] - 0.5) * 0.7;
      for (let k = 0; k < 3; k++) { const v = d[i + k] / 255 * L + th; d[i + k] = Math.max(0, Math.min(L, Math.round(v))) / L * 255; }
    }
    x.putImageData(im, 0, 0);
    dropCover(); pc = c; art.appendChild(c);
  });

  // ---------------------------------------------------------------- READY on a new track
  if (opt('ready')) rt.on('playback:trackChanged', () => {
    if (router.current !== 'now' || document.visibilityState !== 'visible') return;
    art.querySelector('.px-ready')?.remove();
    const r = document.createElement('div'); r.className = 'px-ready'; r.textContent = 'READY';
    art.appendChild(r); setTimeout(() => r.remove(), 1600);
  });
  rt.cleanup(() => art.querySelector('.px-ready')?.remove());

  // ---------------------------------------------------------------- painters
  Viz.painters.spectrum = (c, w, h, bars, peaks, d) => {
    const n = bars.length; if (!n) return;
    const u = Math.max(1, Math.round(d)), seg = 4 * u, gap = 2 * u, R = Math.floor((h + gap) / (seg + gap));
    const N = Math.max(12, Math.min(40, Math.floor(w / (13 * u)))), g = Math.max(1, Math.floor(n / N));
    const cw = Math.floor((w - (N - 1) * 3 * u) / N);
    for (let i = 0; i < N; i++) {
      let v = 0, p = 0; for (let j = i * g; j < Math.min(n, (i + 1) * g); j++) { v = Math.max(v, bars[j]); p = Math.max(p, peaks[j]); }
      const lit = Math.round(v * R), pk = Math.min(R - 1, Math.round(p * R)), x0 = i * (cw + 3 * u);
      for (let r = 0; r < R; r++) {
        const y = h - (r + 1) * (seg + gap) + gap, q = r / R;
        if (r < lit) c.fillStyle = q < 0.5 ? C.p4 : q < 0.75 ? C.p5 : q < 0.9 ? C.yel : C.red;
        else if (r === pk && pk > 0) c.fillStyle = C.hi;
        else { c.fillStyle = C.p1; }
        c.fillRect(x0, y, cw, seg);
      }
    }
  };
  Viz.painters.wave = {
    step: 4, bw: 3,
    bar: (c, x, mid, bw, h, d) => { const u = Math.max(1, Math.round(d)) * 2, hh = Math.max(u, Math.round(h / u) * u); c.fillRect(Math.round(x), Math.round(mid - hh / 2), bw, hh); },
  };
  Viz.painters.colors = () => ({ a: C.yel, b: C.grn, dim: C.p2, text3: C.p3 });
  Viz.painters.beat = (e) => `translateY(${-Math.round(Math.min(1, e * 1.4) * 3) * 2}px)`;

  onPalette(rt, () => { readColors(); drawSky(); Viz.repaint(); });
  rt.cleanup(() => { art.style.removeProperty('transform'); dropProbe(); });
}
export function stop() {}
