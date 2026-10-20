# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] — first public release

- **Gatefold** (formerly a private theme called “Aurora”): a full-window foobar2000 interface on foo_ui_webview2.
- Album-driven colour, or fixed Dark / Light / Grey themes; text size 13–20 px.
- Now playing, playlists in four views, Liked, library, artists, queue, search, synced lyrics, Canvas, YouTube, cover art tools.
- English and Russian interface.
- Unofficial lyrics sources and the unofficial YouTube search are off by default; YouTube search with your own Data API key.
- Installer: installs or updates foobar2000 x64, foo_ui_webview2 and the WebView2 Runtime; updates an existing template in place.
- One-click updates from GitHub Releases inside the interface: checksum-verified, with a backup and «Restore previous version»; falls back to the installer when a newer foo_ui_webview2 is required.
- The theme's own tooltips replace the native ones, which foobar2000's window drew away from the cursor and cut off.
- Volume control in Canvas (slider, mouse wheel, ↑/↓, M).
- First run: while foobar2000 has no music, «Now playing» shows a welcome — connect a music folder to the library (opens the right foobar2000 page, waits, then opens Library) or open a folder / files to play right away. Empty Library, Artists and playlist screens offer the same buttons.
- Playlist editing: multi-select, Delete, drag to reorder or onto a sidebar playlist, undo/redo, Alt+↑/↓, a selection bar and a context menu of our own; playlists reorder by dragging.
- Taskbar thumbnail buttons (translated, with ♡), taskbar progress, optional tray icon with a player menu, minimize/close to tray; a mini player window.
- Smart playlists from recipes, with a live match count.
- Library → «By cover colour» with a colour ribbon filter.
- «More like this» radio from your own library, topping itself up.
- Settings → foobar2000: output device and buffer, ReplayGain, DSP preset, playlist cursor behaviour, library folders and the whole Advanced tree with search — in the theme instead of the native Preferences dialog, which stays one click away.

The history before the public release (in Russian) is in [docs/HISTORY.ru.md](docs/HISTORY.ru.md).
