/*
 * Gatefold · vu.js — two VU meters (left, right) instead of the spectrum on Now Playing, and in
 * the Canvas. Off by default: Settings → Appearance → VU meters.
 *
 *   level      the RMS of each channel of what foobar2000 plays (viz.js reads it from the same live
 *              PCM as the spectrum); without live PCM, the spectrum level on both sides.
 *              0 VU = a sine at settings.vuCal dBFS (−18 studio, −14, −10), or «auto» from the album's
 *              loudness; the level is read after foobar2000's ReplayGain (rg-now.js).
 *   movement   VU ballistics (IEC 60268-17): a second-order needle, 99 % of a step in 300 ms,
 *              about 1.5 % overshoot; it falls back to rest on pause.
 *   drawing    the dial is painted once per size and colours (offscreen), each frame only the needle
 *              and the peak lamp are drawn over it; nothing runs while no meter is on screen.
 */
import * as Viz from './viz.js';
import * as RG from './rg-now.js';
import { settings, onSettings } from './settings.js';
import { onPalette } from './theme.js';
import * as Canvas from './canvas.js';

const DPR = () => Math.min(3, devicePixelRatio || 1);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const scheme = () => document.documentElement.dataset.scheme || 'dark';
// the VU scale is linear in voltage: 0 VU at 70.8 % of the swing, +3 VU at 100 %
const frac = (vu) => Math.pow(10, vu / 20) / Math.pow(10, 3 / 20);
const SWING = 47 * Math.PI / 180;
const ang = (f) => -SWING + 2 * SWING * Math.max(-0.02, Math.min(1.035, f));
const MAJOR = [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3], MINOR = [-15, -9, -8, -6, -4, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
const PCT = [0, 20, 40, 60, 80, 100];

/* ---------------------------------------------------------------- colours */
function look() {
  const light = scheme() === 'light';
  if (settings.vuStyle !== 'album') return {
    face: ['#fbf1d9', '#efdcb0', '#e2c78f'], ink: '#24190e', ink2: 'rgba(36,25,14,.62)', red: '#c42b22', redBand: 'rgba(196,43,34,.9)',
    needle: '#140f09', needleR: '#b8241c', back: 'rgba(255,186,92,.55)', label: '#3a2a15',
    bezel: light ? ['#e9e9ec', '#b9bac0', '#8e9098'] : ['#3a3d44', '#1d1f24', '#0e0f12'], bezelLine: light ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.08)',
  };
  const a = css('--accent') || '#8fb4ff', t = css('--text') || '#eee', s = css('--surface') || '#222', s2 = css('--surface-2') || '#333';
  const mix = (x, y, p) => `color-mix(in oklab, ${x} ${p}%, ${y})`;
  return {
    face: light ? [mix(a, '#fff', 6), mix(a, '#fff', 12), mix(a, '#fff', 20)] : [mix(a, s2, 14), mix(a, s, 9), mix(a, '#000', 6)],
    ink: t, ink2: mix(t, 'transparent', 62), red: '#ff5d4f', redBand: 'rgba(255,93,79,.9)', needle: light ? mix(a, '#000', 55) : mix(a, '#fff', 70), needleR: '#ff5d4f',
    back: mix(a, 'transparent', light ? 22 : 30), label: mix(t, 'transparent', 80),
    bezel: light ? ['#f4f4f6', '#cfd0d6', '#a6a8b0'] : [mix(a, '#2a2c33', 10), '#16171b', '#0b0c0e'], bezelLine: light ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.07)',
  };
}

