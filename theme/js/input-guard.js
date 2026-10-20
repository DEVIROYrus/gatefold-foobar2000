/*
 * Gatefold · input-guard.js — keeps the mouse working.
 *
 * foo_ui_webview2 hosts the page with WebView2's composition controller and forwards every mouse
 * message to it by hand. If the page starts a native drag-and-drop (an image, a link or a text
 * selection pulled a few pixels while pressed), Windows' drag loop takes the mouse and the page
 * never hears how it ended: Blink stays «in a drag» and drops every click, while the cursor still
 * moves and the wheel still scrolls. Nothing but a reload brings the clicks back.
 *
 *   · Native drag-and-drop is never started from the page: Gatefold has no use for it (playlist
 *     rows and sidebar playlists are dragged with pointer events; files dropped *onto* the
 *     window from Explorer are unaffected). Elements may opt in with data-native-drag.
 *     app.css also sets -webkit-user-drag: none on images and links.
 *   · Whenever the window loses the mouse or the focus, the page's own drag states are reset
 *     (event 'gatefold:input-reset'), so no half-finished drag survives an Alt+Tab.
 * A lost button-up alone (window.startDrag, a native menu) heals itself on the next mouse move.
 */
addEventListener('dragstart', (e) => {
  if (e.target && e.target.closest && e.target.closest('[data-native-drag]')) return;
  e.preventDefault();
}, true);

const reset = () => dispatchEvent(new Event('gatefold:input-reset'));
addEventListener('blur', reset);
addEventListener('pointercancel', reset, true);
document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });

/* a button «held» while the physical button is up means the page missed a release: log it, so a
   report can say what happened just before */
let lastDown = 0, warned = 0;
addEventListener('pointerdown', () => { lastDown = performance.now(); }, { capture: true, passive: true });
addEventListener('pointerup', () => { lastDown = 0; }, { capture: true, passive: true });
addEventListener('pointermove', (e) => {
  if (!e.buttons || !lastDown) return;
  const now = performance.now();
  if (now - lastDown > 60000 && now - warned > 60000) { warned = now; console.warn('[Gatefold] mouse button reported held for a minute — a release was lost'); }
}, { capture: true, passive: true });
