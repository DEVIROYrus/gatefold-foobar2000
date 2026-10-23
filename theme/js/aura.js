/*
 * Gatefold · aura.js — Gatefold's own visualiser: light made of the album, moved by the music.
 *
 * Everything is drawn by two small WebGL 2 shaders, from three things only: the cover, its palette and
 * the sound (audiofeed.js). A simulation runs at half resolution and feeds on itself — each frame is the
 * last one carried along a flow field (the curl of moving noise, so it swirls like a fluid and never
 * collapses), fading a little, with new light poured in; a second pass adds the glow, a touch of lens
 * fringe on the beats, film grain, and tone-maps it for the screen. Three scenes:
 *   · Liquid — the cover itself, melting and swirling; each beat pours it in again, crisp;
 *   · Nebula — clouds in the album's colours drifting round the centre, stars that answer the treble;
 *   · Halo  — the spectrum as a ring of light around the cover spinning like a record; the rings drift
 *     outwards and leave trails, a beat sends a soft wave across the screen.
 * «Auto» picks the scene for each track by its character (sound analysis): calm music gets Nebula or
 * Liquid, loud and danceable music Halo. Nothing strobes: a beat changes the light by a few per cent and
 * eases out over a quarter of a second.
 */
import { log } from './bridge.js';
import { settings, setSetting } from './settings.js';
import { current } from './theme.js';
import { fetchArt } from './artbytes.js';
import * as AF from './audiofeed.js';

export const SCENES = ['liquid', 'nebula', 'halo'];
const IDX = { liquid: 0, nebula: 1, halo: 2 };

/* ---------------------------------------------------------------- shaders */
const VS = `#version 300 es
in vec2 aP; out vec2 vUv;
void main() { vUv = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }`;

const NOISE = `
uvec3 pcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 grad(vec3 i) { return normalize(vec3(pcg3(uvec3(ivec3(i) + 50000))) / 4294967295.0 * 2.0 - 1.0 + 1e-4); }
float gnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad(i), f), b = dot(grad(i + vec3(1, 0, 0)), f - vec3(1, 0, 0));
  float c = dot(grad(i + vec3(0, 1, 0)), f - vec3(0, 1, 0)), d = dot(grad(i + vec3(1, 1, 0)), f - vec3(1, 1, 0));
  float e = dot(grad(i + vec3(0, 0, 1)), f - vec3(0, 0, 1)), g = dot(grad(i + vec3(1, 0, 1)), f - vec3(1, 0, 1));
  float h = dot(grad(i + vec3(0, 1, 1)), f - vec3(0, 1, 1)), k = dot(grad(i + vec3(1, 1, 1)), f - vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * gnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
float potential(vec2 p, float t) { return gnoise(vec3(p * 1.2, t)) + 0.45 * gnoise(vec3(p * 2.7 + 4.0, t * 1.4)); }
vec2 curl(vec2 p, float t) {
  const float e = 0.015;
  float a = potential(p + vec2(0, e), t), b = potential(p - vec2(0, e), t);
  float c = potential(p + vec2(e, 0), t), d = potential(p - vec2(e, 0), t);
  return vec2(a - b, d - c) / (2.0 * e);
}
float hash12(vec2 p) { return float(pcg3(uvec3(ivec2(p) + 7919, 31)).x) / 4294967295.0; }`;

