# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

**YouTube subtitles: a button to switch them.** YouTube turned captions on by itself for many videos (an owner's default, a language other than yours), and there was no way to hide them. Now the CC button in the player switches them on and off (or the C key), and the choice is kept for every following video — off by default.

- **The arrow next to it lists the video's tracks**, YouTube's generated ones marked as such, the current one ticked. The language you pick is remembered and chosen first on later videos; otherwise the interface language, then YouTube's own pick.
- **Auto-translate** into the interface language (YouTube's translation) when a video has no track in it, and **four subtitle sizes**.
- The button shows the language on a small tag, says when a video has no subtitles at all, and is part of the fullscreen controls. The player itself now speaks the interface language (track names, YouTube's own labels).

**Every tooltip in the interface language.** Since 1.1.0 the language file loads in the background, and the module that turns `title` into the theme's own tooltips could run first and keep the Russian text: the play button said «Воспроизведение / пауза (Пробел)» in an English interface, and so did many other buttons, in the main window and in the mini player. The tooltips now wait for the language, and the tests read every tooltip on every screen, with the language file arriving late on purpose.

**Your own columns.** Any tag or title formatting pattern becomes a column of the playlist view, of the album page, or both — like Default UI's custom columns: `%performer%`, `%genre%`, `$if2(%label%,%publisher%)`, your own fields. Settings → Playlists → Columns: fifteen ready-made ones (year, composer, rating as stars, plays, last played, date added, BPM, label…) or your own pattern, with a live preview on the playing track and a clear message when foobar2000 cannot read a pattern (the other columns keep working). Each column has its width and alignment (numbers go to the right by themselves). A right click on a list's header (or its ⋯ button) switches columns on and off for that list. Values come from foobar2000 a page at a time, so a huge playlist costs nothing until it is scrolled; in a narrow window the columns step aside.

**Playlists link to the music.** The artist and the album of every row are links, in every view, and so are the album headers. The song's title opens its album with the song marked (a double click still plays it).

**A much more accurate radio.** «Radio» on Now Playing could start from the wrong song: the button kept the track that was playing when the cover last changed, so within one album it was always the first song played. And the radio let the neural sound analysis bring in artists on its own — a K-pop or J-rock song mixed like a Finnish rock song came on — and filled 25 tracks at any cost. Now:

- **The radio is the track's**: it starts from the song playing when you press the button, is named after it («Radio: Still Standing — The Rasmus») and is steered by its sound.
- **Who comes on is decided by people first:** Deezer's related artists (and the ones several of them agree on), **ListenBrainz** (artists listened to in the same sessions), and **your own playlists** — each can only add, and sources that agree count more. Then by the content: **MusicBrainz genres** of every artist (rare shared genres weigh most), the sound as a **percentile of your library**, and the **Discogs styles** the network hears, compared as distributions. An artist only the sound points to must match on everything, and never against the genre.
- **What is played of an artist:** the song closest in sound to the seed, weighed with how well known it is (the artist's top tracks on Deezer) and how often you play it. A track is only chosen once it has been listened to. **Remixes, live versions, demos, karaoke, intros and interludes stay out** (unless the seed is one), and the same song on another album does not come twice.
- **Order:** the first tracks come from the closest artists, then the circle widens; the seed's artist returns about every sixth track; at most three tracks of an artist in 25; artists whose songs keep sounding off, or that you skip, fade out — and so does music that sounds like what you skipped. When nothing fitting is left, the radio says so and stops instead of playing anything.
- **«Why is this track on the radio?»** in a radio track's menu names the reasons.
- Answers from the services are kept for two weeks, so a radio of the same artist starts at once.

**Escape closes an open menu in the YouTube view** instead of also leaving the view.

## [1.2.0] — volume levelling, album details

**Volume levelling** — Settings → Volume levelling: one switch, and every album plays as loud as the next while keeping its own quiet and loud moments. A quiet interlude stays quiet: by default the gain is the album's, measured over the whole album at once, never the track's own.

- **How it levels:** by album (default), «smart» (by album when an album plays in order, by track in shuffle) or each track.
- **Target loudness:** −18 LUFS (ReplayGain 2.0 standard), −16 (like Apple Music), −14 (like Spotify and YouTube) or −23 (like radio and TV). Above −18 the preamp adds gain, and clipping prevention keeps very dynamic albums below the target rather than distorting them.
- **The levelling is foobar2000's own ReplayGain:** sample-exact, gapless, with clipping prevention by the stored peaks. Gatefold sets it up, and puts foobar2000's previous ReplayGain settings back when levelling is turned off.
- **Tracks without ReplayGain values are measured in the background**, the way the ReplayGain 2.0 scanner measures them: EBU R128 / ITU-R BS.1770-4 loudness with both gates, true peak by 4× oversampling, mono as dual mono, LFE left out. It runs in a worker, gives way to what you are doing and pauses on battery. The standard REPLAYGAIN_* tags are written and read back to check them; the audio is never touched.
- **Albums are found the careful way:** album tag + album folder (CD1 / Disc 2 sub-folders belong to one album), one title by two album artists in one folder stays two albums, and a compilation stays one.
- **An album missing an album gain on any of its tracks is measured again as a whole.** Otherwise foobar2000 would fall back to that track's own gain, and the interlude would jump up.
- **The album you are listening to comes first:** its playing track is measured before anything else and its tags are written at once, so the following tracks play levelled; when playback moves to another album that is still waiting, that album jumps to the front of the queue. Nothing is written in the last seconds before a track change.
- **Opus files** get R128_TRACK_GAIN / R128_ALBUM_GAIN (their own standard, RFC 7845) next to the REPLAYGAIN_* fields. The status line counts only the albums that still lack values and names any format whose files do not keep them.
- **Fast:** several tracks are measured side by side in workers while foobar2000's decoder is kept busy without a break (about as fast as foobar2000 can decode). Only while you are using the computer does it slow down to one track at a time.

**Album details, on request.** An album page stays as it was until you ask for more: the «Details» button, a click on the track count, or the I key (remembered). Then:

- **A card** fills the empty right side of the header with what the album actually has: format (FLAC 24/96), bitrate, size, loudness (LUFS, from ReplayGain), dynamic range (foo_dr_meter), plays and the last one, date added (foo_playcount), release date, label and catalogue number, genres, discs, and the folder (a click opens it).
- **The track list gains columns:** format, bitrate, loudness, DR and plays — only the ones this album has values for, and without the artist column when every track is by the album artist.
- **It fits any window:** the card narrows to two columns, then becomes one line under a smaller cover, so the track list always keeps its room.

**VU meters read what you hear.** The live stream comes before ReplayGain, so the meters now apply the gain foobar2000 applies to the playing track (the same rules: source, preamp, clipping prevention). A new default for 0 VU, «Auto», measures the level of the album that is playing from the very signal the meter shows (a gated running mean: quick to follow a louder stretch, slow to follow a quieter one), so the needle swings around −6 VU and reaches the red only on the loudest moments — on a loud modern master and a quiet old record alike, with or without tags. Hover the meter to see what 0 VU stands for right now. The fixed −18 / −14 / −10 dBFS references are still there.

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
