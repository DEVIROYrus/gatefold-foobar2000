# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

**Volume levelling** — Settings → Volume levelling: one switch, and every album plays as loud as the next while keeping its own quiet and loud moments. A quiet interlude stays quiet: by default the gain is the album's, measured over the whole album at once, never the track's own.

- **How it levels:** by album (default), «smart» (by album when an album plays in order, by track in shuffle) or each track.
- **Target loudness:** −18 LUFS (ReplayGain 2.0 standard), −16 (like Apple Music), −14 (like Spotify and YouTube) or −23 (like radio and TV). Above −18 the preamp adds gain, and clipping prevention keeps very dynamic albums below the target rather than distorting them.
- **The levelling is foobar2000's own ReplayGain:** sample-exact, gapless, with clipping prevention by the stored peaks. Gatefold sets it up, and puts foobar2000's previous ReplayGain settings back when levelling is turned off.
- **Tracks without ReplayGain values are measured in the background**, the way the ReplayGain 2.0 scanner measures them: EBU R128 / ITU-R BS.1770-4 loudness with both gates, true peak by 4× oversampling, mono as dual mono, LFE left out. It runs in a worker, gives way to what you are doing and pauses on battery. The standard REPLAYGAIN_* tags are written and read back to check them; the audio is never touched.
- **Albums are found the careful way:** album tag + album folder (CD1 / Disc 2 sub-folders belong to one album), one title by two album artists in one folder stays two albums, and a compilation stays one.
- **An album missing an album gain on any of its tracks is measured again as a whole.** Otherwise foobar2000 would fall back to that track's own gain, and the interlude would jump up.
- **The album that is playing gets its values only when playback leaves it**, and nothing is written in the last seconds before a track change, so loudness never shifts mid-listen.
- **Fast:** several tracks are measured side by side in workers while foobar2000's decoder is kept busy without a break (about as fast as foobar2000 can decode). Only while you are using the computer does it slow down to one track at a time.

**Album details, on request.** An album page stays as it was until you ask for more: the «Details» button, a click on the track count, or the I key (remembered). Then:

- **A card** fills the empty right side of the header with what the album actually has: format (FLAC 24/96), bitrate, size, loudness (LUFS, from ReplayGain), dynamic range (foo_dr_meter), plays and the last one, date added (foo_playcount), release date, label and catalogue number, genres, discs, and the folder (a click opens it).
- **The track list gains columns:** format, bitrate, loudness, DR and plays — only the ones this album has values for, and without the artist column when every track is by the album artist.
- **It fits any window:** the card narrows to two columns, then becomes one line under a smaller cover, so the track list always keeps its room.

**VU meters read what you hear.** The live stream comes before ReplayGain, so the meters now apply the gain foobar2000 applies to the playing track (the same rules: source, preamp, clipping prevention). A new default for 0 VU, «Auto», takes the reference from the loudness of the album that is playing: the needle swings around −4 VU and reaches the red only on the loudest moments, on a loud modern master and a quiet old record alike. The fixed −18 / −14 / −10 dBFS references are still there.

## [1.1.1] — hotfix

**Synced lyrics no longer run ahead of the song.** The position came from foo_ui_webview2's once-a-second time event, which is meant for a clock display: whole seconds, no timestamp, and it can run ahead of what you hear. Lyrics, the seek bar, the Canvas, the mini player and the seekbar panel now follow the ~10 Hz latency-compensated position (`playback:timeHighRes`, with its timestamp), ignore the stale sample that can follow a seek, and catch up at once when the window is shown again.

**Genre names keep their abbreviations** — AOR, EDM, IDM, R&B, UK Garage, NWOBHM instead of «Aor», «Edm», «R&b».

**YouTube search in Chinese** asks for results in Simplified Chinese (the API wants `zh-Hans`).

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