const SIM = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uPrev, uCover, uSpec;
uniform float uT, uAspect, uBass, uMid, uTreb, uBeat, uLevel, uSpin, uCalm, uStep, uSeed;
uniform int uScene;
uniform vec3 uPal[5];
${NOISE}
vec3 pal(float x) {                                       // the five colours as a loop: no seam anywhere
  x = fract(x) * 5.0; int i = int(x); float f = smoothstep(0.0, 1.0, fract(x));
  return mix(uPal[i], uPal[(i + 1) % 5], f);
}
/* the same look at any frame rate: per-frame amounts scaled by the frame's length (uStep = 1 at 60 fps) */
float keep(float k) { return pow(k, uStep); }
float pour(float k) { return 1.0 - pow(1.0 - k, uStep); }
vec2 coverUv(vec2 uv) { return 0.5 + (uv - 0.5) * (uAspect > 1.0 ? vec2(1.0, 1.0 / uAspect) : vec2(uAspect, 1.0)); }
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float t = uT;
  vec3 col;
  if (uScene == 0) {
    // Liquid: the cover in the middle, dissolving into a swirling flow that drifts outwards like ink in
    // water; each beat pours more of it in
    vec2 v = curl(p * 1.35, t * 0.055);
    float speed = (0.0016 + uBass * 0.005 + uBeat * 0.004) * uCalm * uStep;
    vec2 uv = vUv - v * speed / vec2(uAspect, 1.0);
    uv = 0.5 + (uv - 0.5) * (1.0 - (0.0024 + 0.0032 * uBass) * uCalm * uStep);
    vec3 prev = texture(uPrev, uv).rgb * keep(0.991);
    vec2 w = vec2(fbm(vec3(p * 2.2, t * 0.05)), fbm(vec3(p * 2.2 + 5.2, t * 0.05 + 3.0)));
    vec2 cp = p + w * (0.025 + uMid * 0.05);
    float R = 0.33 + 0.025 * uBass + 0.02 * uBeat;
    vec3 cov = textureLod(uCover, cp / (2.0 * R) + 0.5, 0.8).rgb;
    float l = dot(cov, vec3(0.2126, 0.7152, 0.0722));
    cov = mix(vec3(l), cov, 1.2) * 1.08;
    float mask = smoothstep(R, R * 0.5, length(cp));
    float inj = max(pour(0.06 + uBeat * 0.22 + uLevel * 0.03), uSeed) * mask;
    col = mix(prev, cov, inj);
  } else if (uScene == 1) {
    // Nebula: clouds in the album's colours turning round the centre, stars for the treble
    float a = (0.0011 + uMid * 0.0016) * uCalm * uStep;
    vec2 q = vUv - 0.5; q = mat2(cos(a), -sin(a), sin(a), cos(a)) * q;
    vec2 v = curl(p * 0.9, t * 0.03) * 0.0011 * uCalm * uStep;
    vec2 uv = 0.5 + q * (1.0 - (0.0015 + uBass * 0.0012) * uCalm * uStep) - v;
    vec3 prev = texture(uPrev, uv).rgb * keep(0.972 - uTreb * 0.004);
    vec2 wp = p + 0.38 * vec2(fbm(vec3(p * 1.3, t * 0.04)), fbm(vec3(p * 1.3 + 9.0, t * 0.04)));
    float d = smoothstep(-0.12, 0.55, fbm(vec3(wp * 1.5, t * 0.035)) * 1.5 + 0.18);
    vec3 c = pal(fbm(vec3(wp * 0.6 + 3.0, t * 0.02)) * 1.6 + t * 0.012);
    vec3 inj = c * d * d * d * (0.018 + uBass * 0.03 + uLevel * 0.01) * uStep;
    col = prev + inj;
  } else {
    // Halo: the spectrum as a ring; the rings drift outwards and leave trails
    vec2 q = vUv - 0.5;
    float a = 0.0025 * uCalm * uStep;
    q = mat2(cos(a), -sin(a), sin(a), cos(a)) * q;
    vec2 uv = 0.5 + q * (1.0 - (0.012 + uBass * 0.004) * uCalm * uStep);
    vec3 prev = texture(uPrev, uv).rgb * keep(0.9 + uLevel * 0.02);
    float r = length(p), ang = atan(p.y, p.x);
    float m = abs(ang) / 3.14159265;                         // mirrored: the ring is symmetric
    float s = texture(uSpec, vec2(0.02 + m * 0.9, 0.5)).r;
    float R = 0.2 + 0.018 * uBass;
    float rr = R + s * 0.11;
    float line = exp(-abs(r - rr) * 260.0), glow = exp(-abs(r - rr) * 38.0) * 0.22;
    vec3 c = pal(m * 0.8 + t * 0.015);
    float wave = uBeat > 0.02 ? exp(-abs(r - (R + (1.0 - uBeat) * 0.75)) * 60.0) * uBeat * 0.18 : 0.0;
    col = prev + (c * (line + glow * 0.7) * (0.4 + s * 1.0) + uPal[4] * wave) * min(uStep, 2.0);
  }
  o = vec4(min(col, vec3(4.0)), 1.0);
}`;

const COMP = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSim, uCover;
uniform float uT, uAspect, uBass, uTreb, uBeat, uLevel, uFade, uFrame, uSpinA, uHalo, uLift, uStars;
uniform vec2 uRes;
${NOISE}
void main() {
  vec2 d = vUv - 0.5;
  float ca = 0.0012 + uBeat * 0.0028;
  vec3 c;
  c.r = texture(uSim, vUv + d * ca).r;
  c.g = texture(uSim, vUv).g;
  c.b = texture(uSim, vUv - d * ca).b;
  // glow from the blurred levels of the picture (its mipmaps)
  vec3 bloom = textureLod(uSim, vUv, 3.0).rgb * 0.55 + textureLod(uSim, vUv, 5.0).rgb * 0.45;
  c += bloom * (0.28 + uLevel * 0.25);
  // Halo: the cover in the middle, round, turning like a record, breathing with the bass
  if (uHalo > 0.001) {
    vec2 p = d * vec2(uAspect, 1.0);
    float R = (0.165 + 0.012 * uBass);
    float r = length(p);
    float a = uSpinA;
    vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * p / (R * 2.0) + 0.5;
    vec3 cov = texture(uCover, q).rgb;
    float disc = smoothstep(R, R - 0.0025, r);
    float shadow = smoothstep(R + 0.06, R - 0.01, r) * 0.55;
    float hole = smoothstep(0.012, 0.015, r);
    c = mix(c, c * (1.0 - shadow), uHalo);
    c = mix(c, cov * mix(0.6, 1.0, hole), disc * uHalo);
  }
  // Nebula: stars, crisp (not carried by the flow), turning slowly; the treble makes them sparkle
  if (uStars > 0.001) {
    vec2 p = d * vec2(uAspect, 1.0);
    float a = uT * 0.012; p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
    for (int L = 0; L < 2; L++) {
      float sc = L == 0 ? 70.0 : 140.0;
      vec2 g = p * sc, cell = floor(g);
      float h = hash12(cell + float(L) * 911.0);
      vec2 off = vec2(hash12(cell + 37.0), hash12(cell + 71.0)) - 0.5;
      float tw = 0.55 + 0.45 * sin(uT * (1.5 + h * 4.0) + h * 60.0);
      float r = length(g - cell - 0.5 - off * 0.6);
      float star = step(L == 0 ? 0.993 : 0.985, h) * tw * smoothstep(0.32, 0.0, r) * (L == 0 ? 1.0 : 0.5);
      c += star * (0.35 + uTreb * 1.3) * uStars * mix(vec3(1.0), vec3(0.85, 0.9, 1.0), h);
    }
  }
  c *= uLift;
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);   // a filmic shoulder: light never clips harshly
  float vig = smoothstep(1.2, 0.3, length(d * vec2(uAspect, 1.0)));
  c *= mix(0.72, 1.0, vig);
  c += (hash12(vUv * uRes + uFrame * 13.0) - 0.5) * 0.035; // grain (also dithers the gradients)
  o = vec4(c * uFade, 1.0);
}`;

