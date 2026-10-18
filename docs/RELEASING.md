# Releasing

1. Update `CHANGELOG.md` (a `## [x.y.z]` section), bump `version` in `package.json` and `VERSION` in `theme/js/version.js`.
2. `node tools/check.mjs && python tests/e2e.py`.
3. Commit, then `git tag vX.Y.Z && git push --tags`.
4. The **Release** workflow fetches the versions pinned in `installer/deps.lock.json`, verifies them, builds `Gatefold-Setup-X.Y.Z.exe` and `gatefold-theme-X.Y.Z.zip`, writes `SHA256SUMS.txt` and publishes the GitHub release with the changelog section.
5. When **Watch bundled software** opens a pull request (a new foobar2000 or foo_ui_webview2), merge it after CI passes and tag a patch release.

Local build of the installer (Windows): `pwsh installer/fetch-deps.ps1`, then `ISCC installer\gatefold.iss /DAppVersion=X.Y.Z`. On Linux it compiles under Wine with `/DCompression=lzma2/max` (the ultra64 dictionary needs more memory than Wine's 32-bit compiler gets).
