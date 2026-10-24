<p align="center"><img src="installer/assets/gatefold.svg" width="96" alt="Gatefold logo"></p>

<h1 align="center">Gatefold</h1>

<p align="center"><b>foobar2000, reimagined.</b><br>
A modern interface built around your album art that takes its colours from whatever is playing,<br>with foobar2000's sound and speed underneath.</p>

<p align="center">
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/DEVIROYrus/gatefold-foobar2000?style=flat-square&label=release&color=ff4f9a" alt="Latest release"></a>
  <a href="../../releases"><img src="https://img.shields.io/github/downloads/DEVIROYrus/gatefold-foobar2000/total?style=flat-square&color=7c5cff" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-2fb4c8?style=flat-square" alt="Windows 10 and 11">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/DEVIROYrus/gatefold-foobar2000?style=flat-square&color=555" alt="MIT license"></a>
</p>

<p align="center">
  <a href="../../releases/latest"><img src="https://img.shields.io/badge/%E2%AC%87%20Download%20for%20Windows-Gatefold%20Setup-ff4f9a?style=for-the-badge" alt="Download Gatefold for Windows" height="36"></a>
</p>

<p align="center"><sub>Free · one installer · English, Русский, Deutsch, Español, 中文 · <a href="README.ru.md">Читать по-русски</a></sub></p>

![Gatefold in motion](docs/screenshots/demo.webp)

## Why Gatefold

- 🎨 **Every screen wears your music.** Covers fill the window and the whole interface takes its colours from the album that's playing.
- 🎧 **Nothing lost from foobar2000.** Gapless, every format, ReplayGain, DSP, WASAPI and all your components work exactly as before.
- 🧠 **It knows how your songs sound.** Optional on-device analysis makes radio, mood playlists and «Similar tracks» from your own files. Nothing is uploaded.
- ⚡ **Ready in a minute.** One installer sets up foobar2000, the component and the theme, and updates come in one click.

## A look inside

| | |
|:---:|:---:|
| ![Now playing](docs/screenshots/now-en.webp) | ![Albums](docs/screenshots/library-en.webp) |
| **Now playing** with synced lyrics and up next | **Albums** as a wall of covers |
| ![Tracks](docs/screenshots/tracks-en.webp) | ![Folders](docs/screenshots/folders-en.webp) |
| **Tracks**: every song in one list | **Folders**: your library as it lies on disk |
| ![Playlists by sound](docs/screenshots/sound-smart-en.webp) | ![Playlist](docs/screenshots/playlist-en.webp) |
| **Playlists by how the music sounds** | **Playlists** you can really edit |

## Install

