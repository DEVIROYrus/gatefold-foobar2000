# Request to foo_ui_webview2: a supported way to activate the UI and a template

*Draft issue for https://github.com/NereaFantasia/foo_ui_webview2 — feel free to post it.*

**Problem.** An installer can put foo_ui_webview2 and a theme in place, but two settings stay out of reach: choosing *Webview2 UI* as the user interface (foobar2000 core configuration) and choosing the active template (`cfg_active_template`). Writing foobar2000's configuration from outside is unsupported and fragile, so every theme installer has to end with “now open Preferences and click…”.

**Proposal** (any of these would do):
1. A one-shot activation file: if `<profile>\webview-ui\.activate` exists at start-up, the component reads a template name from it, makes that the active template, asks foobar2000 to switch to Webview2 UI (or shows a single confirmation), and deletes the file.
2. A command-line switch handled by the component, e.g. `foobar2000.exe /webview2-ui:activate=<template>`.
3. At minimum: an API call (`ui.setActiveTemplate`) plus a documented way to make Webview2 UI the user interface on next start.

Gatefold's installer would use it to finish the setup without any manual step; it already lays out the component exactly as foobar2000 does and only touches the profile while foobar2000 is closed.

---

# Request to foo_ui_webview2: a window icon of the theme's own

**Problem.** The main window and popups register their class with foobar2000's icon (`ui_control::get_main_icon`), so the taskbar button, Alt+Tab and the thumbnail show foobar2000 even when a theme brings its own identity. `tray.create` / `tray.setIcon` and `taskbar.setOverlayIcon` already take a base64 ICO; the window does not.

**Proposal.** `window.setIcon({ icon?: string /* base64 ICO, as tray.setIcon */, windowId? })` — `WM_SETICON` with `ICON_BIG` and `ICON_SMALL` on the caller's (or the given) top-level window; no `icon` restores foobar2000's. Optionally `window.setAppUserModelId` so a theme's pinned shortcut and its running window share one taskbar button.

---

# Request to foo_ui_webview2: release mouse buttons when the capture is lost

**Problem.** In composition (visual hosting) mode the host forwards mouse messages with `SendMouseInput` and calls `SetCapture` on button-down. If something else takes the capture before the button-up arrives — a modal move/size loop, an OLE drag-and-drop loop, a menu — `WM_LBUTTONUP` never reaches the host, so the page never gets `LEFT_BUTTON_UP`. When the page itself started a drag-and-drop, Blink then stays in the drag state for good: the cursor moves and the wheel scrolls, but every click is ignored until a reload. Gatefold works around it by never starting a native drag from the page (`dragstart` is cancelled), but any page can hit it.

**Proposal.** Handle `WM_CAPTURECHANGED` (and `WM_CANCELMODE`) in `MainWindow` / `PopupWindow`: when the host held the capture for a button, send the matching `*_BUTTON_UP` through `SendMouseInput` at the last known point and clear `isCapturingMouse_`. Also forward `WM_RBUTTONDOWN` inside drag regions only when `WM_RBUTTONUP` will be forwarded too (today the up is taken for the system menu, the down is not).
