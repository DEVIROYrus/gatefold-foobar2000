/*
 * Gatefold · winfs.js — fullscreen that does not pin the window above everything.
 *
 * foo_ui_webview2 enters fullscreen with HWND_TOPMOST (so the window covers the
 * taskbar). The side effect: no other program can be shown on top of it. Right
 * after entering we drop the window back to the normal z-order with the
 * component's own window.setAlwaysOnTop(false). Windows still hides the taskbar
 * while a monitor-sized window is in the foreground, and any other window can
 * now come forward over it. settings.fullscreenTopmost restores the old way.
 */
import { call, ok } from './bridge.js';
import { settings } from './settings.js';

export async function unpin() {
  if (settings.fullscreenTopmost) return;
  await call('window.setAlwaysOnTop', { enabled: false });
}
export async function setFullscreen(enabled) {
  const r = await call('window.setFullscreen', { enabled });
  if (ok(r) && enabled) await unpin();
  return r;
}
