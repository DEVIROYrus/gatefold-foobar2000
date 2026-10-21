Two add-ons for **Default UI** and **Columns UI** layouts. You don't need the Gatefold interface for them, only the foo_ui_webview2 component.

- **Gatefold Seekbar** (`gatefold-seekbar-*.zip`): a waveform seekbar in the colours of the playing album. Bars, solid or line style. Album, dark, light or grey colours, on a coloured or transparent background. Click or drag to seek; the wheel steps 5 s.
- **Gatefold Covers** (`gatefold-covers-*.zip`): Gatefold's cover finder on its own. It finds missing covers, replaces low-resolution ones with a backup, and asks when unsure.

**Install:**
1. Unzip into `<profile>\webview-ui\` (usually `%APPDATA%\foobar2000-v2\webview-ui\`).
2. Add a **WebView2 Panel** to your layout.
3. Right-click the panel → *Configure* → *Template*: `gatefold-seekbar` or `gatefold-covers`.

Details: [panels/README.md](https://github.com/DEVIROYrus/gatefold-foobar2000/blob/main/panels/README.md)