/* ---------------------------------------------------------------- the dial (static) */
function geometry(w, h) {
  const d = DPR(), pad = Math.round(Math.max(5, h * 0.045));
  const iw = w - 2 * pad, ih = h - 2 * pad, cx = w / 2, cy = pad + ih * 1.13;       // the pivot sits below the window
  return { d, pad, iw, ih, cx, cy, R: Math.min(iw * 0.47 / Math.sin(SWING), ih * 0.95) };
}
function dial(w, h, ch, L) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true }), { d, pad, iw, ih, cx, cy, R } = geometry(w, h), rr = Math.round(h * 0.07);
  let g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, L.bezel[0]); g.addColorStop(0.5, L.bezel[1]); g.addColorStop(1, L.bezel[2]);
  c.fillStyle = g; c.beginPath(); c.roundRect(0, 0, w, h, rr); c.fill();
  c.strokeStyle = L.bezelLine; c.lineWidth = d; c.beginPath(); c.roundRect(d / 2, d / 2, w - d, h - d, rr); c.stroke();
  c.save(); c.beginPath(); c.roundRect(pad, pad, iw, ih, rr * 0.6); c.clip();
  g = c.createLinearGradient(0, pad, 0, pad + ih); g.addColorStop(0, L.face[0]); g.addColorStop(0.55, L.face[1]); g.addColorStop(1, L.face[2]);
  c.fillStyle = g; c.fillRect(pad, pad, iw, ih);
  const n = c.getImageData(pad, pad, iw, ih), px = n.data;            // paper grain
  for (let i = 0; i < px.length; i += 4) { const v = (Math.random() - 0.5) * 7; px[i] += v; px[i + 1] += v; px[i + 2] += v; }
  c.putImageData(n, pad, pad);
  g = c.createRadialGradient(cx, pad + ih * 1.05, 0, cx, pad + ih * 1.05, ih * 1.25); g.addColorStop(0, L.back); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(pad, pad, iw, ih);                      // warm backlight from below
  const P = (a, r) => [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
  const arc = (a0, a1, r, color, lw) => { c.strokeStyle = color; c.lineWidth = lw; c.beginPath(); c.arc(cx, cy, r, a0 - Math.PI / 2, a1 - Math.PI / 2); c.stroke(); };
  const tick = (a, r1, r2, color, lw) => { const [x1, y1] = P(a, r1), [x2, y2] = P(a, r2); c.strokeStyle = color; c.lineWidth = lw; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); };
  const r0 = R * 0.8;
  arc(ang(frac(-20)), ang(frac(0)), r0, L.ink, Math.max(1, 1.1 * d));
  arc(ang(frac(0)), ang(1), r0 + R * 0.028, L.redBand, R * 0.045);
  arc(ang(0), ang(1), R * 0.64, L.ink2, Math.max(1, 0.9 * d));
  c.lineCap = 'butt';
  for (const db of MINOR) tick(ang(frac(db)), r0, r0 + R * 0.05, db >= 0 ? L.red : L.ink, Math.max(1, 0.9 * d));
  const fs = Math.max(8 * d, R * 0.085);
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const db of MAJOR) {
    const a = ang(frac(db)), red = db > 0, small = db === -2 || db === -1 || db === 1;
    tick(a, r0 - (db === 0 ? R * 0.03 : 0), r0 + R * 0.095, red ? L.red : L.ink, Math.max(1.2, (db === 0 ? 2 : 1.3) * d));
    c.font = `${db === 0 ? 700 : 600} ${Math.round(fs * (small ? 0.84 : 1))}px 'Inter Var', 'Segoe UI', sans-serif`;
    c.fillStyle = red ? L.red : L.ink;
    const [x, y] = P(a, r0 + R * 0.17);
    c.fillText(db > 0 ? '+' + db : String(Math.abs(db)), x, y);
  }
  c.font = `500 ${Math.round(fs * 0.7)}px 'Inter Var', 'Segoe UI', sans-serif`; c.fillStyle = L.ink2;
  for (const p of PCT) { const a = ang(p / 100); tick(a, R * 0.64, R * 0.605, L.ink2, Math.max(1, 0.9 * d)); if (p % 40 === 0 || p === 100) c.fillText(p === 100 ? '100%' : String(p), ...P(a, R * 0.555)); }
  c.font = `600 ${Math.round(fs * 1.25)}px 'Inter Var', 'Segoe UI', sans-serif`;
  c.fillStyle = L.ink; c.fillText('−', ...P(ang(-0.01) - 0.06, r0 + R * 0.3));
  c.fillStyle = L.red; c.fillText('+', ...P(ang(1) + 0.06, r0 + R * 0.3));
  c.font = `italic 600 ${Math.round(R * 0.12)}px Georgia, 'Times New Roman', serif`; c.fillStyle = L.label;
  c.fillText('VU', cx, pad + ih * 0.8);
  c.font = `700 ${Math.round(fs * 0.8)}px 'Inter Var', 'Segoe UI', sans-serif`;
  if (ch === 'LR') {                      // one dial, two needles: which needle is which
    c.fillStyle = L.needle; c.fillText('L', pad + iw * 0.1, pad + ih * 0.86);
    c.fillStyle = L.needleR; c.fillText('R', pad + iw * 0.9, pad + ih * 0.86);
  } else { c.fillStyle = L.ink2; c.fillText(ch, pad + iw * 0.9, pad + ih * 0.86); }
  c.restore();
  c.save(); c.beginPath(); c.roundRect(pad, pad, iw, ih, rr * 0.6); c.clip();         // the window's inner shadow
  c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 10 * d; c.shadowOffsetY = 2 * d; c.lineWidth = 8 * d; c.strokeStyle = 'rgba(0,0,0,.35)';
  c.beginPath(); c.roundRect(pad - 4 * d, pad - 4 * d, iw + 8 * d, ih + 8 * d, rr); c.stroke();
  c.restore();
  return cv;
}
function glass(w, h) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d'), { pad, iw, ih } = geometry(w, h), rr = Math.round(h * 0.07) * 0.6;
  c.beginPath(); c.roundRect(pad, pad, iw, ih, rr); c.clip();
  const g = c.createLinearGradient(pad, pad, pad + iw * 0.6, pad + ih); g.addColorStop(0, 'rgba(255,255,255,.28)'); g.addColorStop(0.45, 'rgba(255,255,255,.06)'); g.addColorStop(0.46, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.beginPath(); c.ellipse(pad + iw * 0.3, pad - ih * 0.15, iw * 0.75, ih * 0.62, -0.18, 0, Math.PI * 2); c.fill();
  return cv;
}

