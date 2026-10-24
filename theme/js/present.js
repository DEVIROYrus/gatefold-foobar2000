/*
 * Gatefold · present.js — how the visualisers put their frames on the page.
 *
 * WebGL draws into an OffscreenCanvas that is not part of the page; each finished frame is handed to a
 * plain <canvas> with an ImageBitmap renderer (a zero-copy hand-over in Chromium). To the compositor the
 * page then holds an ordinary picture, not a live WebGL surface.
 *
 * Why: in foobar2000 the page is a WebView2 in «visual hosting» mode, which gets the mouse from the
 * player's window. A full-screen WebGL canvas could make Chromium present it through a helper window of
 * its own (its «Intermediate D3D Window»), which then lay over the player and took every mouse event — the
 * keyboard still worked, the mouse did nothing, a right click opened a foobar2000 menu. A picture handed
 * over frame by frame takes none of those paths.
 *
 * Where OffscreenCanvas or the bitmap renderer is missing, the visible canvas itself is drawn on.
 */
export function surface(className = 'md-canvas') {
  const vis = document.createElement('canvas');
  vis.className = className;
  let off = null, ctx = null;
  try {
    if (typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function') {
      const o = new OffscreenCanvas(vis.width, vis.height);
      ctx = vis.getContext('bitmaprenderer');
      if (ctx) off = o;
    }
  } catch { off = null; ctx = null; }
  const target = off || vis;
  return {
    vis,
    /** what WebGL draws on */
    target,
    offscreen: !!off,
    resize(w, h) {
      if (target.width !== w) target.width = w;
      if (target.height !== h) target.height = h;
      if (off) { if (vis.width !== w) vis.width = w; if (vis.height !== h) vis.height = h; }
    },
    /** the frame just drawn → on screen */
    show() {
      if (!off) return;
      try { ctx.transferFromImageBitmap(off.transferToImageBitmap()); } catch { /* a lost context: the next frame */ }
    },
  };
}
