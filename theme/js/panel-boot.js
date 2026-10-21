/* Gatefold · panel-boot.js — the full interface as a single-purpose panel for Default UI / Columns UI.
   The «gatefold-covers» template is this theme with data-panel="covers" on this script tag
   (tools/make_panels.py); ?panel=covers does the same for development. A classic script in <head>:
   the page never shows the full interface first. Settings that make no sense in a panel are
   overridden for its lifetime only (settings.js → GATEFOLD_OVERRIDES), never saved. */
(function () {
  var me = document.currentScript, p = (me && me.getAttribute('data-panel')) || '';
  try { if (!p) p = new URLSearchParams(location.search).get('panel') || ''; } catch (e) { /* no URL API */ }
  if (!/^(covers)$/.test(p)) return;
  document.documentElement.setAttribute('data-panel', p);
  window.GATEFOLD_OVERRIDES = { soundAI: false, funMode: false, startView: 'covers', canvasIdleMin: 0, waveformSeek: false, visualizer: false, beatReact: false };
})();