/* ---------------------------------------------------------------- needles, the pivot cover, peak lamps */
function needle(c, w, h, f, color) {
  const { d, cx, cy, R } = geometry(w, h), a = ang(f);
  const tipR = R * 0.93, baseR = R * 0.22;
  c.save(); c.translate(1.5 * d, 3 * d); c.filter = `blur(${1.6 * d}px)`; c.strokeStyle = 'rgba(0,0,0,.28)'; c.lineWidth = 2.2 * d;
  c.beginPath(); c.moveTo(cx + Math.sin(a) * baseR, cy - Math.cos(a) * baseR); c.lineTo(cx + Math.sin(a) * tipR, cy - Math.cos(a) * tipR); c.stroke(); c.restore();
  const nx = Math.cos(a), ny = Math.sin(a), wB = 1.7 * d, wT = 0.55 * d;
  const bx = cx + Math.sin(a) * baseR, by = cy - Math.cos(a) * baseR, tx = cx + Math.sin(a) * tipR, ty = cy - Math.cos(a) * tipR;
  c.fillStyle = color; c.beginPath();
  c.moveTo(bx - nx * wB, by - ny * wB); c.lineTo(tx - nx * wT, ty - ny * wT); c.lineTo(tx + nx * wT, ty + ny * wT); c.lineTo(bx + nx * wB, by + ny * wB); c.closePath(); c.fill();
}
/* the dome over the pivot, and a peak lamp beside it (two, left and right, on a stereo dial) */
function cap(c, w, h, lamps) {
  const { d, pad, ih, cx, R } = geometry(w, h);
  const pw = R * 0.27, ph = ih * 0.12, py = pad + ih;
  const g = c.createLinearGradient(0, py - ph, 0, py); g.addColorStop(0, '#2b2b2f'); g.addColorStop(0.35, '#16161a'); g.addColorStop(1, '#050506');
  c.fillStyle = g; c.beginPath(); c.ellipse(cx, py, pw, ph, 0, Math.PI, 0); c.fill();
  c.strokeStyle = 'rgba(255,255,255,.14)'; c.lineWidth = d; c.beginPath(); c.ellipse(cx, py, pw, ph, 0, Math.PI * 1.08, Math.PI * 1.92); c.stroke();
  const ly = py - ph * 0.45, lr = Math.max(2.5 * d, R * 0.028);
  const xs = lamps.length > 1 ? [cx - pw - R * 0.12, cx + pw + R * 0.12] : [cx - pw - R * 0.12];
  lamps.forEach((lamp, i) => {
    const lx = xs[i];
    if (lamp > 0) { c.save(); c.globalAlpha = Math.min(1, 0.35 + lamp); c.shadowColor = '#ff3b2f'; c.shadowBlur = 12 * d * Math.min(1, lamp); c.fillStyle = '#ff4a3d'; c.beginPath(); c.arc(lx, ly, lr, 0, Math.PI * 2); c.fill(); c.restore(); }
    else { c.fillStyle = 'rgba(110,25,20,.55)'; c.beginPath(); c.arc(lx, ly, lr, 0, Math.PI * 2); c.fill(); }
    c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = d * 0.8; c.beginPath(); c.arc(lx, ly, lr, 0, Math.PI * 2); c.stroke();
  });
}

