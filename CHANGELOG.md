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
- «More like this» radio from your own library: Deezer related artists (two steps), IDF-weighted genres as a fallback, every candidate track measured by sound (vibe.js) and kept close to the seed's feel; skips lower an artist; tops itself up.
- Radio, second pass: second-step related artists only when several related artists point to them; major/minor key from the chroma as a sound feature; the target stays at the seed's feel; «Not this — no more <artist>» in a radio's context menu.
- The theme's own drop-down lists: the native ones opened away from the control and were cut off.
- Fix: two different albums with the same title in one folder (e.g. «Eternity» by Anathema and by Kamelot) were merged into one.
- Menus open above dialogs.
- **Sound analysis (AI)**, optional: Discogs-EffNet and its mood heads run in a Web Worker (onnxruntime-web, WebAssembly, one thread) over two 8-second pieces of every track, decoded by foobar2000 at 16 kHz; the mel front end matches Essentia's to 4·10⁻⁶. A background indexer (playing track and radio candidates first; ≤ ¼ core while you work, ≤ ½ when away, paused on battery) keeps the results in IndexedDB. The models are built and checked against Essentia by the «ML assets» workflow and downloaded on request.
- Radio v3 (with the analysis): artists that sound like the seed join the candidates; of each artist the closest-sounding analysed track is played; at most 4 tracks per artist in any 25.
- «Similar tracks» (Now playing, track menu), mood and style playlists (Smart playlist → By sound), style and mood chips on Now playing.
- Colour wall, second version: twelve named colours with their names and counts on the ribbon; each pixel is named in OKLCH (borders where colour names change), vivid pixels and the centre weigh more, skin / cream / beige count as white; a strong second colour also lists the cover (after the main ones).
- Lighter on the computer: the background blobs are painted into a small canvas 12 times a second instead of four screen-sized layers composited 60 times a second; the spectrum is drawn at most 60 times a second on high-refresh screens; away from Now playing the progress bar wakes only when it moves a pixel; the sound analysis decodes the next track while the network works on the current one, paces itself by the work actually done (not by waiting for foobar2000) and reads two 8-second pieces instead of three 6-second ones; its results load in batches.
- Sound analysis, third pass: 44 s of each track (two 24-second pieces, non-overlapping patches) instead of 16 s; the styles shown are weighed with the album's average (Discogs labels releases) and against your library (a specific style beats «Heavy Metal»), a style named by your genre tag counts extra, and the chip's tooltip lists what the network hears; «Analysis speed»: Gentle / Normal / Fast / Maximum (up to three networks at once); decoding at the file's own rate with resampling in Gatefold when foobar2000's resampler is the slower path (measured once a week).
- «Animation smoothness»: as the monitor (default — spectrum, cover and background at 120/144/240 Hz) or economical (spectrum ≤ 60 fps, background 12 fps).
- Settings → foobar2000: output device and buffer, ReplayGain, DSP preset, playlist cursor behaviour, library folders and the whole Advanced tree with search — in the theme instead of the native Preferences dialog, which stays one click away.

The history before the public release (in Russian) is in [docs/HISTORY.ru.md](docs/HISTORY.ru.md).
