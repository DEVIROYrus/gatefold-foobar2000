/*
 * Gatefold · aura.js — Gatefold's own visualiser: the cover, made of light, played by the music.
 *
 * The album's cover becomes 65 536 particles of light (a 256 × 256 grid of its pixels, each keeping its
 * colour) floating in 3D, and the music decides what they do:
 *   · the cover is an instrument: every column answers its own frequency (bass in the middle, treble at
 *     the edges), so the picture rises towards you as a relief that plays along — bright pixels rise more;
 *   · loud passages set it free: the particles let go of their places, from the edges inwards along a
 *     slowly moving noise, and a real fluid (a stable-fluids solver on the GPU: advection, vorticity,
 *     pressure projection) carries them as coloured smoke; when the music calms down they find their way
 *     back and the cover forms again. A drop throws it all into the air;
 *   · a beat sends a ring through the picture and a puff through the fluid; the treble makes the dust shimmer;
 *   · a new track: the old cover bursts and the particles, changing colour in flight, settle into the new one;
 *   · the words: with synced lyrics, each line is written with particles taken from the cover itself —
 *     the picture steps back, the line comes forward in the album's own colours, and flows into the next;
 *   · a camera «director» changes the shot with the music's phrases (every 32 beats or so, and on a drop):
 *     Face, Landscape (the cover as a terrain under a low camera), Orbit, Macro (close, a shallow focus);
 *     depth of field turns the far particles into bokeh.
 * The light is HDR: trails that grow with the motion, bloom from the picture's mip levels, an anamorphic
 * streak in the album's accent colour, a filmic tone curve, grain. Nothing strobes: a beat moves light by a
 * few per cent and eases out; «reduce motion» calms everything down.
 *
 * Drawn off screen and shown as a picture (present.js): a live full-screen WebGL surface could take the
 * mouse away from the player.
 */
import { log } from './bridge.js';
import { settings, setSetting } from './settings.js';
import { current } from './theme.js';
import { fetchArt } from './artbytes.js';
import * as AF from './audiofeed.js';
import { surface } from './present.js';

