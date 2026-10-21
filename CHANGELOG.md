# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [1.1.0] — VU meters, similar albums, three more languages

**VU meters** — two needle meters (left and right channel) instead of the spectrum on Now playing, and in the Canvas. Off by default: Settings → Appearance → VU meters. They measure the RMS of each channel of what foobar2000 plays and move like real VU meters (IEC 60268-17: 300 ms, a little overshoot); classic ivory dials or the album's colours; 0 VU at −18, −14 or −10 dBFS. Two meters side by side, or one dial with both needles.

**Similar albums** — with sound analysis on, an album page ends with albums by other artists in your library that sound alike.

**Sound analysis offer** — once the library has ten albums or more, Gatefold offers once, quietly, to turn sound analysis on; «Not now» means it doesn't ask again.

**German, Spanish and Chinese (Simplified)** — the interface (picked from Windows or in Settings) and, for German and Spanish, the installer.

## [1.0.0] — first public release

Gatefold turns foobar2000 (2.x, 64-bit) into a full-window player on foo_ui_webview2 whose colours come from the cover of the playing album.

**Install** — one installer sets up foobar2000, foo_ui_webview2, the WebView2 Runtime and the theme, adds Gatefold shortcuts and makes Webview2 UI foobar2000's interface: foobar2000 opens straight in Gatefold (the previous configuration is backed up). Updates come later in one click, checksum-verified, with «Restore previous version».

**Looks** — album-driven colour (or fixed Dark / Light / Grey), text size 13–20 px, animations at the monitor's refresh rate; Now playing with a breathing cover, spectrum, format badges and synced lyrics; full-screen Canvas, also on a second monitor; a mini player; taskbar buttons, progress and an optional tray icon.

**Music** — playlists in four views with real editing (multi-select, drag, Delete, undo); Liked; library, artists and album pages; the colour wall (the library by cover colour, twelve named colours); smart playlists without the query language, with a live count and example tracks; «More like this» radio from your own library; cover art search and quality checks.

**Sound analysis (optional, on your computer)** — a neural network listens to each track once; then radio and «Similar tracks» go by sound, smart playlists gain moods (calm, energetic, sad, happy, party, instrumental, acoustic) and genres by sound, and Now playing shows the track's genres (MusicBrainz, ordered by sound) and mood.

**Also** — YouTube (links, or search with your own API key), foobar2000's own menus and settings inside the theme, English and Russian. No telemetry; every network request belongs to a feature (see Privacy in the README). Unofficial lyrics sources and the key-less YouTube search are off by default.
