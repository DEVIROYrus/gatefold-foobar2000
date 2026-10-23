/*
 * Gatefold · milkdrop.js — MilkDrop visuals (Butterchurn, the WebGL port of MilkDrop 2).
 *
 * Off until you turn it on (Settings → Canvas); nothing is loaded before that, and nothing runs while
 * it is not on screen. Where it shows:
 *   · Canvas → «Visual»: the visuals fill the screen, a small card with the cover and the title floats
 *     in a corner and fades out with the cursor;
 *   · optionally as the background of Now Playing — small, blurred and dimmed, in place of the cover's
 *     colour blobs: alive, but quiet enough to read over.
 * What makes it more than an old visualiser in a frame:
 *   · a curated set of presets (tools/milkdrop/curate.mjs rendered every preset of the Butterchurn packs
 *     to a test signal and measured them): no strobing presets, no near-black or static ones, each
 *     marked calm / flowing / vivid;
 *   · it listens to what foobar2000 plays (the same shared PCM ring as the spectrum, a subscription of
 *     its own), and follows the music: a new preset with each track (or every 30 s, or only by hand),
 *     chosen by the track's character when the sound analysis knows it — calm presets for quiet
 *     music, vivid ones for loud and danceable;
 *   · «in the colours of the cover»: a colour layer takes the hue from the album's palette and keeps
 *     the preset's light and motion, so the visuals belong to the album;
 *   · a flash guard: the picture is sampled a few times a second, and a preset that starts flashing
 *     faster than three times a second (the WCAG limit for photosensitive seizures) is replaced at once
 *     and not shown again;
 *   · N / P — next / previous preset, B — keep this one; its name shows for a moment.
 */
import { call, ok, log } from './bridge.js';
import { settings, setSetting } from './settings.js';

const BASE = new URL('./vendor/milkdrop/', import.meta.url);
let loading = null, Butterchurn = null, PRESETS = null;

/** WebGL 2 is what Butterchurn needs */
let sup = null;
export function supported() {
  if (sup !== null) return sup;
  try { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); sup = !!g; if (g) g.getExtension('WEBGL_lose_context')?.loseContext(); } catch { sup = false; }
  return sup;
}
/** the library and the presets, loaded once, when first needed */
function ensure() {
  if (Butterchurn && PRESETS) return Promise.resolve();
  return (loading ||= (async () => {
    if (!window.butterchurn) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = new URL('butterchurn.min.js', BASE).href; s.onload = res; s.onerror = () => rej(new Error('butterchurn')); document.head.append(s); });
    Butterchurn = window.butterchurn.default || window.butterchurn;
    const r = await fetch(new URL('presets.json', BASE));
    const j = await r.json();
    PRESETS = j.presets;
    log('milkdrop:', PRESETS.length, 'presets');
  })().catch((e) => { loading = null; throw e; }));
}

/* ---------------------------------------------------------------- the sound: foobar2000's PCM ring */
const SID = 'gatefold-milkdrop';
const pcm = { users: 0, f32: null, u32: null, ch: 2, ok: false, subscribed: false, tried: 0 };
const TB = new Uint8Array(1024), TL = new Uint8Array(1024), TR = new Uint8Array(1024);
try {
  window.chrome?.webview?.addEventListener('sharedbufferreceived', (e) => {
    let d = e.additionalData; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = {}; } }
    if (!d || d.purpose !== 'audio.subscribeStream' || d.subscriptionId !== SID) return;
    const b = e.getBuffer();
    pcm.f32 = new Float32Array(b); pcm.u32 = new Uint32Array(b, 0, 16); pcm.ch = d.channels || 2; pcm.ok = true;
  });
} catch { /* not in WebView2 */ }
async function listen(on) {
  pcm.users += on ? 1 : -1;
  if (pcm.users > 0 && !pcm.subscribed) {
    pcm.subscribed = true;
    const r = await call('audio.subscribeStream', { subscriptionId: SID, interval: 0.016, bufferSeconds: 0.5 });
    if (!ok(r)) { pcm.subscribed = false; log('milkdrop: no PCM stream', r.code || r.error); }
  } else if (pcm.users <= 0 && pcm.subscribed) {
    pcm.users = 0; pcm.subscribed = false; pcm.ok = false; pcm.f32 = pcm.u32 = null;
    call('audio.unsubscribeStream', { subscriptionId: SID });
  }
}
/** the newest 1024 frames as Butterchurn wants them (0…255 around 128), or silence */
let synthT = 0;
function levels(playing) {
  const u = pcm.u32, f = pcm.f32;
  if (playing && u && f && !(u[7] & 1) && u[6]) {
    const cap = u[6], slot = u[15], ch = pcm.ch;
    // quiet masters still move the picture: a gentle automatic gain up to ×3
    let peak = 0.02;
    for (let i = 0; i < 1024; i += 8) { let s = (slot - 1024 + i) % cap; if (s < 0) s += cap; const v = Math.abs(f[16 + s * ch]); if (v > peak) peak = v; }
    const g = Math.min(3, 0.9 / peak);
    for (let i = 0; i < 1024; i++) {
      let s = (slot - 1024 + i) % cap; if (s < 0) s += cap;
      const b = 16 + s * ch, l = f[b] * g, r = (ch > 1 ? f[b + 1] : f[b]) * g;
      TL[i] = 128 + Math.max(-127, Math.min(127, l * 127)); TR[i] = 128 + Math.max(-127, Math.min(127, r * 127)); TB[i] = (TL[i] + TR[i]) >> 1;
    }
  } else if (playing && !pcm.ok) {
    // no shared PCM (an older component): a soft pulse keeps the presets alive
    synthT += 1 / 60;
    for (let i = 0; i < 1024; i++) { const t = synthT + i / 44100; const v = Math.sin(t * 2 * Math.PI * 55) * 0.3 * (0.6 + 0.4 * Math.sin(t * 2 * Math.PI * 2)); TB[i] = TL[i] = TR[i] = 128 + v * 127; }
  } else { TB.fill(128); TL.fill(128); TR.fill(128); }
  return { timeByteArray: TB, timeByteArrayL: TL, timeByteArrayR: TR };
}

