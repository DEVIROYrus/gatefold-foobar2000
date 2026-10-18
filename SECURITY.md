# Security

Please report vulnerabilities privately through **GitHub → Security → Report a vulnerability** on this repository rather than in a public issue. You'll get an answer within a week.

Scope: the theme (it runs inside foobar2000 with access to the foo_ui_webview2 API, including file and shell calls) and the installer (it downloads nothing at install time; everything it runs is bundled and checksummed at build time — see `installer/fetch-deps.ps1`).
