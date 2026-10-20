/*
 * Gatefold · mini.js — opens the mini player (mini.html) from the main window: a frameless popup
 * with the component's «miniPlayer» preset (no taskbar button, stays on screen with Show desktop),
 * above other windows unless the user unpinned it. Opening it again brings the open one forward.
 */
import { call, ok } from './bridge.js';
import { settings } from './settings.js';
import { toast } from './ui.js';
import { $t } from './i18n.js';

const BOUNDS = 'gatefold.mini.bounds';
let id = '';

async function alive() {
  if (!id) return false;
  const all = await call('window.getAllWindows');
  return ok(all) && (all.items || all.windows || []).some((w) => (w.windowId || w.id) === id);
}

export async function open({ minimizeMain = false } = {}) {
  if (await alive()) { call('window.focus', { windowId: id }); return; }
  const dpr = devicePixelRatio || 1;
  const p = { url: 'mini.html', title: $t('Gatefold · Мини-плеер'), profile: 'miniPlayer', frame: false, resizable: true,
    alwaysOnTop: !!settings.miniTopmost, width: Math.round(400 * dpr), height: Math.round(112 * dpr),
    minWidth: Math.round(240 * dpr), minHeight: Math.round(72 * dpr), maxHeight: Math.round(200 * dpr) };
  let b = null; try { b = JSON.parse(localStorage.getItem(BOUNDS) || 'null'); } catch {}
  if (b && b.width > 100) Object.assign(p, { x: b.x, y: b.y, width: b.width, height: b.height });
  else {
    // first time: bottom-right corner of the screen this window is on
    const w = await call('window.getBounds');
    if (ok(w)) { p.x = Math.round((screen.availLeft || 0) * dpr + screen.availWidth * dpr - p.width - 24 * dpr); p.y = Math.round((screen.availTop || 0) * dpr + screen.availHeight * dpr - p.height - 24 * dpr); }
  }
  const r = await call('window.createPopup', p);
  if (!ok(r)) { toast($t('Не удалось открыть окно: ') + (r.error || r.code || '')); return; }
  id = r.windowId;
  if (minimizeMain) call('window.minimize');
}
export async function close() { if (await alive()) call('window.closePopup', { windowId: id }); id = ''; }
export const isOpen = alive;
