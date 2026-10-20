// mock-win.js — records taskbar.* and tray.* calls; window.getAllWindows knows the popups made here.
(() => {
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const W = window.__win = { calls: [], popups: [] };
  window.fb2k.invoke = async (m, p = {}) => {
    if (/^(taskbar|tray)\./.test(m)) { W.calls.push([m, p]); return ok({}); }
    if (m === 'window.createPopup') { const r = await base(m, p); W.popups.push(p); return { ...r, windowId: 'popup-' + W.popups.length }; }
    if (m === 'window.getAllWindows') return ok({ items: [{ windowId: 'main', isMain: true }, ...W.popups.map((x, i) => ({ windowId: 'popup-' + (i + 1), isMain: false, url: x.url }))] });
    if (m === 'window.focus' || m === 'window.startDrag' || m === 'window.setAlwaysOnTop' || m === 'window.close') { W.calls.push([m, p]); return ok({}); }
    return base(m, p);
  };
})();
