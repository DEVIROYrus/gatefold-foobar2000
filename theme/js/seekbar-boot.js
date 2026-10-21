/* Gatefold · seekbar-boot.js — runs before the modules of seekbar.html: the panel's own colour
   source (album / dark / light / grey) overrides the full interface's for this page only. */
(function () {
  var p = {};
  try { p = JSON.parse(localStorage.getItem('gatefold.seekbar.v1') || '{}') || {}; } catch (e) { p = {}; }
  window.GATEFOLD_OVERRIDES = { colorSource: p.colors || 'album', ambient: false, funMode: false, soundAI: false };
})();
