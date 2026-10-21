# Gatefold panels for Default UI and Columns UI

Two separate add-ons for people who like their foobar2000 layout as it is. Each is a panel for **Default UI** or **Columns UI**: you don't need the Gatefold interface for them, only the [foo_ui_webview2](https://github.com/NereaFantasia/foo_ui_webview2) component. Take one or both.

| | |
| --- | --- |
| **[Gatefold Seekbar](seekbar/README.md)** | A waveform seekbar in the colours of the album that is playing. |
| **[Gatefold Covers](covers/README.md)** | Automatic cover art: finds missing covers, upgrades weak ones, asks when unsure. |

Each page has its own download and install steps.

## For developers

The panels contain a few of Gatefold's own modules, unchanged (the bridge to foobar2000, the cover finder, the colour maths, the playback position). They are built from these folders by `panels/build.py` and tested by `panels/test.py`; `panels/VERSION` is the version of both. MIT, like Gatefold.
