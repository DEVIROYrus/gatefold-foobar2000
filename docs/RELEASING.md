# Releasing

1. Update `CHANGELOG.md` (a `## [x.y.z]` section), bump `version` in `package.json`, `VERSION` in `theme/js/version.js` and `version` in `theme/gatefold.json`. If the release relies on a newer foo_ui_webview2, raise `requires.foo_ui_webview2` in `theme/gatefold.json` — the in-app updater then sends people to the installer instead of updating the theme alone.
2. `node tools/check.mjs && python tests/e2e.py`.
3. Commit, then `git tag vX.Y.Z && git push --tags` — or, without pushing a tag: Actions → **Release** → *Run workflow* with **publish** ticked (it builds the version in `package.json` and creates the tag on that commit). Without **publish** it is a dry run that keeps the files as an artifact.
4. The **Release** workflow writes this repository's name into `theme/js/version.js` (`REPO`, which the in-app updater asks for `releases/latest`; until then the update check stays off), fetches the versions pinned in `installer/deps.lock.json`, verifies them, builds `Gatefold-Setup-X.Y.Z.exe` and `gatefold-theme-X.Y.Z.zip`, writes `SHA256SUMS.txt` and publishes the GitHub release with the changelog section.
5. When **Watch bundled software** opens a pull request (a new foobar2000 or foo_ui_webview2), merge it after CI passes and tag a patch release.

Local build of the installer (Windows): `pwsh installer/fetch-deps.ps1`, then `ISCC installer\gatefold.iss /DAppVersion=X.Y.Z`. On Linux it compiles under Wine with `/DCompression=lzma2/max` (the ultra64 dictionary needs more memory than Wine's 32-bit compiler gets).

### What the in-app updater expects
- A release that is **not** a pre-release or draft (`/releases/latest` skips those) with the tag `vX.Y.Z`.
- Assets `gatefold-theme-X.Y.Z.zip` (one top folder `gatefold/`, deflate or stored), `SHA256SUMS.txt` that lists it, and optionally `Gatefold-Setup-X.Y.Z.exe`.
- Inside the archive, `js/version.js` with `VERSION = 'X.Y.Z'` and `index.html` — anything else is refused.
- Release notes up to the `<!-- gatefold:end -->` marker are shown in the update sheet.
