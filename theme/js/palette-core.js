/*
 * Gatefold · palette-core.js
 * Pure colour science: no DOM access, so it runs identically in a Worker,
 * on the main thread (fallback) and in Node unit tests.
 *
 * Pipeline:
 *   RGBA pixels (64×64) → OKLab samples (weighted) → k-means++ (deterministic)
 *   → merged clusters → role assignment (bg / surface / text / accent …)
 *   → WCAG contrast enforcement → gamut-mapped sRGB → CSS strings.
 *
 * Why OKLab: Euclidean distance there tracks perceived difference far better
 * than RGB or HSL, so clusters correspond to colours a human would name, and
 * lightness/chroma edits do not shift the perceived hue (HSL "darken" turns
 * yellow into olive; OKLCH keeps it yellow).
 */
(function (root) {
  'use strict';

  // ---------- colour space conversions ----------
  const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

  function linearRgbToOklab(r, g, b) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  function oklabToLinearRgb(L, a, b) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }

  const toLch = (L, a, b) => {
    const C = Math.hypot(a, b);
    let h = (Math.atan2(b, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return { L, C, h };
  };
  const fromLch = (L, C, h) => {
    const r = (h * Math.PI) / 180;
    return [L, C * Math.cos(r), C * Math.sin(r)];
  };

  const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

  /** OKLCH → sRGB (0..1) with chroma reduction until inside the sRGB gamut
   *  (hue and lightness preserved — the CSS Color 4 recommended approach). */
  function lchToSrgb(L, C, h) {
    L = Math.min(1, Math.max(0, L));
    let lin = oklabToLinearRgb(...fromLch(L, C, h));
    if (!inGamut(lin)) {
      let lo = 0, hi = C;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        lin = oklabToLinearRgb(...fromLch(L, mid, h));
        if (inGamut(lin)) lo = mid; else hi = mid;
      }
      lin = oklabToLinearRgb(...fromLch(L, lo, h));
    }
    return lin.map((v) => Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, v))))));
  }

  const hex2 = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  const srgbHex = (rgb) => '#' + rgb.map(hex2).join('');

  function relLuminance(rgb) {
    const [r, g, b] = rgb.map(srgbToLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(rgbA, rgbB) {
    const a = relLuminance(rgbA), b = relLuminance(rgbB);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  const hueDist = (a, b) => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------- deterministic RNG for reproducible k-means ----------
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Sample pixels → weighted OKLab points.
   * Weighting: a slight centre bias (subjects usually sit in the middle,
   * borders are often frames/white margins), transparent pixels dropped.
   */
  function samplePixels(data, w, h) {
    const n = w * h;
    const pts = new Float32Array(n * 3);
    const wts = new Float32Array(n);
    let k = 0;
    const cx = (w - 1) / 2, cy = (h - 1) / 2, rmax = Math.hypot(cx, cy);
    // LUT: sRGB byte → linear
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 128) continue;
        const lab = linearRgbToOklab(lut[data[i]], lut[data[i + 1]], lut[data[i + 2]]);
        const d = Math.hypot(x - cx, y - cy) / rmax;
        pts[k * 3] = lab[0]; pts[k * 3 + 1] = lab[1]; pts[k * 3 + 2] = lab[2];
        wts[k] = 1.15 - 0.35 * d;
        k++;
      }
    }
    return { pts: pts.subarray(0, k * 3), wts: wts.subarray(0, k), n: k };
  }

  /** Weighted k-means++ in OKLab. Lightness differences are slightly
   *  down-weighted so shading of one surface does not split into clusters. */
  function kmeans(sample, K, iters) {
    const { pts, wts, n } = sample;
    if (n === 0) return [];
    const rnd = mulberry32(0x5eed);
    const LW = 0.7;
    const dist2 = (i, c) => {
      const dL = (pts[i * 3] - c[0]) * LW, da = pts[i * 3 + 1] - c[1], db = pts[i * 3 + 2] - c[2];
      return dL * dL + da * da + db * db;
    };
    // k-means++ seeding
    const cents = [];
    const first = Math.floor(rnd() * n);
    cents.push([pts[first * 3], pts[first * 3 + 1], pts[first * 3 + 2]]);
    const dmin = new Float64Array(n).fill(Infinity);
    while (cents.length < K) {
      let total = 0;
      const c = cents[cents.length - 1];
      for (let i = 0; i < n; i++) {
        const d = dist2(i, c);
        if (d < dmin[i]) dmin[i] = d;
        total += dmin[i] * wts[i];
      }
      if (total <= 1e-12) break;
      let r = rnd() * total, pick = n - 1;
      for (let i = 0; i < n; i++) { r -= dmin[i] * wts[i]; if (r <= 0) { pick = i; break; } }
      cents.push([pts[pick * 3], pts[pick * 3 + 1], pts[pick * 3 + 2]]);
    }
    const k = cents.length;
    const assign = new Int32Array(n);
    for (let it = 0; it < iters; it++) {
      const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
      let moved = 0;
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        for (let j = 0; j < k; j++) { const d = dist2(i, cents[j]); if (d < bd) { bd = d; best = j; } }
        if (assign[i] !== best) moved++;
        assign[i] = best;
        const s = sum[best], w = wts[i];
        s[0] += pts[i * 3] * w; s[1] += pts[i * 3 + 1] * w; s[2] += pts[i * 3 + 2] * w; s[3] += w;
      }
      for (let j = 0; j < k; j++) if (sum[j][3] > 0) cents[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
      if (it > 2 && moved === 0) break;
    }
    // final shares
    const wsum = new Float64Array(k);
    let total = 0;
    for (let i = 0; i < n; i++) { wsum[assign[i]] += wts[i]; total += wts[i]; }
    return cents
      .map((c, j) => ({ lab: c, share: wsum[j] / total, ...toLch(c[0], c[1], c[2]) }))
      .filter((c) => c.share > 0.004);
  }

  /** Merge perceptually near-identical clusters (ΔE_ok < 0.045). */
  function mergeClusters(cl) {
    const out = [];
    cl.sort((a, b) => b.share - a.share);
    for (const c of cl) {
      const m = out.find((o) => Math.hypot(o.lab[0] - c.lab[0], o.lab[1] - c.lab[1], o.lab[2] - c.lab[2]) < 0.045);
      if (m) {
        const t = m.share + c.share;
        m.lab = m.lab.map((v, i) => (v * m.share + c.lab[i] * c.share) / t);
        m.share = t;
        Object.assign(m, toLch(...m.lab));
      } else out.push({ ...c });
    }
    return out.sort((a, b) => b.share - a.share);
  }

  // ---------- role assignment ----------
  const css = (L, C, h) => `oklch(${(L * 100).toFixed(1)}% ${C.toFixed(4)} ${h.toFixed(1)})`;

  /** Raise/lower L of a colour until it reaches `target` contrast vs `bgRgb`. */
  function enforceContrast(col, bgRgb, target, dir) {
    let { L, C, h } = col;
    for (let i = 0; i < 60; i++) {
      const rgb = lchToSrgb(L, C, h);
      if (contrast(rgb, bgRgb) >= target) return { L, C, h, rgb };
      L = clamp(L + dir * 0.012, 0, 1);
      if (L <= 0 || L >= 1) break;
    }
    return { L, C, h, rgb: lchToSrgb(L, C, h) };
  }

  /**
   * Build a complete UI palette from clusters.
   * opts: { mode: 'auto'|'dark'|'light', intensity: 0..1.5 }
   */
  function buildPalette(clusters, opts) {
    opts = opts || {};
    const intensity = opts.intensity == null ? 1 : opts.intensity;
    if (!clusters.length) clusters = [{ L: 0.3, C: 0.02, h: 260, share: 1, lab: [0.3, 0, -0.02] }];

    const dom = clusters[0];
    const avgL = clusters.reduce((s, c) => s + c.L * c.share, 0);
    const colorfulness = clusters.reduce((s, c) => s + c.C * c.share, 0);
    // Hue of the "colourful mass": average of chromatic clusters weighted by share×C
    let hx = 0, hy = 0;
    for (const c of clusters) {
      const w = c.share * c.C;
      hx += Math.cos((c.h * Math.PI) / 180) * w; hy += Math.sin((c.h * Math.PI) / 180) * w;
    }
    let massHue = (Math.atan2(hy, hx) * 180) / Math.PI; if (massHue < 0) massHue += 360;

    let dark = true;
    if (opts.mode === 'light') dark = false;
    else if (opts.mode === 'auto') dark = !(avgL > 0.74 && dom.L > 0.78 && dom.share > 0.35);

    // ---- accent: vivid, sufficiently present, not near-black/white ----
    const scoreAccent = (c) => {
      if (c.C < 0.035 || c.L < 0.18 || c.L > 0.97) return -1;
      const presence = Math.sqrt(Math.min(c.share, 0.35));
      const lightFit = 1 - Math.abs(c.L - 0.64) * 0.9;
      return presence * Math.pow(c.C, 0.9) * lightFit;
    };
    const ranked = clusters.map((c) => ({ c, s: scoreAccent(c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    const monochrome = ranked.length === 0;
    let acc = monochrome ? { L: 0.8, C: Math.min(0.03, dom.C + 0.01), h: dom.C > 0.01 ? dom.h : 250 } : { ...ranked[0].c };
    const acc2Src = ranked.find((x) => hueDist(x.c.h, acc.h) > 28);
    let acc2 = acc2Src ? { ...acc2Src.c } : { L: acc.L, C: acc.C * 0.85, h: (acc.h + 38) % 360 };

    // ---- background: tinted by dominant hue, or by colourful mass when dominant is grey ----
    const bgHue = dom.C > 0.025 ? dom.h : (colorfulness > 0.02 ? massHue : acc.h);
    const bgChromaSrc = Math.max(dom.C, colorfulness * 0.8);
    const bg = dark
      ? { L: clamp(0.155 + dom.L * 0.06, 0.15, 0.215), C: clamp(bgChromaSrc * 0.42 * intensity, 0.006, 0.052), h: bgHue }
      : { L: clamp(0.955 + (dom.L - 0.9) * 0.08, 0.93, 0.975), C: clamp(bgChromaSrc * 0.22 * intensity, 0.004, 0.03), h: bgHue };
    const bgRgb = lchToSrgb(bg.L, bg.C, bg.h);

    const sign = dark ? 1 : -1;
    const surface = { L: bg.L + sign * 0.038, C: bg.C * 1.05, h: bg.h };
    const surface2 = { L: bg.L + sign * 0.075, C: bg.C * 1.1, h: bg.h };
    const surfaceRgb = lchToSrgb(surface.L, surface.C, surface.h);

    // ---- text: slight hue tint ties text to the album; contrast is enforced on both bg and surface ----
    const tC = Math.min(0.018, bg.C * 0.5);
    let text = dark ? { L: 0.965, C: tC * 0.6, h: bg.h } : { L: 0.2, C: tC, h: bg.h };
    let text2 = dark ? { L: 0.8, C: tC, h: bg.h } : { L: 0.4, C: tC, h: bg.h };
    let text3 = dark ? { L: 0.64, C: tC, h: bg.h } : { L: 0.54, C: tC, h: bg.h };
    const worst = contrast(bgRgb, [1, 1, 1]) < contrast(surfaceRgb, [1, 1, 1]) === dark ? bgRgb : surfaceRgb;
    text = enforceContrast(text, worst, 12, sign);
    text2 = enforceContrast(text2, worst, 6.2, sign);
    text3 = enforceContrast(text3, worst, 4.0, sign);

    // ---- accent normalisation ----
    const accC = clamp(acc.C * 1.08 * intensity, monochrome ? 0 : 0.06, 0.2);
    // Fill accent (seek bar, play button, selection) may stay vivid; "ink" accent
    // is used for text/icons on the background and must meet 4.5:1.
    // Light mode keeps yellows/limes bright for fills instead of turning them olive.
    acc = dark
      ? { L: clamp(acc.L, 0.7, 0.86), C: accC, h: acc.h }
      : { L: clamp(acc.L, 0.5, 0.78), C: accC, h: acc.h };
    acc = enforceContrast(acc, worst, dark ? 3.2 : 2.1, sign);
    const accInk = enforceContrast({ L: acc.L, C: acc.C, h: acc.h }, worst, 4.6, sign);
    acc2 = dark
      ? { L: clamp(acc2.L, 0.66, 0.84), C: clamp(acc2.C * intensity, 0.04, 0.19), h: acc2.h }
      : { L: clamp(acc2.L, 0.44, 0.6), C: clamp(acc2.C * intensity, 0.04, 0.19), h: acc2.h };
    acc2 = enforceContrast(acc2, worst, 2.6, sign);
    const accRgb = lchToSrgb(acc.L, acc.C, acc.h);
    const onAccentDark = lchToSrgb(0.17, 0.02, acc.h), onAccentLight = [1, 1, 1];
    const onAccent = contrast(accRgb, onAccentDark) >= contrast(accRgb, onAccentLight) ? { L: 0.17, C: 0.02, h: acc.h } : { L: 1, C: 0, h: 0 };

    // ---- ambient blobs: the cover's real colour structure, re-lit for the theme ----
    const blobSrc = clusters.slice(0, 5).filter((c) => c.share > 0.03);
    while (blobSrc.length < 4) blobSrc.push(blobSrc.length % 2 ? { ...acc } : { ...acc2, share: 0.1 });
    const blobs = blobSrc.slice(0, 4).map((c, i) => {
      const C = clamp(Math.max(c.C, i === 3 ? acc.C * 0.8 : 0) * 1.15 * intensity, 0.01, 0.17);
      return dark
        ? { L: clamp(c.L * 0.55 + 0.14, 0.24, 0.5), C, h: c.h }
        : { L: clamp(0.78 + c.L * 0.14, 0.8, 0.93), C: C * 0.75, h: c.h };
    });
    // Ensure the accent hue is represented in at least one blob (synergy with controls)
    if (!blobs.some((b) => hueDist(b.h, acc.h) < 25) && !monochrome) {
      blobs[3] = dark ? { L: 0.42, C: clamp(acc.C * 0.9, 0.04, 0.16), h: acc.h } : { L: 0.84, C: clamp(acc.C * 0.6, 0.03, 0.1), h: acc.h };
    }
    const glow = { L: dark ? 0.55 : 0.62, C: clamp(acc.C, 0.03, 0.18), h: acc.h };

    const pack = (c) => ({ css: css(c.L, c.C, c.h), hex: srgbHex(lchToSrgb(c.L, c.C, c.h)), L: c.L, C: c.C, h: c.h });
    return {
      dark,
      monochrome,
      stats: { avgL, colorfulness, clusters: clusters.length },
      bg: pack(bg), surface: pack(surface), surface2: pack(surface2),
      text: pack(text), text2: pack(text2), text3: pack(text3),
      accent: pack(acc), accentInk: pack(accInk), accent2: pack(acc2), onAccent: pack(onAccent), glow: pack(glow),
      blobs: blobs.map(pack),
      swatches: clusters.slice(0, 8).map((c) => ({ hex: srgbHex(lchToSrgb(c.L, c.C, c.h)), share: +c.share.toFixed(3) })),
    };
  }

  function analyze(data, w, h, opts) {
    const sample = samplePixels(data, w, h);
    const clusters = mergeClusters(kmeans(sample, 8, 14));
    return { clusters, palette: buildPalette(clusters, opts) };
  }

  const PaletteCore = {
    analyze, buildPalette, kmeans, mergeClusters, samplePixels,
    lchToSrgb, srgbHex, contrast, relLuminance, linearRgbToOklab, srgbToLinear, toLch,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PaletteCore;
  else root.PaletteCore = PaletteCore;
})(typeof self !== 'undefined' ? self : this);
