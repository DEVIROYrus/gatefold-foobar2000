/*
 * Gatefold · sched.js — a budget for background work that touches foobar's main thread.
 *
 * foo_ui_webview2 executes every bridge call on foobar2000's UI thread — the same
 * thread that pumps the window (and the WebView hosted in it). Background jobs
 * (library sweep, quality scan, thumbnail revalidation, embedding art) used to fire
 * calls back-to-back with a 15 ms pause: during scans foobar's UI thread was busy
 * a large share of the time and input/scrolling stuttered.
 *
 * Rules applied here, for every background call:
 *   1. wait until the user has been idle for a moment (1 s for 'low', 250 ms for
 *      'normal'); after 8 s of continuous activity proceed anyway (no starvation);
 *   2. duty cycle: after a call that took T ms, the next background call waits
 *      T·(1/duty − 1), so background work never holds more than `duty` of the
 *      thread (12 % low / 25 % normal; 50 % while the window is minimised);
 * Foreground calls (what the user just clicked) never go through here.
 */
import { call, sleep } from './bridge.js';

let lastInput = -1e9, nextAt = 0;
const mark = () => { lastInput = performance.now(); };
for (const e of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) addEventListener(e, mark, { passive: true, capture: true });

export const userIdleFor = () => performance.now() - lastInput;
const hidden = () => document.visibilityState === 'hidden';

let holder = null;   // an exclusive background call in flight (bgCall): others wait for it

export async function slot(priority = 'low', exclusive = false) {
  const quiet = priority === 'low' ? 1000 : 250;
  const t0 = performance.now();
  for (;;) {
    while (holder) await holder;
    const now = performance.now();
    const wInput = hidden() || now - t0 > 8000 ? 0 : quiet - (now - lastInput);
    const wDuty = nextAt - now;
    if (wInput <= 0 && wDuty <= 0) {
      if (holder) continue;
      if (exclusive) { let rel; holder = new Promise((r) => { rel = r; }); holder.rel = rel; }
      return;
    }
    await sleep(Math.min(400, Math.max(16, wInput, wDuty)));
  }
}

export function spent(ms, priority = 'low', exclusive = false) {
  // nobody touching the window for 20 s (or it is minimised) → background may use more of the thread
  const away = hidden() ? 2 : userIdleFor() > 20000 ? 1.6 : 1;
  const duty = Math.min(0.5, (priority === 'low' ? 0.12 : 0.25) * away);
  nextAt = Math.max(nextAt, performance.now() + Math.max(4, ms) * (1 / duty - 1));
  if (exclusive && holder) { const h = holder; holder = null; h.rel(); }
}

/** A bridge call made on behalf of background work (serialised with other background calls). */
export async function bgCall(method, params, priority = 'low') {
  await slot(priority, true);
  const t = performance.now();
  try { return await call(method, params); }
  finally { spent(performance.now() - t, priority, true); }
}

/** Yield to rendering between chunks of renderer-side work. */
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
export const idle = (timeout = 1500) => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout }) : setTimeout(r, 30)));
