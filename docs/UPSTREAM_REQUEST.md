# Request to foo_ui_webview2: a supported way to activate the UI and a template

*Draft issue for https://github.com/NereaFantasia/foo_ui_webview2 — feel free to post it.*

**Problem.** An installer can put foo_ui_webview2 and a theme in place, but two settings stay out of reach: choosing *Webview2 UI* as the user interface (foobar2000 core configuration) and choosing the active template (`cfg_active_template`). Writing foobar2000's configuration from outside is unsupported and fragile, so every theme installer has to end with “now open Preferences and click…”.

**Proposal** (any of these would do):
1. A one-shot activation file: if `<profile>\webview-ui\.activate` exists at start-up, the component reads a template name from it, makes that the active template, asks foobar2000 to switch to Webview2 UI (or shows a single confirmation), and deletes the file.
2. A command-line switch handled by the component, e.g. `foobar2000.exe /webview2-ui:activate=<template>`.
3. At minimum: an API call (`ui.setActiveTemplate`) plus a documented way to make Webview2 UI the user interface on next start.

Gatefold's installer would use it to finish the setup without any manual step; it already lays out the component exactly as foobar2000 does and only touches the profile while foobar2000 is closed.