/* ---------------------------------------------------------------- helpers */
let sup = null;
export function supported() {
  if (sup !== null) return sup;
  try { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); sup = !!g; g?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { sup = false; }
  return sup;
}
const hexRgb = (h) => { const m = String(h || '').match(/^#?([0-9a-f]{6})$/i); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
/** five colours for the light: the album's palette, lifted so even a dark cover gives luminous colours */
function palette() {
  const p = current.palette;
  const src = p ? [p.blobs?.[0]?.hex, p.accent?.hex, p.blobs?.[1]?.hex, p.accent2?.hex, p.glow?.hex] : [];
  const def = ['#5b3cc4', '#ff4f9a', '#2fb4c8', '#ffb347', '#a98bff'];
  return def.map((d, i) => {
    let c = hexRgb(src[i]) || hexRgb(d);
    const mx = Math.max(...c, 1e-3);
    if (mx < 0.75) c = c.map((v) => v * (0.75 / mx));
    const l = (c[0] + c[1] + c[2]) / 3;
    return c.map((v) => Math.min(1, l + (v - l) * 1.18));
  });
}
let moodOf = () => null;
export const setMoodProvider = (fn) => { moodOf = fn; };
export const sceneName = (s) => s;

/* ---------------------------------------------------------------- a stage: the visualiser on screen */
export class Stage {
  /** host: the element to fill; opts: { kind: 'canvas' | 'backdrop', playing(), track(), cover() → url, onPreset(scene, why) } */
  constructor(host, opts) {
    this.host = host; this.o = opts; this.on = false; this.raf = 0; this.q = 1; this.frameN = 0;
    this.cv = document.createElement('canvas'); this.cv.className = 'md-canvas';
    host.append(this.cv);
    this.ro = new ResizeObserver(() => this.size());
    this.gov = { at: performance.now(), n: 0, sum: 0 };
    this.key = ''; this.coverUrl = null; this.cur = ''; this.spin = 0; this.t = Math.random() * 100;
    this.halo = 0; this.stars = 0; this.fade = 0;
  }
  init() {
    const gl = this.cv.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('no WebGL 2');
    this.gl = gl;
    this.half = !!gl.getExtension('EXT_color_buffer_float');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = (fs) => {
      const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'aP'); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
      return { p, u };
    };
    this.sim = prog(SIM); this.comp = prog(COMP);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.spec = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.spec);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 64, 1, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    this.specBuf = new Uint8Array(64);
    this.cover = gl.createTexture(); this.setCoverPixels(this.fallbackCover());
    this.cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    this.cv.addEventListener('webglcontextrestored', () => { this.lost = false; this.gl = null; this.targets = null; try { this.init(); this.size(true); } catch (err) { log('aura: restore failed', err.message); } });
  }
  /** the album's palette as a soft picture, for an album without a cover */
  fallbackCover() {
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
    const P = palette().map(([r, g, b]) => `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`);
    x.fillStyle = P[0]; x.fillRect(0, 0, 256, 256);
    [[60, 70, P[1]], [200, 90, P[2]], [120, 200, P[3]], [220, 220, P[4]]].forEach(([cx, cy, col]) => { const g = x.createRadialGradient(cx, cy, 0, cx, cy, 150); g.addColorStop(0, col); g.addColorStop(1, 'transparent'); x.fillStyle = g; x.fillRect(0, 0, 256, 256); });
    return c;
  }
  setCoverPixels(src) {
    const gl = this.gl; if (!gl) return;
    gl.bindTexture(gl.TEXTURE_2D, this.cover);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  }
  /** the cover of what plays (fb2k:// pictures are read as bytes: a cross-origin image would taint WebGL) */
  async loadCover() {
    const url = (this.o.cover && this.o.cover()) || '';
    if (url === this.coverUrl) return;
    this.coverUrl = url;
    let bmp = null;
    try {
      if (url) {
        let blob = null;
        if (/^fb2k:/i.test(url)) { const r = await fetchArt(url); if (r.status === 200) blob = r.blob; }
        else { const r = await fetch(url); if (r.ok) blob = await r.blob(); }
        if (blob) bmp = await createImageBitmap(blob, { resizeWidth: 512, resizeHeight: 512, resizeQuality: 'high' });
      }
    } catch { bmp = null; }
    if (url !== this.coverUrl || !this.gl) { bmp?.close(); return; }
    this.setCoverPixels(bmp || this.fallbackCover());
    bmp?.close();
    if (!this.coverOnce) { this.coverOnce = true; this.seed = 2; }        // the first real cover: start from it
  }
  async start() {
    if (this.on) return;
    this.on = true;
    try { if (!this.gl) this.init(); } catch (e) { this.on = false; log('aura: no WebGL', e.message); return; }
    const t0 = this.o.track && this.o.track(); this.key = t0 ? String(t0.handle || t0.path || t0.title || '') : '';
    if (!this.cur) this.next('start');
    this.ro.observe(this.host);
    this.size(true);
    AF.listen(true);
    this.loadCover();
    this.host.classList.add('md-on');
    this.last = 0; this.started = performance.now(); this.gov.at = this.started;
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
  destroy() { this.stop(); this.gl?.getExtension('WEBGL_lose_context')?.loseContext(); this.gl = null; this.cv.remove(); }
  /* sizes: the screen picture up to ~1920 px wide (× the governor), the simulation at half of it */
  size(force) {
    const gl = this.gl; if (!gl) return;
    const r = this.host.getBoundingClientRect();
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    const max = (this.o.kind === 'backdrop' ? 520 : 1920) * this.q;
    const k = Math.min(dpr, max / Math.max(64, r.width));
    const w = Math.max(64, Math.round(r.width * k)), h = Math.max(36, Math.round(r.height * k));
    if (!force && this.cv.width === w && this.cv.height === h) return;
    this.cv.width = w; this.cv.height = h;
    const sw = Math.max(32, Math.round(w * (this.o.kind === 'backdrop' ? 0.6 : 0.5))), sh = Math.max(18, Math.round(h * (this.o.kind === 'backdrop' ? 0.6 : 0.5)));
    const old = this.targets;
    this.targets = [0, 1].map(() => {
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.half ? gl.RGBA16F : gl.RGBA8, sw, sh, 0, gl.RGBA, this.half ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fb };
    });
    if (old) {
      // carry the picture over to the new size (a cleared buffer would flash black)
      const from = old[this.ping];
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.targets[0].fb);
      gl.blitFramebuffer(0, 0, this.sw, this.sh, 0, 0, sw, sh, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      for (const t of old) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    } else this.seed = 2;                                 // a new picture starts from the cover, not from black
    this.sw = sw; this.sh = sh; this.ping = 0;
  }
  fps() { return !this.o.playing() ? 30 : this.o.kind === 'backdrop' || settings.motionFps === 'eco' ? 30 : 60; }
  govern(now, dt) {
    const g = this.gov; g.n++; g.sum += dt;
    if (now - g.at < 3000) return;
    const avg = g.sum / g.n; g.at = now; g.n = 0; g.sum = 0;
    if (now - this.started < 4000) return;               // the first seconds (shaders compiling) say nothing
    const target = 1 / this.fps(), q = this.q;
    if (avg > target * 1.35 && q > 0.4) this.q = Math.max(0.4, q * 0.8);
    else if (avg < target * 1.08 && q < 1) this.q = Math.min(1, q * 1.12);
    if (this.q !== q) { log('visuals: quality', this.q.toFixed(2)); this.size(); }
  }
  loop() {
    const tick = (now) => {
      this.raf = 0;
      if (!this.on) return;
      if (document.hidden || this.lost) { this.raf = setTimeout(() => this.loop(), 500); return; }
      const playing = this.o.playing();
      const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
      this.last = now;
      const f = AF.frame(playing, now);
      this.draw(f, dt);
      this.govern(now, dt);
      const t = this.o.track && this.o.track(), key = t ? String(t.handle || t.path || t.title || '') : '';
      if (key !== this.key) { const had = this.key; this.key = key; if (had && key) this.next('track'); }
      if (this.frameN % 30 === 0) this.loadCover();
      const fps = this.fps();
      if (fps < 60) this.raf = setTimeout(() => { this.raf = requestAnimationFrame(tick); }, Math.max(0, 1000 / fps - 4));
      else this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  draw(f, dt) {
    const gl = this.gl; if (!gl || !this.targets) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const calm = reduce ? 0.35 : 1;
    this.t += dt * (0.6 + f.level * 0.8) * calm;
    this.spin += dt * (0.25 + f.bass * 0.35) * calm;
    this.frameN++;
    this.fade = Math.min(1, this.fade + dt / 1.2);
    const scene = IDX[this.cur] ?? 0;
    this.halo += ((scene === 2 ? 1 : 0) - this.halo) * Math.min(1, dt * 2.5);
    for (let i = 0; i < 64; i++) this.specBuf[i] = Math.min(255, f.bands[i] * 255);
    gl.bindTexture(gl.TEXTURE_2D, this.spec); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RED, gl.UNSIGNED_BYTE, this.specBuf);
    const P = palette().flat();
    const aspect = this.cv.width / this.cv.height;
    const beat = f.beat * (reduce ? 0.3 : 1);
    // 1. the simulation: last frame → this one
    const src = this.targets[this.ping], dst = this.targets[1 - this.ping];
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.sim.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, this.sw, this.sh);
    const U = this.sim.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(U.uPrev, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.cover); gl.uniform1i(U.uCover, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.spec); gl.uniform1i(U.uSpec, 2);
    gl.uniform1f(U.uT, this.t); gl.uniform1f(U.uAspect, aspect);
    gl.uniform1f(U.uBass, f.bass); gl.uniform1f(U.uMid, f.mid); gl.uniform1f(U.uTreb, f.treb); gl.uniform1f(U.uBeat, beat); gl.uniform1f(U.uLevel, f.level);
    gl.uniform1f(U.uCalm, calm); gl.uniform1i(U.uScene, scene); gl.uniform1f(U.uStep, Math.max(0.5, Math.min(3, dt * 60)));
    gl.uniform1f(U.uSeed, this.seed > 0 ? 1 : 0); if (this.seed > 0) this.seed--; gl.uniform3fv(U.uPal, P);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, dst.tex); gl.generateMipmap(gl.TEXTURE_2D);
    this.ping = 1 - this.ping;
    // 2. on the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.cv.width, this.cv.height);
    gl.useProgram(this.comp.p);
    const C = this.comp.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dst.tex); gl.uniform1i(C.uSim, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.cover); gl.uniform1i(C.uCover, 1);
    gl.uniform1f(C.uT, this.t); gl.uniform1f(C.uAspect, aspect); gl.uniform1f(C.uBass, f.bass); gl.uniform1f(C.uBeat, beat); gl.uniform1f(C.uLevel, f.level);
    gl.uniform1f(C.uFade, this.fade); gl.uniform1f(C.uFrame, this.frameN % 1000); gl.uniform1f(C.uSpinA, this.spin); gl.uniform1f(C.uHalo, this.halo);
    gl.uniform1f(C.uLift, scene === 0 ? 1.18 : 1.3);
    this.stars += ((scene === 1 ? 1 : 0) - this.stars) * Math.min(1, dt * 2.5);
    gl.uniform1f(C.uStars, this.stars); gl.uniform1f(C.uTreb, f.treb);
    gl.uniform2f(C.uRes, this.cv.width, this.cv.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  /** another scene: 'next' | 'prev' | 'track' | 'start' */
  next(why = 'next') {
    const fixed = settings.gfScene && settings.gfScene !== 'auto' ? settings.gfScene : '';
    let s;
    if (why === 'next' || why === 'prev') {
      const i = SCENES.indexOf(this.cur);
      s = SCENES[(i + (why === 'prev' ? SCENES.length - 1 : 1) + SCENES.length) % SCENES.length];
    } else if (fixed) s = fixed;
    else {
      const t = this.o.track && this.o.track();
      const m = t ? moodOf(t) : null;
      const pick = m == null ? SCENES : m < 0.4 ? ['nebula', 'liquid'] : m > 0.62 ? ['halo', 'liquid'] : ['liquid', 'halo', 'nebula'];
      const choices = pick.filter((x) => x !== this.cur);
      s = choices[Math.floor(Math.random() * choices.length)] || pick[0];
    }
    if (s === this.cur) return;
    this.cur = s;
    if (why !== 'start') this.fade = Math.min(this.fade, 0.75);       // a gentle dip, not a cut
    this.o.onPreset && this.o.onPreset(s, why);
  }
  /** B: keep this scene (or go back to «Auto») */
  lock() {
    const keep = settings.gfScene === this.cur ? 'auto' : this.cur;
    setSetting('gfScene', keep);
    return keep === 'auto' ? '' : keep;
  }
}
