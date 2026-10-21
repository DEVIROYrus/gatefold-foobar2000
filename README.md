# bundled-software

Copies of the official, unmodified installers that the Gatefold installer bundles. The build uses
them only when the original site cannot be reached (`.github/workflows/deps-fetch.yml`); each file is
checked against the SHA-256 pinned in `installer/deps.lock.json` and its Authenticode signature.

| File | Publisher | SHA-256 |
|---|---|---|
| foobar2000-x64_v2.26.1.exe | foobar2000 (signed by Illustrate Ltd) | 72fe15a88b085ee4e49d68114e2bb9655000c2e0fdf40dcc128bbef8bcaf3600 |

foobar2000 is freeware © Peter Pawłowski — https://www.foobar2000.org
