<p align="center"><img src="installer/assets/gatefold.svg" width="88" alt=""></p>
<h1 align="center">Gatefold</h1>
<p align="center"><b>A modern interface for foobar2000 that takes its colours from your music.</b><br>
<a href="../../releases/latest"><b>Download the installer</b></a> · <a href="README.ru.md">Русская версия</a></p>

Gatefold is a theme for the [foo_ui_webview2](https://github.com/NereaFantasia/foo_ui_webview2) component. It turns foobar2000 into a full-window player whose palette is built live from the cover of the playing album — with your library, artists, playlists, synced lyrics, a full-screen Canvas, YouTube and an optional on-device sound analysis. The installer sets everything up: run it, and foobar2000 opens in Gatefold.

![Gatefold in motion](docs/screenshots/demo.webp)

![Now playing](docs/screenshots/now-en.webp)

| Playlist with covers | Library by cover colour |
|---|---|
| ![Playlist](docs/screenshots/playlist-en.webp) | ![Colour wall](docs/screenshots/colors-en.webp) |
| **Smart playlists** | **Fixed light theme** |
| ![Smart playlists](docs/screenshots/smart-en.webp) | ![Light theme](docs/screenshots/now-light-en.webp) |

<sub>Screenshots use placeholder artwork from the test fixtures, not real album covers.</sub>

## Features

**Looks and listening**
- **Album-driven colour** — the colour roles are picked from each cover (k-means in OKLab, WCAG contrast). Or a fixed **Dark**, **Light** or **Grey** theme; text size 13–20 px; animations at your monitor's refresh rate.
- **Now playing** — a large cover that breathes with the bass, a spectrum in the album's colours, format badges (codec, bit depth / sample rate, bitrate, DR, ReplayGain, play count), synced lyrics and up next.
- **Canvas** — full-screen Now playing with slow motion, lyrics and a clock; it can open on a second monitor.
- **Synced lyrics** from tags, an `.lrc` next to the track or LRCLIB; click a line to seek, `[` `]` to adjust the timing.

**Your music**
- **Playlists in four views** (by album, with covers, tiles, compact) with real editing: Shift/Ctrl selection, drag to reorder or onto a sidebar playlist, Delete, Ctrl+Z, Alt+↑/↓.
- **Library and Artists** — cover grids, album pages, artist photos; albums split by guest artists are merged back. **The colour wall** sorts the library by cover colour and filters by one of twelve named colours.
- **Smart playlists without the query language** — recently added, most played, forgotten favourites, never played, a genre, a decade, lossless, hi-res, long tracks or your own query; a live count and a few example tracks before you create it. They stay up to date by themselves.
- **«More like this» radio** — similar artists you actually have, every candidate track measured by its sound so the mood holds; skipped artists come up less.
- **Liked** — a heart in the player and on every row, kept in an ordinary foobar2000 playlist.
- **Cover art** — finds missing covers (iTunes · Deezer · MusicBrainz/CAA), checks the quality of the ones you have and replaces weak ones (with backups).

**Sound analysis (AI), optional**
- A neural network (Discogs-EffNet) listens to each track of your library once — on your computer, in the background, at the speed you choose (from Gentle to Maximum). The analysis never leaves your computer.
- With it the radio and **Similar tracks** pick songs by how they *sound*; smart playlists gain moods — calm, energetic, sad, happy, party, instrumental (no voice at all), acoustic — and genres by sound; Now playing shows the track's genres (MusicBrainz votes, ordered by how the track sounds) and its mood.
- The models (~30 MB, CC BY-NC-SA 4.0, non-commercial) are downloaded only when you turn it on in Settings → Sound analysis (AI).

**Around the window**
- ⏮ ⏯ ⏭ ♡ on the taskbar thumbnail, progress on the taskbar button, an optional tray icon with a player menu, and a **mini player** that stays above other windows.
- **YouTube** — paste a link, or search with your own YouTube Data API key; its own controls, quality, queue, history and mini player. Music pauses while a video plays.
- **Your foobar2000 stays yours** — right-click opens the native context menu, ☰ the full main menu, and all your components still work. Settings → foobar2000 covers output, ReplayGain, DSP and the whole Advanced tree.
- **English and Russian**, picked from Windows or set in Settings.
- **One-click updates** from this repository's releases, checksum-verified, with «Restore previous version».
- **Fun mode** (hidden — click the “Gatefold” title ten times): three interface styles and 45 achievements.

## Requirements

| | |
|---|---|
| Windows | 10 or 11, 64-bit |
| foobar2000 | 2.x, 64-bit |
| [foo_ui_webview2](https://github.com/NereaFantasia/foo_ui_webview2) | 2.0 or later |
| WebView2 Runtime | Preinstalled on Windows 11 and on most Windows 10 machines |
| Optional | `foo_playcount` (play statistics, “recently played” sorting), `foo_dr_meter` (DR badge) |

## Installation

### With the installer (recommended)
Download `Gatefold-Setup.exe` from [Releases](../../releases) and run it. It installs or updates foobar2000, foo_ui_webview2 and the WebView2 Runtime when needed, puts the theme in place, adds Gatefold shortcuts and makes Webview2 UI foobar2000's interface — foobar2000 opens straight in Gatefold (its configuration is backed up as `config.sqlite.before-gatefold`; to go back, choose *Default User Interface* in Preferences → Display).

### Manually
1. Install **foo_ui_webview2**. Open the `.fb2k-component` file, confirm in foobar2000, then restart foobar2000.
2. Go to **File → Preferences → Display → WebView2 UI** → **Manage… → Create…** and name the template `gatefold`. Press **Open…**.
3. Copy the **contents** of the release archive into that folder, so that `index.html` sits directly inside it.
4. Under **Preferences → Display**, choose **Webview2 UI** as the user interface, pick `gatefold` as the **Template**, then press **Apply**.

To go back, choose *Default User Interface* again. Your old layout is kept.

### Updating
When a new release is out, an **Update available** button appears at the bottom of the sidebar (and in **Settings → Updates**). One click shows what changed and installs it: the theme archive is downloaded from this repository's Releases, checked against `SHA256SUMS.txt`, the current version is backed up to `%profile%\gatefold\backup\<version>`, and the interface reloads. **Restore previous version** in Settings puts the backup back. If a release needs a newer foo_ui_webview2, the button offers the installer instead, which updates everything. Checking can be turned off; nothing is installed without your click.

## Privacy

Gatefold has **no telemetry** and no accounts. The only network requests it makes are the ones its features need, and every one goes through foobar2000:

| Feature | Goes to | When |
|---|---|---|
| Cover art | iTunes Search API, Deezer API, MusicBrainz / Cover Art Archive | Albums without art (automatic search can be turned off) |
| Artist photos | Deezer, MusicBrainz / Wikidata | The Artists screen (can be turned off) |
| «More like this» radio | Deezer (related artists, by name) | Only when you start a radio |
| Lyrics | LRCLIB | Tracks without lyrics in tags or files |
| YouTube | youtube-nocookie.com player; Google API when you use your own key | Only on the YouTube screen |
| Update check | api.github.com, github.com (release downloads) | Every 12 hours and when you press *Check now* (can be turned off) |
| Sound analysis (AI) | raw.githubusercontent.com (this repository's `ml-assets` branch) | Once, when you turn the feature on; then a manifest check at most weekly. The analysis itself never leaves your computer |
| Genres (with sound analysis on) | musicbrainz.org (artist name; then that artist's albums) | Once per artist, about one request a second in the background (can be turned off) |

Everything downloaded is kept on your computer: in the theme's cache, or next to your music if you choose to save covers or lyrics there.

### Optional unofficial sources — off by default
Settings can turn on lyrics from **Musixmatch, NetEase, QQ Music and Kugou**, and a **YouTube search that reads the results page** without a key. These use the services' private interfaces without their approval. They may break at any time, and using them may go against those services' terms. They are disabled until you turn them on yourself. Lyrics and cover art are copyrighted and are for personal use only.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

*Status: applied for. Until the application is approved, release installers are unsigned, and Windows SmartScreen may warn on first run (More info → Run anyway). Every release lists the SHA-256 of its files in `SHA256SUMS.txt`.*

- Committers and reviewers: the members of this repository. Approvers: the repository owner.
- Every signed release is built by GitHub Actions from this repository (`.github/workflows/release.yml`) and approved by hand before signing.
- Privacy: this program does not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it — see [Privacy](#privacy) for every request a feature makes.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Space | Play / pause |
| ← / → | Seek ±5 s (Ctrl: ±30 s) |
| Shift + ← / → | Previous / next track |
| ↑ / ↓ | Volume ±5 |
| M | Mute |
| L | Like / unlike |
| Ctrl+F | Search |
| Alt+1…8 | Now playing / Playlist / Artists / Library / Queue / Covers / Settings / YouTube |
| Alt+← / Alt+→, mouse buttons 4/5 | Back / forward |
| F11 | Full screen |
| F (on Now playing) | Canvas |
| Ctrl+R | Reload the interface |
| Ctrl+P | foobar2000 Preferences |

In a playlist: Shift/Ctrl+click select · Ctrl+A all · Delete remove · Ctrl+Z / Ctrl+Y undo / redo · Alt+↑/↓ move · Enter play · Esc clear the selection.

On the YouTube screen: Space/K play/pause · J/L ±10 s · F full screen · T theatre mode · Q quality · N/P next/previous · `/` search.

## Troubleshooting

- **foobar2000 opens in its old interface** — choose **Webview2 UI** in Preferences → Display (the installer does this itself; this is for manual installs, or when its backup step could not run).
- **A white or test page** — the template isn't selected, or `index.html` isn't directly inside the template folder.
- **Covers aren't downloaded** — open the Covers screen and check *Last error*. View → Console shows `[Gatefold]` lines. A read-only music folder has nowhere to save covers.
- **Odd window behaviour** — Settings → Window and startup → turn off *Custom window frame*, then press Ctrl+R.
- **Debugging** — Preferences → WebView2 UI → enable DevTools, then press F12.

When you report a problem, please include your foobar2000 and foo_ui_webview2 versions and the `[Gatefold]` lines from the console.

## Building from source

See [docs/RELEASING.md](docs/RELEASING.md) — the theme needs no build step; the installer is built by GitHub Actions (Inno Setup 6.6) from `installer/gatefold.iss`, with every bundled file downloaded from its official source and checksummed.

## Translating

Strings are written in Russian in the source and wrapped in `$t('…')`. Each language is a file in `js/locales/` that maps those Russian strings to translations, gettext-style. Plurals are `'one|other'` entries (CLDR rules via `Intl.PluralRules`). Static markup in `index.html` is translated at start-up. To add a language, copy `js/locales/en.js`, translate the values, and register the language in `js/i18n.js`.

## License

[MIT](LICENSE) © Gatefold contributors. Third-party fonts and components keep their own licenses — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
foobar2000 is freeware by Peter Pawłowski. Gatefold is an independent project, not affiliated with or endorsed by foobar2000 or by the author of foo_ui_webview2.