/* ---------------------------------------------------------------- level and movement */
const ZETA = 0.81, OMEGA = 2 * Math.PI * 2.1;                // 99 % in ~300 ms, ~1.5 % overshoot
/* What is played, not what is decoded: the stream comes before ReplayGain, so the gain foobar2000
   applies to this track is put back in (rg-now.js).
   0 VU: a sine at a fixed level (−18 / −14 / −10 dBFS), or «Auto» — from the loudness of the album
   that is playing (its ReplayGain value, after the gain): the needle then swings around −4 VU and
   reaches the red on the loudest moments, on a modern master and a quiet 1970s record alike. */
function ref() {
  const v = settings.vuCal;
  if (v !== 'auto' && Number.isFinite(+v)) return +v;
  if (RG.now.lufs == null) return -10;                                   // no ReplayGain values: right for most modern masters
  return Math.max(-26, Math.min(-4, RG.now.lufs + RG.now.db + 7));
}
const toVu = (rms) => (rms > 1e-6 ? 20 * Math.log10(rms * RG.now.gain * Math.SQRT2) - ref() : -60);   // a sine's RMS × √2 = its peak
function targets() {
  RG.follow();                                     // once, when a meter first shows
  if (!Viz.progressState.playing) return [0, 0];
  const r = Viz.channelRms();
  if (r) return [frac(toVu(r[0])), frac(toVu(r[1]))];
  // no live PCM (host FFT): follow the spectrum, the same on both sides
  const s = Viz.signals();
  if (!s.live) return [0, 0];
  const f = frac(-20 + Math.min(1, s.level * 1.5 + s.bass * 0.3) * 22);
  return [f, f];
}

/* ---------------------------------------------------------------- mounting */
const meters = new Map();          // host → { box, layout, m: [{ cv, ch, chs: [channel…], n: [{ p, v }…], lamp: […], w, h, dial, glass }] }
let dirty = true, raf = 0, last = 0;
function mount(where, after) {
  const layout = settings.vuLayout === 'stereo' ? 'stereo' : 'pair';
  if (meters.has(where) && meters.get(where).layout === layout) return;
  unmount(where);
  const box = document.createElement('div'); box.className = 'vu-box' + (layout === 'stereo' ? ' stereo' : '');
  const make = (ch, chs) => { const cv = document.createElement('canvas'); cv.className = 'vu-meter'; box.append(cv); return { cv, ch, chs, n: chs.map(() => ({ p: 0, v: 0 })), lamp: chs.map(() => 0) }; };
  const m = layout === 'stereo' ? [make('LR', [0, 1])] : [make('L', [0]), make('R', [1])];
  after.after(box);
  meters.set(where, { box, layout, m });
  dirty = true; kick();
}
function unmount(where) { const x = meters.get(where); if (x) { x.box.remove(); meters.delete(where); } }

