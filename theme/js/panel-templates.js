/*
 * Gatefold · panel-templates.js — the panel templates made from this theme, for Default UI and
 * Columns UI layouts («WebView2 Panel» → Template). Each is a copy of the theme with its own
 * index.html; tools/make_panels.py builds them for the installer and the release, and the in-app
 * updater refreshes the ones it finds next to the template it updates.
 */
export const PANELS = {
  'gatefold-seekbar': { page: (read) => read('seekbar.html') },
  'gatefold-covers': { page: (read) => read('index.html').replace('<script src="js/panel-boot.js"></script>', '<script src="js/panel-boot.js" data-panel="covers"></script>') },
};