1. **Download** `Gatefold-Setup.exe` from the [latest release](../../releases/latest).
2. **Run it.** It brings foobar2000 (if you don't have it), the [foo_ui_webview2](https://github.com/NereaFantasia/foo_ui_webview2) component and the WebView2 Runtime.
3. **Done.** foobar2000 opens straight in Gatefold. Your old setup is backed up, and you can switch back in Preferences → Display.

New versions show an **Update available** button in the sidebar: one click, checked against `SHA256SUMS.txt`, and you can roll back.

## Features

- **Now playing:** a large cover, format badges (codec, bit depth, DR, ReplayGain), synced lyrics from your files or LRCLIB, and up next.
- **Library:** albums, all tracks, or your folders. Editions of one album stay separate, «A; B» shows an album under each artist, and the library can be sorted by cover colour.
- **Smart playlists without a query language:** recently added, forgotten favourites, a decade, hi-res, or a mood. These are real foobar2000 autoplaylists.
- **Covers that look after themselves:** missing ones are found, low-resolution ones are replaced, and a cover you choose is never touched.
- **Volume levelling:** albums play equally loud while keeping their own dynamics, using EBU R128 and standard ReplayGain tags.
- **Canvas:** full-screen Now playing, also on a second monitor. There's also a mini player, taskbar controls, a tray icon, Liked songs and YouTube.

<details>
<summary><b>Requirements</b></summary>

| | |
|---|---|
| Windows | 10 or 11, 64-bit |
| foobar2000 | 2.x, 64-bit (the installer brings it) |
| [foo_ui_webview2](https://github.com/NereaFantasia/foo_ui_webview2) | 2.0 or later (the installer brings it) |
| Optional | `foo_playcount` (play statistics), `foo_dr_meter` (DR badge) |

</details>

<details>
<summary><b>Manual installation</b></summary>

1. Install **foo_ui_webview2**: open the `.fb2k-component` file, confirm, restart foobar2000.
2. **Preferences → Display → WebView2 UI → Manage… → Create…**, name it `gatefold`, press **Open…**.
3. Copy the **contents** of `gatefold-theme-x.y.z.zip` there, so that `index.html` sits directly inside.
4. **Preferences → Display:** choose **Webview2 UI**, template `gatefold`, **Apply**.

</details>

<details>
<summary><b>Privacy</b>: no telemetry, no account</summary>

Every network request belongs to a feature you can see and switch off, and all of them go through foobar2000.

| Feature | Goes to | When |
|---|---|---|
| Cover art | iTunes, Deezer, MusicBrainz / Cover Art Archive | Albums without art (can be turned off) |
| Artist photos | Deezer, MusicBrainz / Wikidata | The Artists screen (can be turned off) |
| «More like this» radio | Deezer, MusicBrainz, ListenBrainz | Only when you start a radio |
| Lyrics | LRCLIB | Tracks without lyrics in tags or files |
| YouTube | youtube-nocookie.com; Google API with your own key | Only on the YouTube screen |
| Updates | api.github.com, github.com | Every 12 hours (can be turned off) |
| Sound analysis | this repository's `ml-assets` branch | Once, when you turn it on. The analysis never leaves your PC |
| Genres (with sound analysis) | musicbrainz.org | Once per artist (can be turned off) |

**Optional unofficial sources, off by default:** lyrics from Musixmatch, NetEase, QQ Music and Kugou, and a keyless YouTube search. They use private interfaces, may break at any time and may go against those services' terms. Lyrics and covers are for personal use only.

</details>

<details>
<summary><b>Keyboard shortcuts</b></summary>

| Keys | Action |
|---|---|
| Space | Play / pause |
| ← / → | Seek ±5 s (Ctrl: ±30 s) |
| Shift + ← / → | Previous / next track |
| ↑ / ↓ · M | Volume ±5 · mute |
| L | Like |
| Ctrl+F | Search |
| Alt+1…8 | Switch screens |
| F11 · F | Full screen · Canvas |
| Ctrl+R · Ctrl+P | Reload the interface · foobar2000 Preferences |

In lists: Shift/Ctrl+click, Ctrl+A, Delete, Ctrl+Z / Ctrl+Y, Alt+↑/↓, Enter, Esc.

</details>

<details>
<summary><b>Troubleshooting</b></summary>

- **foobar2000 opens in its old interface:** choose **Webview2 UI** in Preferences → Display.
- **A white page:** the `gatefold` template isn't selected, or `index.html` isn't directly inside its folder.
- **Covers aren't downloaded:** the Covers screen shows the last error, and View → Console shows `[Gatefold]` lines.
- **Odd window behaviour:** Settings → Window and startup → turn off *Custom window frame*, then press Ctrl+R.

When reporting a problem, please include your foobar2000 and foo_ui_webview2 versions and the `[Gatefold]` lines from the console.

</details>

<details>
<summary><b>Building, translating, contributing</b></summary>

- **Building:** the theme needs no build step. The installer is built by GitHub Actions from `installer/gatefold.iss`, and every bundled file is downloaded from its official source and checksummed ([docs/RELEASING.md](docs/RELEASING.md)).
- **Translating:** copy `theme/js/locales/en.js`, translate the values and register the language in `theme/js/i18n.js`.
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md). Issues and ideas are welcome.

</details>

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). *Status: applied for. Until then installers are unsigned, so Windows SmartScreen may warn on first run (More info → Run anyway). Every release lists SHA-256 checksums in `SHA256SUMS.txt`.*

Committers and reviewers: the members of this repository. Approvers: the repository owner. Every release is built by GitHub Actions from this repository and approved by hand. This program sends no information anywhere unless a feature you use needs it (see Privacy above).

## License

[MIT](LICENSE) © Gatefold contributors. Third-party components keep their own licenses ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). foobar2000 is freeware by Peter Pawłowski; Gatefold is an independent project, not affiliated with foobar2000 or foo_ui_webview2.

<details>
<summary><sub>The screenshots show real albums released under Creative Commons licences.</sub></summary>

Nine Inch Nails: *The Slip*, *Ghosts I–IV* · Kai Engel: *Calls and Echoes* · Broke For Free: *Slam Funk* · Derek Clegg: *Across Town* · Tigerberry: *Cold Wave* · rolemusic: *The Black Dot* · Edith Frost: *Demos* · Giraffe: *Giraffe LP* · Sergi Boal: *Nylon & Turtle* · Bottlesmoker: *Let's Die Together in 2012* · Jahzzar: *Dune* · The Sleeping Tree: *Leaves and Roots*. All from the [Internet Archive](https://archive.org) under their CC licences (BY, BY-SA, BY-NC, BY-NC-SA). Covers and titles belong to their authors. Genres, moods and playlists in the pictures are what Gatefold's own analysis made of these recordings.

</details>