/* ---------------------------------------------------------------- the presets: which one next */
const BAD = 'gatefold.milkdrop.bad';
const bad = new Set((() => { try { return JSON.parse(localStorage.getItem(BAD) || '[]'); } catch { return []; } })());
let moodOf = () => null;                       // app.js: the character of a track (0 calm … 1 vivid), or null
export const setMoodProvider = (fn) => { moodOf = fn; };
function pool(mood) {
  let list = PRESETS.filter((p) => !bad.has(p.n) && (settings.mdPresets === 'all' || p.c !== 'vivid'));
  if (settings.mdMood !== false && mood != null) {
    const want = mood < 0.36 ? ['calm'] : mood > 0.62 ? ['vivid', 'flow'] : ['flow', 'calm'];
    const m = list.filter((p) => want.includes(p.c));
    if (m.length >= 6) list = m;
  }
  return list.length ? list : PRESETS;
}
const history = [];

/* ---------------------------------------------------------------- a stage: one visualiser on screen */
export class Stage {
  /** host: the element to fill; opts: { kind: 'canvas' | 'backdrop', playing(), track(), onPreset(name, why) } */
  constructor(host, opts) {
    this.host = host; this.o = opts; this.on = false; this.viz = null; this.raf = 0; this.idx = -1; this.hist = -1;
    this.cv = document.createElement('canvas'); this.cv.className = 'md-canvas';
    this.tint = document.createElement('div'); this.tint.className = 'md-tint';
    host.append(this.cv, this.tint);
    this.ro = new ResizeObserver(() => this.size());
    this.guard = { last: 0, lums: [], c: null, x: null };
  }
  async start() {
    if (this.on) return;
    this.on = true;
    try { await ensure(); } catch (e) { this.on = false; log('milkdrop: load failed', e.message); return; }
    if (!this.on) return;
    if (!this.viz) {
      const { w, h } = this.dims();
      this.viz = Butterchurn.createVisualizer(null, this.cv, { width: w, height: h, pixelRatio: 1, textureRatio: 1, meshWidth: this.o.kind === 'backdrop' ? 32 : 48, meshHeight: this.o.kind === 'backdrop' ? 24 : 36 });
      this.next('start', 0);
      // a preset builds its picture from feedback over a second or so: draw that before showing anything
      try { const lv = levels(true); for (let i = 0; i < 30; i++) this.viz.render({ audioLevels: lv, elapsedTime: 1 / 60 }); } catch {}
    }
    this.ro.observe(this.host);
    this.size();
    listen(true);
    this.host.classList.add('md-on');
    this.loop();
  }
  stop() {
    if (!this.on) return;
    this.on = false;
    cancelAnimationFrame(this.raf); clearTimeout(this.raf); this.raf = 0;
    this.ro.disconnect();
    listen(false);
    this.host.classList.remove('md-on');
  }
  destroy() { this.stop(); this.cv.remove(); this.tint.remove(); this.viz = null; }
  /** the render size: Canvas up to ~1.3 MP (the picture is soft by nature), the backdrop tiny (it is blurred) */
  dims() {
    const r = this.host.getBoundingClientRect();
    const W = Math.max(64, r.width), H = Math.max(36, r.height);
    const max = this.o.kind === 'backdrop' ? 420 : Math.min(1600, 1280 * (devicePixelRatio > 1.4 ? 1.25 : 1));
    const k = Math.min(1, max / W) * (this.o.kind === 'backdrop' ? 1 : Math.min(1.5, devicePixelRatio || 1));
    return { w: Math.round(W * k), h: Math.round(H * k) };
  }
  size() {
    if (!this.viz) return;
    const { w, h } = this.dims();
    if (this.cv.width === w && this.cv.height === h) return;
    this.cv.width = w; this.cv.height = h;
    this.viz.setRendererSize(w, h);
  }
  loop() {
    const tick = (now) => {
      this.raf = 0;
      if (!this.on) return;
      if (document.hidden) { this.raf = setTimeout(() => this.loop(), 500); return; }
      const playing = this.o.playing();
      const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
      this.last = now;
      try { this.viz.render({ audioLevels: levels(playing), elapsedTime: dt }); } catch (e) { log('milkdrop: render', e.message); this.next('error'); }
      if (this.o.kind === 'canvas') this.checkFlash(now);
      if (settings.mdChange === 'time' && playing && !settings.mdLock && now - this.changed > 30000) this.next('timer');
      // MilkDrop presets are made for ~60 fps; «economical» draws 30, a paused track 20, the backdrop 30
      const fps = !playing ? 20 : this.o.kind === 'backdrop' || settings.motionFps === 'eco' ? 30 : 0;
      if (fps) this.raf = setTimeout(() => { this.raf = requestAnimationFrame(tick); }, Math.max(0, 1000 / fps - 4));
      else this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  /** another preset: 'next' | 'prev' | 'track' | 'timer' | 'start' | 'flash' | 'error' */
  next(why = 'next', blend = 2.7) {
    if (!this.viz || !PRESETS) return;
    let p = null;
    if (why === 'prev' && this.hist > 0) { this.hist--; p = PRESETS.find((x) => x.n === history[this.hist]); }
    else if (settings.mdLock && why !== 'next' && why !== 'flash' && why !== 'error') p = PRESETS.find((x) => x.n === settings.mdLock && !bad.has(x.n));
    if (!p) {
      const t = this.o.track && this.o.track();
      const list = pool(t ? moodOf(t) : null);
      const recent = new Set(history.slice(-Math.min(12, Math.floor(list.length / 2))));
      const fresh = list.filter((x) => !recent.has(x.n));
      const from = fresh.length ? fresh : list;
      p = from[Math.floor(Math.random() * from.length)];
      history.push(p.n); if (history.length > 60) history.shift();
      this.hist = history.length - 1;
    }
    this.cur = p.n; this.changed = performance.now();
    try { this.viz.loadPreset(p.p, why === 'flash' || why === 'error' ? 0.4 : blend); } catch (e) { log('milkdrop: preset failed', p.n, e.message); bad.add(p.n); return this.next('error'); }
    this.guard.lums = [];
    this.o.onPreset && this.o.onPreset(p.n, why);
  }
  /** B: keep this preset (or let them change again) */
  lock() {
    const keep = settings.mdLock === this.cur ? '' : this.cur || '';
    setSetting('mdLock', keep);
    return keep;
  }
  /* the flash guard: about 6 samples a second of the picture's mean luminance; three or more opposing
     changes of ≥ 10 % within a second count as flashing (WCAG 2.3.1) */
  checkFlash(now) {
    const g = this.guard;
    if (now - g.last < 160) return;
    g.last = now;
    if (!g.c) { g.c = document.createElement('canvas'); g.c.width = 16; g.c.height = 9; g.x = g.c.getContext('2d', { willReadFrequently: true }); }
    try {
      g.x.drawImage(this.cv, 0, 0, 16, 9);
      const d = g.x.getImageData(0, 0, 16, 9).data;
      let L = 0;
      for (let i = 0; i < d.length; i += 4) L += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
      g.lums.push([now, L / 144]);
    } catch { return; }
    while (g.lums.length && now - g.lums[0][0] > 1100) g.lums.shift();
    let last = 0, flips = 0;
    for (let i = 1; i < g.lums.length; i++) {
      const a = g.lums[i - 1][1], b = g.lums[i][1], dd = b - a;
      if (Math.abs(dd) >= 0.1 && Math.min(a, b) < 0.8) { const s = Math.sign(dd); if (last && s !== last) flips++; last = s; }
    }
    if (flips >= 5) {                                       // ≥ 3 flashes (6 opposing changes) a second: away with it
      log('milkdrop: flashing preset replaced', this.cur);
      bad.add(this.cur); try { localStorage.setItem(BAD, JSON.stringify([...bad].slice(-200))); } catch {}
      if (settings.mdLock === this.cur) setSetting('mdLock', '');
      this.next('flash');
    }
  }
}
const LIN = new Float32Array(256).map((_, i) => { const x = i / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
const lin = (v) => LIN[v];
/** how many presets there are (after loading), for the settings */
export const count = () => (PRESETS ? PRESETS.length : 0);
export const preload = () => ensure().catch(() => {});
