/* Gatefold · skin «Мультик» — doodle wallpaper, boiling ink line, eyeball logo, cartoon spectrum and waveform. */
import * as Viz from '../../viz.js';
import { color, onPalette, defs, bgLayer, dropProbe } from './util.js';

// ink doodles for the wallpaper (420×420 tile, paper-coloured strokes; opacity set in CSS)
const DOODLES = `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='420' viewBox='0 0 420 420' fill='none' stroke='%23fbf0d8' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'>
<path d='M24 58q15-22 30 0t30 0 30 0'/>
<circle cx='336' cy='66' r='27'/><circle cx='344' cy='71' r='9' fill='%23fbf0d8'/><path d='M309 60l-9-4M312 82l-10 6M330 39l-2-10M361 50l9-7'/>
<path d='M118 256a6 6 0 1 1 6 6 13 13 0 1 1-13-13 21 21 0 1 1 21 21 30 30 0 1 1-30-30'/>
<path d='M252 186c0 34-12 42-12 58a12 12 0 0 0 24 0c0-16-12-24-12-58z'/><path d='M222 182q30 10 60 0'/>
<path d='M372 268l10 22 24 3-18 16 5 24-21-12-21 12 5-24-18-16 24-3z'/>
<circle cx='70' cy='350' r='7' fill='%23fbf0d8'/><path d='M63 344q-14-18-6-26 8-6 12 12M77 344q14-18 6-26-8-6-12 12'/><path d='M90 360q30 12 46-6' stroke-dasharray='2 9'/>
<path d='M190 40q8 12 0 24t0 24M206 36q8 12 0 24t0 24M222 40q8 12 0 24t0 24'/>
<path d='M300 372q8-14 18 0M296 388c10 0 30 0 40 0'/><path d='M286 366a8 8 0 1 1 0 16 8 8 0 1 1 0-16zM346 366a8 8 0 1 1 0 16 8 8 0 1 1 0-16z'/>
<path d='M28 170l20 10-14 6 22 12'/>
<path d='M150 130c-4 10-10 14-10 20a10 10 0 0 0 20 0c0-6-6-10-10-20z'/>
<path d='M380 170q-12 6-6 18 10 8 18-2'/>
</svg>`.replace(/\n/g, '');

export async function start(rt, opt) {
  // wallpaper
  bgLayer(rt, 'toon-blob', '.veil');
  const dood = bgLayer(rt, 'toon-doodles', '.veil');
  dood.style.backgroundImage = `url("data:image/svg+xml,${DOODLES.replace(/#/g, '%23').replace(/"/g, "'")}")`;

  // boiling line: three turbulence seeds cycled at ~8 fps — the classic hand-drawn "boil", only on the cover outline
  const svg = defs(rt, `<filter id="toonBoil" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.022" numOctaves="1" seed="1" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" xChannelSelector="R" yChannelSelector="G"/></filter>`);
  if (opt('boil')) {
    const turb = svg.querySelector('feTurbulence');
    let s = 0;
    rt.every(125, () => {
      if (document.visibilityState !== 'visible' || !Viz.vizState.nowVisible) return;
      s = (s + 1) % 3; turb.setAttribute('seed', String(s + 1));
    });
  }

  // the logo is an eyeball that keeps an eye on the cursor
  const mark = document.querySelector('.brand-mark');
  if (mark) {
    let raf = 0, mx = 0, my = 0;
    const look = () => {
      raf = 0; const r = mark.getBoundingClientRect();
      const dx = mx - (r.left + r.width / 2), dy = my - (r.top + r.height / 2), k = Math.min(1, Math.hypot(dx, dy) / 260), a = Math.atan2(dy, dx);
      mark.style.setProperty('--eye-x', (Math.cos(a) * 3.6 * k).toFixed(2) + 'px'); mark.style.setProperty('--eye-y', (Math.sin(a) * 3.6 * k).toFixed(2) + 'px');
    };
    rt.listen(window, 'pointermove', (e) => { mx = e.clientX; my = e.clientY; if (!raf) raf = requestAnimationFrame(look); }, { passive: true });
    rt.cleanup(() => { cancelAnimationFrame(raf); mark.style.removeProperty('--eye-x'); mark.style.removeProperty('--eye-y'); });
  }

  // colours for the canvases
  const C = { ink: '#1b1210', paper: '#fbf0d8', paper3: '#e4c995', slime: '#b9e43a', main: '#e07a5f', mainD: '#8a3b2a' };
  onPalette(rt, () => { C.main = color('var(--k-main)'); C.mainD = color('var(--k-main-d)'); Viz.repaint(); }, 200);

  // spectrum: fat cel-shaded tubes in ink outline, slime blobs riding the peaks
  Viz.painters.spectrum = (c, w, h, bars, peaks, d) => {
    const n = bars.length; if (!n) return;
    const N = Math.max(12, Math.min(28, Math.round(w / (34 * d)))), g = Math.max(1, Math.floor(n / N));
    const gap = 7 * d, bw = (w - gap * (N - 1) - 6 * d) / N, lw = 2.6 * d, top = 8 * d, floor = h - lw;
    c.lineJoin = 'round'; c.lineWidth = lw; c.strokeStyle = C.ink;
    for (let i = 0; i < N; i++) {
      let v = 0, p = 0; for (let j = i * g; j < Math.min(n, (i + 1) * g); j++) { v = Math.max(v, bars[j]); p = Math.max(p, peaks[j]); }
      const x = i * (bw + gap) + lw, bh = Math.max(bw * 0.55, v * (floor - top - bw * 0.6)), y = floor - bh;
      c.beginPath(); c.roundRect(x, y, bw, bh, [bw / 2, bw / 2, 3 * d, 3 * d]);
      c.fillStyle = C.main; c.fill(); c.stroke();
      if (bh > bw) { c.fillStyle = 'rgba(255,248,232,.5)'; c.beginPath(); c.roundRect(x + bw * 0.2, y + bw * 0.35, Math.max(2 * d, bw * 0.16), bh - bw * 0.7, bw); c.fill(); }
      const py = floor - Math.max(bw * 0.55, p * (floor - top - bw * 0.6)) - bw * 0.36;
      if (p > v + 0.03) { c.beginPath(); c.ellipse(x + bw / 2, py, bw * 0.3, bw * 0.34, 0, 0, Math.PI * 2); c.fillStyle = C.slime; c.fill(); c.lineWidth = 2 * d; c.stroke(); c.lineWidth = lw; }
    }
  };
  // waveform on the paper bar: rounded pills; played part in the album colour
  Viz.painters.wave = {
    step: 5, bw: 3,
    bar: (c, x, mid, bw, h, d) => { const hh = Math.max(bw, h * 0.92); c.beginPath(); c.roundRect(x, mid - hh / 2, bw, hh, bw / 2); c.fill(); },
  };
  Viz.painters.colors = () => ({ a: C.main, b: C.mainD, dim: 'rgba(27,18,16,.22)', text3: 'rgba(27,18,16,.45)' });
  // squash and stretch instead of a uniform pulse
  Viz.painters.beat = (e) => { const k = Math.min(0.55, e); return `rotate(-2.2deg) scale(${(1 + k * 0.07).toFixed(4)}, ${(1 - k * 0.05).toFixed(4)})`; };
  rt.cleanup(() => { document.getElementById('npArt')?.style.removeProperty('transform'); dropProbe(); });
}
export function stop() {}
