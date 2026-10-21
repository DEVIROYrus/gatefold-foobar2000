# Gatefold Covers

Automatic cover art for your foobar2000 library: finds missing covers, upgrades weak ones, asks when unsure. It is a panel for **Default UI** and **Columns UI**: you don't need the Gatefold interface, only the [foo_ui_webview2](https://github.com/NereaFantasia/foo_ui_webview2) component.

**[Download gatefold-covers-1.0.1.zip](https://github.com/DEVIROYrus/gatefold-foobar2000/releases/download/panels-v1.0.1/gatefold-covers-1.0.1.zip)** · [release page](https://github.com/DEVIROYrus/gatefold-foobar2000/releases/tag/panels-v1.0.1)

![Gatefold Covers](../screenshots/covers.webp)

- **Finds missing covers** for the whole library and for the album that starts playing. Sources: iTunes, Deezer, MusicBrainz / Cover Art Archive.
- **Upgrades weak covers.** It finds covers that are too small, heavily compressed or not square, and replaces them with a bigger version of the same picture. The old file is backed up, and any replacement can be undone.
- **Saves as foobar2000 expects:** `cover.jpg` next to the tracks. In folders shared by several albums it embeds the cover into that album's tracks instead.
- **Asks when unsure:** matches it isn't sure about wait for your click.

## Install

1. You need foobar2000 2.x (64-bit) and **foo_ui_webview2** 2.0 or later ([its releases](https://github.com/NereaFantasia/foo_ui_webview2/releases)).
2. Unzip `gatefold-covers-<version>.zip` into `<profile>\webview-ui\`. The profile is usually `%APPDATA%\foobar2000-v2`, or the `profile` folder of a portable install. You should end up with `webview-ui\gatefold-covers\index.html`.
3. Add a panel:
   - **Columns UI:** *File → Preferences → Display → Columns UI → Layout*, insert **WebView2 Panel** (a tab of its own works well).
   - **Default UI:** *View → Layout → Enable layout editing mode*, right-click where it should go, then *Add New UI Element* → **WebView2 Panel**.
4. Right-click the panel → *Configure* → **Template**: `gatefold-covers`.

To update, unzip the new version over the old one.

**Privacy:** the panel contacts iTunes, Deezer and MusicBrainz / Cover Art Archive to find covers. Each source can be switched off in the panel. There is no telemetry.

MIT, like [Gatefold](../../README.md). The other panel: [Gatefold Seekbar](../seekbar/README.md).
