# Contributing

Thanks for helping! A few notes keep things smooth.

## Layout

| Path | What |
|---|---|
| `theme/` | The theme itself — plain HTML/CSS/ES modules, no build step. `index.html` is the entry point. |
| `theme/js/locales/` | Translations (see below). |
| `installer/` | Inno Setup script, artwork and the script that fetches bundled software. |
| `tests/` | End-to-end tests against a mock of the foo_ui_webview2 bridge. |
| `tools/` | Static checks, artwork generator. |

## Working on the theme

1. Copy (or symlink) `theme/` into `<foobar2000 profile>\webview-ui\gatefold-dev\` and select that template in *Preferences → Display → WebView2 UI*.
2. Ctrl+R reloads the interface; enable DevTools in the component's preferences for F12.
3. Without foobar2000: serve the repository root (`python -m http.server`) and run `python tests/e2e.py`, which loads the theme in headless Chromium with a mocked bridge.

Before a pull request:

```
npm ci && node tools/check.mjs      # syntax, version, translations
python tests/e2e.py                 # needs: pip install playwright && python -m playwright install chromium
```

## Strings and translations

- Write interface text in Russian and wrap it: `$t('Слушать')`, with placeholders `$t('Удалить плейлист «{0}»?', name)`. Plural forms use `plural(n, 'трек', 'трека', 'треков')`.
- Add the English entry to `theme/js/locales/en.js` (`'one|other'` for plurals). `tools/check.mjs` fails on missing or stale entries.
- Keep a sentence in one string; don't build sentences from pieces — word order differs between languages.
- A new language: copy `en.js` to `xx.js`, translate the values, register it in `theme/js/i18n.js` (`LANGS`, `detect()`, the dictionary import).

## Style

Two-space indentation, single quotes, no frameworks. CSS colours come from the palette tokens (`--accent`, `--text-2`…), so skins and fixed themes keep working.

## Bridge calls

Only call documented foo_ui_webview2 methods with documented parameters — the component validates parameters strictly.
