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
import { log } from './bridge.js';
import { settings, setSetting } from './settings.js';
import * as AF from './audiofeed.js';
import { surface } from './present.js';

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

/* the sound: audiofeed.js (one PCM subscription for every visualiser on the page) */
const levels = (playing) => AF.frame(playing).time;

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
    this.sf = surface(); this.cv = this.sf.vis;              // drawn off screen, shown as a picture (present.js)
    this.tint = document.createElement('div'); this.tint.className = 'md-tint';
    host.append(this.cv, this.tint);
    this.ro = new ResizeObserver(() => this.size());
    this.guard = { last: 0, lums: [], c: null, x: null, busy: false };
    this.q = 1; this.gov = { at: performance.now(), n: 0, sum: 0 };
    this.key = '';
  }
  async start() {
    if (this.on) return;
    this.on = true;
    try { await ensure(); } catch (e) { this.on = false; log('milkdrop: load failed', e.message); return; }
    if (!this.on) return;
    if (!this.viz) {
      const { w, h } = this.dims();
      this.sf.resize(w, h);
      this.viz = Butterchurn.createVisualizer(null, this.sf.target, { width: w, height: h, pixelRatio: 1, textureRatio: 1, meshWidth: this.o.kind === 'backdrop' ? 32 : 48, meshHeight: this.o.kind === 'backdrop' ? 24 : 36 });
      const t0 = this.o.track && this.o.track(); this.key = t0 ? String(t0.handle || t0.path || t0.title || '') : '';
      this.next('start', 0);
      // a preset builds its picture from feedback over a second or so: draw that before showing anything
      try { const lv = levels(true); for (let i = 0; i < 30; i++) this.viz.render({ audioLevels: lv, elapsedTime: 1 / 60 }); } catch {}
    }
    this.ro.observe(this.host);
    this.size();
    AF.listen(true);
    this.host.classList.add('md-on');
    this.started = performance.now();
    this.loop();
  }
  stop() {
    if (!this.on) return;
    this.on = false;
    cancelAnimationFrame(this.raf); clearTimeout(this.raf); this.raf = 0;
    this.ro.disconnect();
    AF.listen(false);
    this.host.classList.remove('md-on');
  }
  destroy() { this.stop(); this.cv.remove(); this.tint.remove(); this.viz = null; }
  /** the render size: Canvas up to ~1.3 MP (the picture is soft by nature), the backdrop tiny (it is blurred) */
  dims() {
    const r = this.host.getBoundingClientRect();
    const W = Math.max(64, r.width), H = Math.max(36, r.height);
    // MilkDrop was made for ~1024×768: more pixels only cost the GPU (and, starved, the whole window's
    // responsiveness); the picture is soft by nature and scaled up smoothly. The governor lowers it further
    // when frames come late.
    const max = (this.o.kind === 'backdrop' ? 420 : 1280) * this.q;
    const k = Math.min(1, max / W);
    return { w: Math.max(64, Math.round(W * k)), h: Math.max(36, Math.round(H * k)) };
  }
  /* the quality governor: frames that come late (a busy or weak GPU) lower the resolution, a calm GPU
     raises it again — never more often than every 3 s */
  govern(now, dt) {
    const g = this.gov;
    g.n++; g.sum += dt;
    if (now - g.at < 3000) return;
    const avg = g.sum / g.n; g.at = now; g.n = 0; g.sum = 0;
    if (now - (this.started || 0) < 4000) return;          // the first seconds (shaders compiling) say nothing
    const target = 1 / this.fps(), q = this.q;
    if (avg > target * 1.35 && q > 0.45) this.q = Math.max(0.45, q * 0.8);
    else if (avg < target * 1.08 && q < 1) this.q = Math.min(1, q * 1.12);
    if (this.q !== q) { log('visuals: quality', this.q.toFixed(2)); this.size(); }
  }
  fps() { return !this.o.playing() ? 20 : this.o.kind === 'backdrop' || settings.motionFps === 'eco' ? 30 : 60; }
  size() {
    if (!this.viz) return;
    const { w, h } = this.dims();
    if (this.sf.target.width === w && this.sf.target.height === h) return;
    this.sf.resize(w, h);
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
      try { this.viz.render({ audioLevels: levels(playing), elapsedTime: dt }); this.sf.show(); } catch (e) { log('milkdrop: render', e.message); this.next('error'); }
      if (this.o.kind === 'canvas') this.checkFlash(now);
      this.govern(now, dt);
      // a new track: a new preset (watched here too, so no host has to remember to say so)
      const t = this.o.track && this.o.track(), key = t ? String(t.handle || t.path || t.title || '') : '';
      if (key !== this.key) { const had = this.key; this.key = key; if (had && key && settings.mdChange !== 'time' && settings.mdChange !== 'manual') this.next('track'); }
      if (settings.mdChange === 'time' && playing && !settings.mdLock && now - this.changed > 30000) this.next('timer');
      // MilkDrop presets are made for ~60 fps; «economical» draws 30, a paused track 20, the backdrop 30
      const fps = this.fps();
      if (fps < 60) this.raf = setTimeout(() => { this.raf = requestAnimationFrame(tick); }, Math.max(0, 1000 / fps - 4));
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
    if (now - g.last < 160 || g.busy) return;
    g.last = now;
    if (!g.c) { g.c = document.createElement('canvas'); g.c.width = 16; g.c.height = 9; g.x = g.c.getContext('2d', { willReadFrequently: true }); }
    // a snapshot taken right after drawing, scaled down by the GPU and read without waiting for it
    // (a synchronous read of a WebGL canvas stalls the page until the GPU is done)
    g.busy = true;
    createImageBitmap(this.cv, { resizeWidth: 16, resizeHeight: 9, resizeQuality: 'low' }).then((bmp) => {
      g.busy = false;
      if (!this.on) { bmp.close(); return; }
      g.x.clearRect(0, 0, 16, 9); g.x.drawImage(bmp, 0, 0); bmp.close();
      const d = g.x.getImageData(0, 0, 16, 9).data;
      let L = 0, any = 0;
      for (let i = 0; i < d.length; i += 4) { L += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]); any |= d[i + 3]; }
      if (!any) return;                                  // an empty snapshot (the canvas was between frames): not a sample
      this.flashSample(performance.now(), L / 144);
    }, () => { g.busy = false; });
  }
  flashSample(now, lum) {
    const g = this.guard;
    g.lums.push([now, lum]);
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