/** camera shots («scenes» to the rest of the theme) */
export const SCENES = ['face', 'land', 'orbit', 'macro'];

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
float hash12(vec2 p) { return float(pcg3(uvec3(ivec2(p) + 7919, 31)).x) / 4294967295.0; }
vec3 hash32(vec2 p) { return vec3(pcg3(uvec3(ivec2(p) + 4271, 977))) / 4294967295.0; }`;

/* the fluid: a grid over the world (x −1.8…1.8, y −1…1), square cells; velocities in world units / s */
const FL_HEAD = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform vec2 uTx;`;
const SPLAT = `${FL_HEAD}
uniform sampler2D uVel; uniform vec2 uWorld; uniform int uN; uniform vec4 uS[8]; uniform float uR[8];
void main() {
  vec2 w = (vUv * 2.0 - 1.0) * uWorld, v = texture(uVel, vUv).xy;
  for (int i = 0; i < 8; i++) {
    if (i >= uN) break;
    vec2 d = w - uS[i].xy; float r = abs(uR[i]), g = exp(-dot(d, d) / (r * r));
    if (uR[i] < 0.0) v += vec2(-d.y, d.x) / r * uS[i].z * g;      // a vortex
    else v += uS[i].zw * g;                                         // a push
  }
  o = vec4(v, 0.0, 1.0);
}`;
const CURL = `${FL_HEAD}
uniform sampler2D uVel;
void main() {
  float L = texture(uVel, vUv - vec2(uTx.x, 0)).y, R = texture(uVel, vUv + vec2(uTx.x, 0)).y;
  float B = texture(uVel, vUv - vec2(0, uTx.y)).x, T = texture(uVel, vUv + vec2(0, uTx.y)).x;
  o = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;
const VORT = `${FL_HEAD}
uniform sampler2D uVel, uCurl; uniform float uConf, uDt;
void main() {
  float L = texture(uCurl, vUv - vec2(uTx.x, 0)).x, R = texture(uCurl, vUv + vec2(uTx.x, 0)).x;
  float B = texture(uCurl, vUv - vec2(0, uTx.y)).x, T = texture(uCurl, vUv + vec2(0, uTx.y)).x;
  float C = texture(uCurl, vUv).x;
  vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  f = f / (length(f) + 1e-4) * uConf * C; f.y = -f.y;
  o = vec4(texture(uVel, vUv).xy + f * uDt, 0.0, 1.0);
}`;
const DIV = `${FL_HEAD}
uniform sampler2D uVel;
void main() {
  float L = texture(uVel, vUv - vec2(uTx.x, 0)).x, R = texture(uVel, vUv + vec2(uTx.x, 0)).x;
  float B = texture(uVel, vUv - vec2(0, uTx.y)).y, T = texture(uVel, vUv + vec2(0, uTx.y)).y;
  vec2 c = texture(uVel, vUv).xy;
  if (vUv.x - uTx.x < 0.0) L = -c.x; if (vUv.x + uTx.x > 1.0) R = -c.x;
  if (vUv.y - uTx.y < 0.0) B = -c.y; if (vUv.y + uTx.y > 1.0) T = -c.y;
  o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;
const PRES = `${FL_HEAD}
uniform sampler2D uP, uDiv;
void main() {
  float L = texture(uP, vUv - vec2(uTx.x, 0)).x, R = texture(uP, vUv + vec2(uTx.x, 0)).x;
  float B = texture(uP, vUv - vec2(0, uTx.y)).x, T = texture(uP, vUv + vec2(0, uTx.y)).x;
  o = vec4((L + R + B + T - texture(uDiv, vUv).x) * 0.25, 0.0, 0.0, 1.0);
}`;
const GRAD = `${FL_HEAD}
uniform sampler2D uP, uVel;
void main() {
  float L = texture(uP, vUv - vec2(uTx.x, 0)).x, R = texture(uP, vUv + vec2(uTx.x, 0)).x;
  float B = texture(uP, vUv - vec2(0, uTx.y)).x, T = texture(uP, vUv + vec2(0, uTx.y)).x;
  o = vec4(texture(uVel, vUv).xy - 0.5 * vec2(R - L, T - B), 0.0, 1.0);
}`;
const ADV = `${FL_HEAD}
uniform sampler2D uVel; uniform vec2 uWorld; uniform float uDt, uDiss;
void main() {
  vec2 back = vUv - uDt * texture(uVel, vUv).xy / (2.0 * uWorld);
  o = vec4(texture(uVel, back).xy / (1.0 + uDiss * uDt), 0.0, 1.0);
}`;

/* the particles: positions (xyz, a seed) and velocities (xyz, heat), one texel each, both written at once */
const PSIM = `#version 300 es
precision highp float; precision highp int;
layout(location = 0) out vec4 oP;
layout(location = 1) out vec4 oV;
uniform sampler2D uPos, uVel, uFluid, uCov0, uCov1, uSpec, uText;
uniform float uS, uDt, uT, uFree, uKick, uBurst, uMid, uTreb, uRing, uRingAmp, uRelief, uWords, uMorph, uIntro, uLive;
uniform vec2 uWorld;
${NOISE}
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, ij, 0), V = texelFetch(uVel, ij, 0);
  vec2 uv = (vec2(ij) + 0.5) / uS;
  float seed = P.w;
  vec2 cuv = vec2(uv.x, 1.0 - uv.y);
  vec3 col = mix(textureLod(uCov0, cuv, 0.0).rgb, textureLod(uCov1, cuv, 0.0).rgb, uMorph);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  // the relief: each column answers its band (mirrored: bass in the middle), bright pixels rise more
  float m = abs(uv.x - 0.5) * 2.0;
  float sp = texture(uSpec, vec2(0.015 + m * 0.93, 0.5)).r;
  float r = length(uv - 0.5);
  vec3 home = vec3(uv - 0.5, 0.0);
  float ring = exp(-pow((r - uRing) * 12.0, 2.0)) * uRingAmp;
  home.z = pow(sp, 1.5) * (0.035 + lum * 0.2) * uRelief + ring * 0.07;
  // who is free: the cover lets go from the edges inwards, along a slowly moving noise
  float n = gnoise(vec3(uv * 3.2, uT * 0.07)) * 0.5 + 0.5;
  float edge = clamp(r * 1.4142, 0.0, 1.0);
  float rel = smoothstep(0.02, 0.2, uFree * 1.7 - (1.0 - edge) * 0.6 - n * 0.45 - seed * 0.2);
  rel = max(rel, uKick);
  vec3 p = P.xyz, v = V.xyz;
  // bound: a spring home, a little bouncy; free: carried by the fluid, stirred by noise
  vec3 a = (home - p) * mix(16.0, 0.7, rel) * mix(0.1, 1.0, uIntro);   // free ones keep a thread: the smoke stays round the cover
  vec2 fuv = p.xy / uWorld * 0.5 + 0.5;
  vec2 fv = (fuv.x > 0.0 && fuv.x < 1.0 && fuv.y > 0.0 && fuv.y < 1.0) ? texture(uFluid, fuv).xy : vec2(0.0);
  a.xy += (fv - v.xy) * 6.0 * rel;                 // close behind the flow (inertia would gather them into lines)
  vec3 q = p * 2.3;
  vec3 nz = vec3(gnoise(q + vec3(0.0, 0.0, uT * 0.25)), gnoise(q + vec3(17.0, 3.0, uT * 0.25)), gnoise(q + vec3(5.0, 29.0, uT * 0.25)));
  a += nz * mix(0.04, 1.1, rel) * (0.35 + uMid * 0.9 + uTreb * 0.4) * uLive;
  a.z -= p.z * 0.8 * rel;
  vec2 dir = p.xy / (length(p.xy) + 0.05);
  a.xy += dir * uBurst * (0.6 + seed) * max(rel, 0.08) / (0.35 + length(p.xy));
  a.z += (seed - 0.5) * uBurst * 1.6 * max(rel, 0.08);
  float damp = mix(6.4, 0.7, rel);
  // a word of the lyrics: this particle's place in the line
  vec4 tg = texelFetch(uText, ij, 0);
  float wt = tg.w * uWords;
  if (wt > 0.001) {
    vec3 at = (tg.xyz - p) * 24.0 - v * 6.5 + nz * 0.1 * (1.0 + uTreb * 2.0);
    float k = smoothstep(0.0, 1.0, wt);
    a = mix(a, at, k); damp = mix(damp, 1.0, k);
  }
  v += a * uDt;
  v *= exp(-damp * uDt);
  p += v * uDt;
  if (any(isnan(p)) || any(isnan(v)) || length(p) > 8.0) { p = home + (hash32(vec2(ij) + uT) - 0.5) * 0.02; v = vec3(0.0); }
  float heat = mix(V.w, clamp(length(v) * 0.9 + wt * 0.4, 0.0, 2.0), 1.0 - exp(-6.0 * uDt));
  oP = vec4(p, seed); oV = vec4(v, heat);
}`;

/* drawing them: soft points, bigger and fainter out of focus (bokeh) */
const PVS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uPos, uVel, uCov0, uCov1, uText;
uniform mat4 uMVP;
uniform float uS, uPx, uMorph, uFocus, uAp, uGain, uWords, uDim, uMaxPt;
uniform vec2 uVp;
uniform vec3 uHot;
out vec3 vC; out float vB;
void main() {
  int S = int(uS), id = gl_VertexID;
  ivec2 ij = ivec2(id % S, id / S);
  vec4 P = texelFetch(uPos, ij, 0), V = texelFetch(uVel, ij, 0);
  vec2 uv = (vec2(ij) + 0.5) / uS;
  vec2 cuv = vec2(uv.x, 1.0 - uv.y);
  vec3 c = mix(textureLod(uCov0, cuv, 0.0).rgb, textureLod(uCov1, cuv, 0.0).rgb, uMorph);
  vec4 cp = uMVP * vec4(P.xyz, 1.0);
  float depth = max(cp.w, 0.05);
  // the screen area of one grid cell here (a tilted cover packs its particles closer): its light is spread
  // so that a settled cover shows its own colours at any angle
  vec4 cx = uMVP * vec4(P.xyz + vec3(1.0 / uS, 0.0, 0.0), 1.0), cy = uMVP * vec4(P.xyz + vec3(0.0, 1.0 / uS, 0.0), 1.0);
  vec2 sc = cp.xy / depth;
  vec2 ex = (cx.xy / max(cx.w, 0.05) - sc) * uVp, ey = (cy.xy / max(cy.w, 0.05) - sc) * uVp;
  float area = max(abs(ex.x * ey.y - ex.y * ey.x), 0.02);
  float sp = uPx / (uS * depth);                       // the grid's spacing on screen, px
  float s0 = max(sp * 1.7, 1.25);
  float coc = abs(depth - uFocus) / depth * uAp * uPx; // circle of confusion, px
  float size = min(s0 + coc, uMaxPt);
  gl_PointSize = size;
  gl_Position = cp.w < 0.05 ? vec4(9.0, 9.0, 9.0, 1.0) : cp;
  float wt = texelFetch(uText, ij, 0).w * uWords;
  float heat = V.w;
  vec3 col = c * (1.0 + heat * 0.25) + uHot * heat * 0.12;
  col = mix(col * (1.0 - uDim), col * 1.3 + 0.06, wt);
  vC = col * min(area / (0.21 * size * size), 3.0) * uGain;      // the same light, spread over the disc
  vB = clamp(coc / size, 0.0, 1.0);
}`;
const PFS = `#version 300 es
precision highp float;
in vec3 vC; in float vB; out vec4 o;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0; float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float g = exp(-r2 * 3.2);
  float disc = (0.62 + 0.38 * smoothstep(0.55, 1.0, r2)) * smoothstep(1.0, 0.82, r2) * 0.55;
  o = vec4(vC * mix(g, disc, vB), 1.0);
}`;
const FADE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform float uKeep;
void main() { o = vec4(textureLod(uSrc, vUv, 0.0).rgb * uKeep, 1.0); }`;
const COMP = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uHdr, uCov0, uCov1;
uniform float uMorph, uAspect, uBeat, uFrame, uFade, uBloom, uFlare, uLift;
uniform vec3 uPal[5];
uniform vec2 uRes;
${NOISE}
void main() {
  vec2 d = vUv - 0.5;
  float ca = 0.0008 + uBeat * 0.0018;
  vec3 c = vec3(texture(uHdr, vUv + d * ca).r, texture(uHdr, vUv).g, texture(uHdr, vUv - d * ca).b);
  vec3 b = textureLod(uHdr, vUv, 1.5).rgb * 0.3 + textureLod(uHdr, vUv, 3.0).rgb * 0.3
         + textureLod(uHdr, vUv, 4.5).rgb * 0.25 + textureLod(uHdr, vUv, 6.0).rgb * 0.3;
  // an anamorphic streak: the bright parts stretched sideways, in the album's accent colour
  float fl = 0.0;
  for (int i = 1; i <= 6; i++) {
    float off = float(i) * 0.024, w = exp(-float(i) * 0.42);
    fl += dot(textureLod(uHdr, vUv + vec2(off, 0.0), 4.0).rgb + textureLod(uHdr, vUv - vec2(off, 0.0), 4.0).rgb, vec3(0.3333)) * w;
  }
  vec2 q = d * vec2(uAspect, 1.0);
  vec2 cu = clamp(vec2(q.x, -q.y) * 0.5 + 0.5, 0.0, 1.0);
  vec3 amb = mix(textureLod(uCov0, cu, 7.0).rgb, textureLod(uCov1, cu, 7.0).rgb, uMorph);
  vec3 bg = mix(uPal[0], uPal[2], vUv.y) * 0.03 + amb * 0.06 * smoothstep(1.2, 0.0, length(q));
  vec3 col = (bg + c + b * uBloom + uPal[1] * max(fl - 0.08, 0.0) * uFlare) * uLift;
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col *= mix(0.68, 1.0, smoothstep(1.25, 0.3, length(q)));
  col += (hash12(vUv * uRes + uFrame * 13.0) - 0.5) * 0.028;
  o = vec4(max(col, 0.0) * uFade, 1.0);
}`;

/* ---------------------------------------------------------------- small helpers */
let sup = null;
export function supported() {
  if (sup !== null) return sup;
  try {
    const c = document.createElement('canvas'); const g = c.getContext('webgl2');
    sup = !!(g && g.getExtension('EXT_color_buffer_float'));
    g?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { sup = false; }
  return sup;
}
const hexRgb = (h) => { const m = String(h || '').match(/^#?([0-9a-f]{6})$/i); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
/** five colours: the album's palette, lifted so that a dark cover still gives luminous ones */
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

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = (x) => { x = clamp(x, 0, 1); return x * x * x * (x * (x * 6 - 15) + 10); };
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/* 4×4 matrices, column-major */
function persp(fov, asp, n, f) { const t = 1 / Math.tan(fov / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0]; }
function lookAt(e, c, up) {
  let z = [e[0] - c[0], e[1] - c[1], e[2] - c[2]]; let l = Math.hypot(...z); z = z.map((v) => v / l);
  let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]]; l = Math.hypot(...x) || 1; x = x.map((v) => v / l);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -(x[0] * e[0] + x[1] * e[1] + x[2] * e[2]), -(y[0] * e[0] + y[1] * e[1] + y[2] * e[2]), -(z[0] * e[0] + z[1] * e[1] + z[2] * e[2]), 1];
}
function mul(a, b) { const o = new Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; } return o; }

/* the camera's shots: yaw (sideways), el (tilt of the cover away from you: 0 = face on), az (turn round
   the cover's axis), distance, field of view, where it looks, and the lens's aperture (depth of field) */
function shotAt(s, t) {
  switch (s) {
    case 'land': return { yaw: 0, el: 1.16 + 0.05 * Math.sin(t * 0.05), az: 0.38 * Math.sin(t * 0.043), d: 1.08, fov: 0.95, tx: 0, ty: 0.16, tz: 0.08, ap: 0.03, rl: 2.4 };
    case 'orbit': return { yaw: 0, el: 0.6 + 0.12 * Math.sin(t * 0.07), az: t * 0.11, d: 1.9, fov: 0.7, tx: 0, ty: 0, tz: 0.03, ap: 0.014, rl: 1.5 };
    case 'macro': return { yaw: 0.22 * Math.sin(t * 0.031), el: 0.3, az: 0.2 * Math.sin(t * 0.027), d: 0.78, fov: 0.62, tx: 0.21 * Math.sin(t * 0.05), ty: 0.17 * Math.sin(t * 0.037 + 1), tz: 0.05, ap: 0.04, rl: 1.3 };
    default: return { yaw: 0.09 * Math.sin(t * 0.07), el: 0.06 + 0.05 * Math.sin(t * 0.05), az: 0, d: 1.95 - 0.05 * Math.sin(t * 0.11), fov: 0.7, tx: 0, ty: 0, tz: 0.02, ap: 0.008, rl: 1 };
  }
}
function blendShot(a, b, k) {
  const o = {}; for (const key in a) o[key] = a[key] + (b[key] - a[key]) * k;
  o.az = a.az + wrapA(b.az - a.az) * k;
  return o;
}
/* how much the music may move the picture */
const ENERGY = { calm: { base: 0, gain: 0.4, burst: 0.45 }, live: { base: 0, gain: 0.7, burst: 1 }, wild: { base: 0.12, gain: 1.15, burst: 1.6 } };

const GW = 144, GH = 80, WORLD = [1.8, 1.0];        // the fluid's grid and the part of the world it covers
const TEXT_SHARE = 0.34;                             // the share of particles that can write a line

/* ---------------------------------------------------------------- a stage: the visualiser on screen */
export class Stage {
  /** host: the element to fill; opts: { kind: 'canvas' | 'backdrop', playing(), track(), cover() → url,
   *  lyric() → the line sung now ('' between lines), onPreset(shot, why) } */
  constructor(host, opts) {
    this.host = host; this.o = opts; this.on = false; this.raf = 0; this.q = 1; this.drawShare = 1; this.frameN = 0;
    this.sf = surface(); this.cv = this.sf.vis;
    host.append(this.cv);
    this.ro = new ResizeObserver(() => this.size());
    this.gov = { at: performance.now(), n: 0, sum: 0 };
    this.key = ''; this.coverUrl = null; this.cur = ''; this.t = Math.random() * 100; this.fade = 0;
    this.S = opts.kind === 'backdrop' ? 128 : 256;
    this.eF = 0; this.eS = 0.3; this.free = 0; this.kick = 0; this.burst = 0; this.ring = 2; this.ringAmp = 0;
    this.lastBeats = -1; this.beatN = 0; this.lastDrop = 0; this.intro = 0; this.morph = 1;
    this.words = 0; this.wordsWant = 0; this.wordText = null;
    this.shotFrom = null; this.shotAt = 0; this.shotBeats = 0; this.splats = [];
    this.dbg = null;                                     // tests: { free, words } held fixed
    Stage.last = this;
  }
  init() {
    const gl = this.sf.target.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('no WebGL 2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no float render targets');
    this.gl = gl;
    this.maxPt = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || [1, 64])[1];
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = (fs, vs = VS) => {
      const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'aP'); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
      return { p, u };
    };
    this.P = { splat: prog(SPLAT), curl: prog(CURL), vort: prog(VORT), div: prog(DIV), pres: prog(PRES), grad: prog(GRAD), adv: prog(ADV), sim: prog(PSIM), fade: prog(FADE), comp: prog(COMP), pts: prog(PFS, PVS) };
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vaoPts = gl.createVertexArray();
    // the fluid
    const f16 = () => this.tex(GW, GH, gl.RGBA16F, gl.HALF_FLOAT, gl.LINEAR);
    this.fl = { v: [f16(), f16()].map((t) => this.fbo([t])), p: [f16(), f16()].map((t) => this.fbo([t])), div: this.fbo([f16()]), curl: this.fbo([f16()]), i: 0, pi: 0 };
    // the particles
    const S = this.S, n = S * S;
    const pos = new Float32Array(n * 4), vel = new Float32Array(n * 4);
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (let i = 0; i < n; i++) {
      const u = ((i % S) + 0.5) / S - 0.5, v = (Math.floor(i / S) + 0.5) / S - 0.5;
      if (calm) { pos[i * 4] = u; pos[i * 4 + 1] = v; pos[i * 4 + 2] = 0; }
      else {                                            // the first time: they fly in from a cloud around you
        const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1), r = 1.2 + Math.random() * 1.8;
        pos[i * 4] = r * Math.sin(ph) * Math.cos(th) * 1.6; pos[i * 4 + 1] = r * Math.sin(ph) * Math.sin(th); pos[i * 4 + 2] = r * Math.cos(ph) * 0.8;
      }
      pos[i * 4 + 3] = Math.random();
    }
    const f32 = (data) => this.tex(S, S, gl.RGBA32F, gl.FLOAT, gl.NEAREST, data);
    this.parts = [0, 1].map((k) => this.fbo([f32(k ? null : pos), f32(k ? null : vel)], k === 1));
    this.pi = 0;
    this.text = f32(null);
    this.textBuf = new Float32Array(n * 4);
    // the share that writes the words: spread evenly over the picture, in a random order
    const idx = []; for (let i = 0; i < n; i++) if (((i * 2654435761) >>> 0) / 4294967296 < TEXT_SHARE) idx.push(i);
    for (let i = idx.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [idx[i], idx[j]] = [idx[j], idx[i]]; }
    this.textIdx = idx;
    // the sound, the covers
    this.spec = this.tex(64, 1, gl.R8, gl.UNSIGNED_BYTE, gl.LINEAR); this.specBuf = new Uint8Array(64);
    const fb = this.fallbackCover();
    this.cov = [this.coverTex(fb), this.coverTex(fb)];
    this.morph = 1;
    this.sf.target.addEventListener?.('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    this.sf.target.addEventListener?.('webglcontextrestored', () => { this.lost = false; this.gl = null; this.hdr = null; try { this.init(); this.coverUrl = null; this.size(true); } catch (err) { log('aura: restore failed', err.message); } });
  }
  tex(w, h, internal, type, filter, data = null) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const fmt = internal === gl.R8 ? gl.RED : gl.RGBA;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, fmt, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  fbo(texs, clear = true) {
    const gl = this.gl, fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, t: texs[0], t2: texs[1] };
  }
  /** a fullscreen pass: program, target (null: the screen), size, textures by uniform name, other uniforms */
  pass(pr, target, w, h, texs, set) {
    const gl = this.gl;
    gl.useProgram(pr.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    let unit = 0;
    for (const [name, t] of Object.entries(texs)) { if (pr.u[name] == null) continue; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(pr.u[name], unit); unit++; }
    if (pr.u.uTx) gl.uniform2f(pr.u.uTx, 1 / w, 1 / h);
    set && set(pr.u);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  /** the album's palette as a soft picture, for an album without a cover */
  fallbackCover() {
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
    const P = palette().map(([r, g, b]) => `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`);
    x.fillStyle = P[0]; x.fillRect(0, 0, 256, 256);
    [[60, 70, P[1]], [200, 90, P[2]], [120, 200, P[3]], [220, 220, P[4]]].forEach(([cx, cy, col]) => { const g = x.createRadialGradient(cx, cy, 0, cx, cy, 150); g.addColorStop(0, col); g.addColorStop(1, 'transparent'); x.fillStyle = g; x.fillRect(0, 0, 256, 256); });
    return c;
  }
  coverTex(src) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);   // row 0 = the top (flipY does not apply to ImageBitmaps)
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  /** a new picture: the one shown so far becomes «from», the particles change colour on the way */
  setCover(src) {
    const gl = this.gl; if (!gl) return;
    const was = this.cov;
    const from = this.morph >= 0.5 ? was[1] : was[0];
    const drop = from === was[1] ? was[0] : was[1];
    gl.deleteTexture(drop);
    this.cov = [from, this.coverTex(src)];
    this.morph = this.coverOnce ? 0 : 1;
    this.coverOnce = true;
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
    this.setCover(bmp || this.fallbackCover());
    bmp?.close();
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
  /* the picture's size: up to ~1920 px wide (× the governor), the backdrop small (it is blurred anyway) */
  size(force) {
    const gl = this.gl; if (!gl) return;
    const r = this.host.getBoundingClientRect();
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    const max = (this.o.kind === 'backdrop' ? 640 : 1920) * this.q;
    const k = Math.min(dpr, max / Math.max(64, r.width));
    const w = Math.max(64, Math.round(r.width * k)), h = Math.max(36, Math.round(r.height * k));
    if (!force && this.W === w && this.H === h && this.hdr) return;
    this.sf.resize(w, h);
    this.W = w; this.H = h;
    if (this.hdr) for (const x of this.hdr) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.fb); }
    const mk = () => {
      const t = this.tex(w, h, gl.RGBA16F, gl.HALF_FLOAT, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      return this.fbo([t]);
    };
    this.hdr = [mk(), mk()]; this.hi = 0;
  }
  fps() { return !this.o.playing() ? 30 : this.o.kind === 'backdrop' || settings.motionFps === 'eco' ? 30 : 60; }
  /* the quality governor: late frames lower the resolution (then the number of particles drawn), a calm
     GPU raises them again; never more often than every 3 s, and not in the first seconds */
  govern(now, dt) {
    const g = this.gov; g.n++; g.sum += dt;
    if (now - g.at < 3000) return;
    const avg = g.sum / g.n; g.at = now; g.n = 0; g.sum = 0;
    if (now - this.started < 4000) return;
    const target = 1 / this.fps(), q = this.q, s = this.drawShare;
    if (avg > target * 1.35) { if (q > 0.5) this.q = Math.max(0.5, q * 0.8); else this.drawShare = Math.max(0.35, s * 0.8); }
    else if (avg < target * 1.08) { if (s < 1) this.drawShare = Math.min(1, s * 1.15); else if (q < 1) this.q = Math.min(1, q * 1.12); }
    if (this.q !== q || this.drawShare !== s) { log('visuals: quality', this.q.toFixed(2), this.drawShare.toFixed(2)); if (this.q !== q) this.size(); }
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
      this.music(f, dt, now, playing);
      if (this.frameN % 6 === 0) this.lyrics();
      try { this.draw(f, dt); this.sf.show(); } catch (e) { log('aura: draw', e.message); }
      this.govern(now, dt);
      const t = this.o.track && this.o.track(), key = t ? String(t.handle || t.path || t.title || '') : '';
      if (key !== this.key) { const had = this.key; this.key = key; if (had && key) { this.kick = 1; this.burst = 1.2; this.splatBurst(5); this.next('track'); } }
      if (this.frameN % 30 === 0) this.loadCover();
      const fps = this.fps();
      if (fps < 60) this.raf = setTimeout(() => { this.raf = requestAnimationFrame(tick); }, Math.max(0, 1000 / fps - 4));
      else this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  /* ------------------------------------------------ what the music does */
  music(f, dt, now, playing) {
    this.now = now;
    const prof = ENERGY[settings.gfEnergy] || ENERGY.live;
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const E = f.level * 0.55 + f.bass * 0.45;
    this.eF += (E - this.eF) * (1 - Math.exp(-dt / 0.35));
    this.eS += (E - this.eS) * (1 - Math.exp(-dt / 7));
    const surge = clamp((this.eF - this.eS * 0.92) * 3.2, 0, 1);
    let want = playing ? prof.base + surge * prof.gain + f.bass * 0.12 * prof.gain : 0;
    if (calm) want *= 0.35;
    this.free += (want - this.free) * (1 - Math.exp(-dt / (want > this.free ? 0.3 : 1.4)));
    if (this.dbg && this.dbg.free != null) this.free = this.dbg.free;
    this.kick *= Math.exp(-dt / 0.75);
    this.burst *= Math.exp(-dt / 0.14);
    this.intro = Math.min(1, this.intro + dt / 2.6);
    this.morph = Math.min(1, this.morph + dt / 1.7);
    this.ring += dt * 1.3; this.ringAmp *= Math.exp(-dt / 0.5);
    // a beat: a ring through the picture, a puff in the fluid; every fourth one a push outwards
    if (f.beats !== this.lastBeats) {
      if (this.lastBeats >= 0 && playing) {
        this.ring = 0; this.ringAmp = Math.min(1, 0.4 + f.beat * 0.6) * (calm ? 0.4 : 1);
        this.beatN++; this.shotBeats++;
        const a = Math.random() * Math.PI * 2, g = (1.2 + f.bass * 2) * prof.gain * (calm ? 0.3 : 1);
        this.splats.push([(Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 1.4, Math.cos(a) * g, Math.sin(a) * g, 0.28]);
        if (this.beatN % 4 === 0 && !calm) this.burst = Math.max(this.burst, 0.55 * prof.burst * (0.5 + f.bass));
      }
      this.lastBeats = f.beats;
    }
    // a drop: everything into the air, and another shot
    if (playing && !calm && this.eF - this.eS > 0.26 && now - this.lastDrop > 14000 && now - this.started > 6000) {
      this.lastDrop = now; this.kick = Math.max(this.kick, 0.75 * Math.min(1, prof.burst)); this.burst = 0.9 * prof.burst; this.splatBurst(4);
      if (this.auto()) this.next('drop');
    }
    // the director: a new shot every phrase (about 32 beats, or 28 s without a beat)
    if (this.auto() && playing && now - this.shotAt > 18000 && (this.shotBeats >= 32 || now - this.shotAt > 28000)) this.next('phrase');
    this.words += (this.wordsWant - this.words) * (1 - Math.exp(-dt / (this.wordsWant > this.words ? 0.35 : 0.6)));
  }
  splatBurst(n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, g = 2.5 + Math.random() * 2;
      this.splats.push([Math.cos(a) * 0.5, Math.sin(a) * 0.35, Math.cos(a) * g, Math.sin(a) * g, 0.35]);
      this.splats.push([(Math.random() - 0.5) * 2, (Math.random() - 0.5) * 1.2, (Math.random() > 0.5 ? 1 : -1) * (2 + Math.random() * 2), 0, -0.3]);
    }
  }
  auto() { return !settings.gfScene || settings.gfScene === 'auto'; }
  /* ------------------------------------------------ the words */
  lyrics() {
    const want = this.o.kind === 'canvas' && settings.gfWords !== false && this.o.lyric ? String(this.o.lyric() || '').trim() : '';
    if (want === this.wordText) return;
    this.wordText = want;
    if (!want) { this.wordsWant = 0; return; }
    if (this.writeLine(want)) this.wordsWant = 1;
  }
  /** a line → places for the particles that write it (a canvas, its lit pixels, spread over the share) */
  writeLine(text) {
    const gl = this.gl; if (!gl) return false;
    const CW = 1200, CH = 340;
    const c = this.tc || (this.tc = document.createElement('canvas')); c.width = CW; c.height = CH;
    const x = c.getContext('2d', { willReadFrequently: true });
    const fam = getComputedStyle(document.body).fontFamily || 'sans-serif';
    // up to two lines, as large as fits
    const words = text.split(/\s+/);
    let lines = [text];
    const fit = (ls) => { let fs = 150; for (; fs > 40; fs -= 6) { x.font = `800 ${fs}px ${fam}`; if (ls.every((l) => x.measureText(l).width < CW * 0.94) && fs * 1.08 * ls.length < CH * 0.95) break; } return fs; };
    let fs = fit(lines);
    if (fs < 96 && words.length > 1) {
      let best = null;
      for (let i = 1; i < words.length; i++) { const two = [words.slice(0, i).join(' '), words.slice(i).join(' ')]; const f2 = fit(two); if (!best || f2 > best.fs) best = { two, fs: f2 }; }
      if (best && best.fs > fs) { lines = best.two; fs = best.fs; }
    }
    x.clearRect(0, 0, CW, CH); x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = `800 ${fs}px ${fam}`;
    const lh = fs * 1.06;
    lines.forEach((l, i) => x.fillText(l, CW / 2, CH / 2 + (i - (lines.length - 1) / 2) * lh));
    const d = x.getImageData(0, 0, CW, CH).data;
    const pts = [];
    // one particle per lit cell of about the cover's own spacing: the letters as dense as the picture, never a blob
    for (let py = 1; py < CH; py += 3) for (let px = 1; px < CW; px += 3) if (d[(py * CW + px) * 4 + 3] > 120) pts.push(px, py);
    const np = pts.length / 2; if (!np) return false;
    const buf = this.textBuf; buf.fill(0);
    const idx = this.textIdx, m = idx.length, TW = 1.75, TH = TW * CH / CW;
    // the lit cells, in a random order; more cells than particles: a random choice of them
    const order = new Uint32Array(np); for (let i = 0; i < np; i++) order[i] = i;
    for (let i = np - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
    for (let k = 0; k < Math.min(m, np); k++) {
      const p = order[k], j = idx[k] * 4;
      buf[j] = (pts[p * 2] / CW - 0.5) * TW;
      buf[j + 1] = -(pts[p * 2 + 1] / CH - 0.5) * TH;
      buf[j + 2] = 0.3 + (Math.random() - 0.5) * 0.02;
      buf[j + 3] = 1;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.text);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.S, this.S, gl.RGBA, gl.FLOAT, buf);
    return true;
  }
  /* ------------------------------------------------ the camera */
  camera(t, now) {
    const k = this.shotFrom ? ease((now - this.shotAt) / 3400) : 1;
    let s = shotAt(this.cur || 'face', t);
    if (this.shotFrom && k < 1) s = blendShot(shotAt(this.shotFrom, t), s, k);
    if (this.words > 0.01) s = blendShot(s, shotAt('face', t), this.words * 0.85);    // the words want to be read
    if (this.o.kind === 'backdrop') s = blendShot(s, { ...shotAt('face', t), d: 1.6 }, 0.7);
    const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw), ce = Math.cos(s.el), se = Math.sin(s.el), ca = Math.cos(s.az), sa = Math.sin(s.az);
    // the direction to the eye: rotY(yaw) · (0,0,1), then rotX(el), then rotZ(az)
    const v1 = [sy, 0, cy];
    const v2 = [v1[0], -v1[2] * se, v1[2] * ce];
    const dir = [v2[0] * ca - v2[1] * sa, v2[0] * sa + v2[1] * ca, v2[2]];
    const up = [-sa * ce, ca * ce, se];
    const tg = [s.tx, s.ty, s.tz];
    const eye = [tg[0] + dir[0] * s.d, tg[1] + dir[1] * s.d, tg[2] + dir[2] * s.d];
    const asp = this.W / this.H;
    // a narrow screen: step back so the cover still fits
    const fitK = asp < 1.2 ? 1.2 / asp : 1;
    const eye2 = [tg[0] + (eye[0] - tg[0]) * fitK, tg[1] + (eye[1] - tg[1]) * fitK, tg[2] + (eye[2] - tg[2]) * fitK];
    const mvp = mul(persp(s.fov, asp, 0.05, 30), lookAt(eye2, tg, up));
    return { mvp: new Float32Array(mvp), px: this.H / 2 / Math.tan(s.fov / 2), focus: s.d * fitK, ap: s.ap, rl: s.rl };
  }
  /* ------------------------------------------------ one frame */
  draw(f, dt) {
    const gl = this.gl; if (!gl || !this.hdr) return;
    const now = this.now || performance.now();
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const prof = ENERGY[settings.gfEnergy] || ENERGY.live;
    this.t += dt * (0.6 + f.level * 0.6) * (calm ? 0.5 : 1);
    this.frameN++;
    this.fade = Math.min(1, this.fade + dt / 1.2);
    const step = Math.min(dt, 1 / 30);
    for (let i = 0; i < 64; i++) this.specBuf[i] = Math.min(255, f.bands[i] * 255);
    gl.bindTexture(gl.TEXTURE_2D, this.spec); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RED, gl.UNSIGNED_BYTE, this.specBuf);
    gl.disable(gl.BLEND);
    // 1. the fluid: forces, vorticity, projection, advection
    const fl = this.fl, sp = this.splats.splice(0, 8);
    const th = this.t * 0.15, sw = (0.25 + f.mid * 1.2) * prof.gain * (calm ? 0.3 : 1) * step * 4;
    // two slow eddies turning the same way: the smoke swirls round the cover instead of shooting through it
    sp.length < 7 && sp.push([Math.cos(th) * 0.95, Math.sin(th) * 0.55, sw, 0, -0.5], [-Math.cos(th * 0.7) * 0.5, -Math.sin(th * 0.7) * 0.35, sw * 0.7, 0, -0.4]);
    const V = () => fl.v[fl.i], V2 = () => fl.v[1 - fl.i], swap = () => { fl.i = 1 - fl.i; };
    this.pass(this.P.splat, V2(), GW, GH, { uVel: V().t }, (u) => {
      gl.uniform2f(u.uWorld, WORLD[0], WORLD[1]); gl.uniform1i(u.uN, sp.length);
      const S4 = new Float32Array(32), R = new Float32Array(8);
      sp.forEach((s, i) => { S4.set(s.slice(0, 4), i * 4); R[i] = s[4]; });
      gl.uniform4fv(u.uS, S4); gl.uniform1fv(u.uR, R);
    }); swap();
    this.pass(this.P.curl, fl.curl, GW, GH, { uVel: V().t });
    this.pass(this.P.vort, V2(), GW, GH, { uVel: V().t, uCurl: fl.curl.t }, (u) => { gl.uniform1f(u.uConf, 0.6); gl.uniform1f(u.uDt, step); }); swap();
    this.pass(this.P.div, fl.div, GW, GH, { uVel: V().t });
    for (let i = 0; i < 18; i++) { this.pass(this.P.pres, fl.p[1 - fl.pi], GW, GH, { uP: fl.p[fl.pi].t, uDiv: fl.div.t }); fl.pi = 1 - fl.pi; }
    this.pass(this.P.grad, V2(), GW, GH, { uP: fl.p[fl.pi].t, uVel: V().t }); swap();
    this.pass(this.P.adv, V2(), GW, GH, { uVel: V().t }, (u) => { gl.uniform2f(u.uWorld, WORLD[0], WORLD[1]); gl.uniform1f(u.uDt, step); gl.uniform1f(u.uDiss, 0.7); }); swap();
    // 2. the particles
    const cam = this.camera(this.t, now);
    const src = this.parts[this.pi], dst = this.parts[1 - this.pi];
    this.pass(this.P.sim, dst, this.S, this.S, { uPos: src.t, uVel: src.t2, uFluid: V().t, uCov0: this.cov[0], uCov1: this.cov[1], uSpec: this.spec, uText: this.text }, (u) => {
      gl.uniform1f(u.uS, this.S); gl.uniform1f(u.uDt, step); gl.uniform1f(u.uT, this.t);
      gl.uniform1f(u.uFree, this.free); gl.uniform1f(u.uKick, this.kick > 0.02 ? this.kick : 0); gl.uniform1f(u.uBurst, this.burst * 3);
      gl.uniform1f(u.uMid, f.mid); gl.uniform1f(u.uTreb, f.treb);
      gl.uniform1f(u.uRing, this.ring); gl.uniform1f(u.uRingAmp, this.ringAmp);
      gl.uniform1f(u.uRelief, (calm ? 0.5 : 1) * (0.6 + 0.4 * prof.gain) * cam.rl); gl.uniform1f(u.uWords, this.words);
      gl.uniform1f(u.uMorph, this.morph); gl.uniform1f(u.uIntro, this.intro); gl.uniform1f(u.uLive, calm ? 0.4 : 1);
      gl.uniform2f(u.uWorld, WORLD[0], WORLD[1]);
    });
    this.pi = 1 - this.pi;
    // 3. the light: last frame faded (trails grow with the motion), the particles added on top
    const motion = clamp(this.free * 1.1 + this.kick, 0, 1);
    const keep = 0.3 + 0.55 * motion;
    const hs = this.hdr[this.hi], hd = this.hdr[1 - this.hi];
    this.pass(this.P.fade, hd, this.W, this.H, { uSrc: hs.t }, (u) => gl.uniform1f(u.uKeep, keep));
    const P = palette();
    gl.useProgram(this.P.pts.p);
    const pu = this.P.pts.u;
    [[pu.uPos, dst.t], [pu.uVel, dst.t2], [pu.uCov0, this.cov[0]], [pu.uCov1, this.cov[1]], [pu.uText, this.text]].forEach(([loc, t], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(loc, i); });
    gl.uniformMatrix4fv(pu.uMVP, false, cam.mvp);
    gl.uniform1f(pu.uS, this.S); gl.uniform1f(pu.uPx, cam.px); gl.uniform1f(pu.uMorph, this.morph);
    gl.uniform1f(pu.uFocus, cam.focus); gl.uniform2f(pu.uVp, this.W / 2, this.H / 2); gl.uniform1f(pu.uAp, cam.ap); gl.uniform1f(pu.uMaxPt, Math.min(40, this.H / 24, this.maxPt));
    gl.uniform1f(pu.uGain, (1 - keep) * (this.o.kind === 'backdrop' ? 1.1 : 1) * (1 + f.level * 0.15)); gl.uniform1f(pu.uWords, this.words); gl.uniform1f(pu.uDim, this.words * 0.55);
    gl.uniform3fv(pu.uHot, P[1]);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vaoPts);
    gl.drawArrays(gl.POINTS, 0, Math.round(this.S * this.S * this.drawShare));
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, hd.t); gl.generateMipmap(gl.TEXTURE_2D);
    this.hi = 1 - this.hi;
    // 4. on the screen: glow, streak, tone, grain
    this.pass(this.P.comp, null, this.W, this.H, { uHdr: hd.t, uCov0: this.cov[0], uCov1: this.cov[1] }, (u) => {
      gl.uniform1f(u.uMorph, this.morph); gl.uniform1f(u.uAspect, this.W / this.H); gl.uniform1f(u.uBeat, f.beat * (calm ? 0.3 : 1));
      gl.uniform1f(u.uFrame, this.frameN % 1000); gl.uniform1f(u.uFade, this.fade);
      gl.uniform1f(u.uBloom, 0.32 + f.level * 0.22); gl.uniform1f(u.uFlare, 0.09 + f.bass * 0.08); gl.uniform1f(u.uLift, this.o.kind === 'backdrop' ? 1.25 : 1.12);
      gl.uniform3fv(u.uPal, P.flat()); gl.uniform2f(u.uRes, this.W, this.H);
    });
  }
  /** another shot: 'next' | 'prev' | 'track' | 'drop' | 'phrase' | 'start' */
  next(why = 'next') {
    const fixed = settings.gfScene && settings.gfScene !== 'auto' && SCENES.includes(settings.gfScene) ? settings.gfScene : '';
    let s;
    if (why === 'next' || why === 'prev') {
      const i = SCENES.indexOf(this.cur);
      s = SCENES[(i + (why === 'prev' ? SCENES.length - 1 : 1) + SCENES.length) % SCENES.length];
    } else if (fixed) s = fixed;
    else if (why === 'start') s = 'face';
    else {
      // calm music: slower, wider shots; loud and danceable: the close and the moving ones too
      const t = this.o.track && this.o.track();
      const m = t ? moodOf(t) : null;
      const pick = m == null ? SCENES : m < 0.4 ? ['face', 'land', 'orbit'] : SCENES;
      const choices = pick.filter((x) => x !== this.cur);
      s = choices[Math.floor(Math.random() * choices.length)] || pick[0];
    }
    if (s === this.cur) return;
    this.shotFrom = this.cur || null; this.shotAt = this.now || performance.now(); this.shotBeats = 0;
    this.cur = s;
    this.o.onPreset && this.o.onPreset(s, why);
  }
  /** B: keep this shot (or go back to «Auto») */
  lock() {
    const keep = settings.gfScene === this.cur ? 'auto' : this.cur;
    setSetting('gfScene', keep);
    return keep === 'auto' ? '' : keep;
  }
}