function visible() {
  const out = [];
  for (const [where, x] of meters) {
    if (where === 'now' && !(Viz.vizState.nowVisible && Viz.vizState.windowVisible)) continue;
    if (where === 'canvas' && !Canvas.opened()) continue;
    out.push(x);
  }
  return out;
}
function frame(now) {
  raf = 0;
  const live = visible();
  if (!live.length || !settings.vuMeters || document.visibilityState === 'hidden') { last = 0; return; }
  const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now;
  const tg = targets();
  let moving = Viz.progressState.playing;
  for (const x of live) for (const m of x.m) {
    const r = m.cv.getBoundingClientRect(), d = DPR();
    const w = Math.round(r.width * d), h = Math.round(r.height * d);
    if (w < 80 || h < 40) continue;              // not laid out (yet)
    if (dirty || m.w !== w || m.h !== h) { m.cv.width = w; m.cv.height = h; m.w = w; m.h = h; const L = look(); m.L = L; m.dial = dial(w, h, m.ch, L); m.glass = glass(w, h); }
    m.chs.forEach((ch, j) => {
      const n = m.n[j];
      for (let k = 0; k < 4; k++) {                                     // sub-steps: stable at any frame rate
        const acc = OMEGA * OMEGA * (tg[ch] - n.p) - 2 * ZETA * OMEGA * n.v;
        n.v += acc * dt / 4; n.p += n.v * dt / 4;
      }
      m.lamp[j] = tg[ch] > frac(2) ? 1 : Math.max(0, m.lamp[j] - dt * 3);
      if (Math.abs(n.p) > 0.002 || Math.abs(n.v) > 0.002 || m.lamp[j] > 0) moving = true;
    });
    const c = m.cv.getContext('2d');
    c.clearRect(0, 0, w, h); c.drawImage(m.dial, 0, 0);
    // on a stereo dial the right needle is drawn first, the left (the dial's own colour) over it
    for (let j = m.chs.length - 1; j >= 0; j--) needle(c, w, h, m.n[j].p, m.chs[j] === 1 && m.chs.length > 1 ? m.L.needleR : m.L.needle);
    cap(c, w, h, m.lamp);
    c.drawImage(m.glass, 0, 0);
  }
  dirty = false;
  // at rest (paused, needles down): no more frames until something changes
  if (moving) raf = requestAnimationFrame(frame);
}
export function kick() { if (!raf && settings.vuMeters) raf = requestAnimationFrame(frame); }

/* ---------------------------------------------------------------- wiring */
function apply() {
  document.body.classList.toggle('vu-on', !!settings.vuMeters);
  const viz = document.getElementById('viz');
  if (settings.vuMeters && viz) mount('now', viz); else unmount('now');
  syncCanvas();
  dirty = true; kick();
}
function syncCanvas() {
  const meta = document.querySelector('.cv .cv-meta');
  if (settings.vuMeters && settings.vuCanvas && Canvas.opened() && meta) { mount('canvas', meta); Viz.vizState.extra.add('vu'); }
  else { unmount('canvas'); Viz.vizState.extra.delete('vu'); }
}
export function init({ onNeedSpectrum } = {}) {
  onSettings((k) => {
    if (k === '*' || /^vu/.test(k)) { apply(); onNeedSpectrum && onNeedSpectrum(); }
  });
  onPalette(() => { if (settings.vuStyle === 'album') { dirty = true; kick(); } else if (meters.size) { dirty = true; kick(); } });
  Canvas.canvasEvents.addEventListener('open', () => { syncCanvas(); onNeedSpectrum && onNeedSpectrum(); kick(); });
  Canvas.canvasEvents.addEventListener('close', () => { syncCanvas(); onNeedSpectrum && onNeedSpectrum(); });
  document.addEventListener('visibilitychange', kick);
  apply();
}
