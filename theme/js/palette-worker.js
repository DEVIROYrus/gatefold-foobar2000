/* Gatefold · palette worker — keeps k-means off the UI thread so track changes never stutter. */
importScripts('palette-core.js');
self.onmessage = (e) => {
  const { id, buffer, w, h, opts } = e.data;
  try {
    const r = self.PaletteCore.analyze(new Uint8ClampedArray(buffer), w, h, opts);
    self.postMessage({ id, ok: true, palette: r.palette, clusters: r.clusters.map((c) => ({ L: c.L, C: c.C, h: c.h, share: c.share, lab: c.lab })) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
