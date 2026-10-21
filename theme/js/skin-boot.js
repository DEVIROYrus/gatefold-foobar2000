/* Gatefold · skin-boot.js — applies a chosen «Режим приколов» skin before the first paint
   (a classic script in <head>, so the page never flashes in the default look).
   Does nothing unless the mode is on and a skin is selected. */
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('aurora.settings.v1') || '{}');
    if (!s.funMode || document.documentElement.hasAttribute('data-panel')) return;
    var k = JSON.parse(localStorage.getItem('aurora.fun.skin') || 'null');
    if (!k || !/^(toon|pixel|metal)$/.test(k.id)) return;
    var r = document.documentElement, o = k.opt || {};
    r.setAttribute('data-skin', k.id);
    for (var key in o) if (Object.prototype.hasOwnProperty.call(o, key)) r.setAttribute('data-skin-opt-' + key, o[key] ? '1' : '0');
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = 'css/skins/' + k.id + '.css'; l.id = 'skinCss';
    document.head.appendChild(l);
  } catch (e) { /* no skin, default look */ }
})();
