<#
.SYNOPSIS
  Downloads and verifies what the Gatefold installer bundles, and writes installer\deps\versions.iss.

  • foobar2000 x64 — the latest stable installer from foobar2000.org, unmodified (its license
    allows redistributing unmodified installers only). Authenticode is checked when present.
  • foo_ui_webview2 — the latest GitHub release (GPL-3.0-or-later), laid out the way foobar2000 x64
    installs a component: the whole archive is extracted, then the files of its x64\ subfolder
    overwrite those in the root (https://www.foobar2000.org — "RTFM", component packaging).
  • Microsoft Edge WebView2 Evergreen bootstrapper — Microsoft-signed, redistributable.

  Pin versions with -Fb2kVersion / -ComponentTag for reproducible builds; SHA-256 of everything is
  written to deps\SHA256SUMS.txt and printed in the release notes.
#>
param(
  [string]$Fb2kVersion = '',
  [string]$ComponentRepo = 'NereaFantasia/foo_ui_webview2',
  [string]$ComponentTag = '',
  [string]$OutDir = (Join-Path $PSScriptRoot 'deps'),
  # downloads kept between runs (actions/cache): the build does not depend on foobar2000.org being
  # reachable from CI every time, and each file is fetched once per pinned version
  [string]$Cache = (Join-Path $PSScriptRoot '.dl-cache')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$ua = @{ 'User-Agent' = 'gatefold-build (+https://github.com)' }
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
function Fetch([string]$Url, [string]$Out, [string]$Name) {
  $c = Join-Path $Cache $Name
  if (Test-Path $c) { Copy-Item $c $Out -Force; Write-Host "  from cache: $Name"; return }
  for ($i = 1; $i -le 5; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Headers $ua $Url -OutFile $Out; Copy-Item $Out $c -Force; return }
    catch { if ($i -eq 5) { throw }; Write-Host "  attempt $i failed ($($_.Exception.Message)), retrying"; Start-Sleep (20 * $i) }
  }
}

function Check-Signature($path, [switch]$Required) {
  $sig = Get-AuthenticodeSignature -FilePath $path
  Write-Host ("  signature: {0} {1}" -f $sig.Status, $sig.SignerCertificate.Subject)
  if ($Required -and $sig.Status -ne 'Valid') { throw "Bad signature on $path" }
}

# ---------------------------------------------------------------- foobar2000
if (-not $Fb2kVersion) {
  $page = (Invoke-WebRequest -UseBasicParsing -Headers $ua 'https://www.foobar2000.org/download').Content
  # stable builds only: preview/beta file names carry a suffix after the version
  $m = [regex]::Matches($page, 'foobar2000-x64_v(\d+\.\d+(?:\.\d+)?)\.exe') | ForEach-Object { $_.Groups[1].Value } | Sort-Object { [version]$_ } -Descending
  if (-not $m) { throw 'Could not find the foobar2000 x64 installer on foobar2000.org/download' }
  $Fb2kVersion = $m[0]
}
$fbFile = "foobar2000-x64_v$Fb2kVersion.exe"
Write-Host "foobar2000 $Fb2kVersion"
Fetch "https://www.foobar2000.org/downloads/$fbFile" (Join-Path $OutDir $fbFile) $fbFile
Check-Signature (Join-Path $OutDir $fbFile) -Required   # also guards the copy from the bundled-software release

# ---------------------------------------------------------------- foo_ui_webview2
$api = if ($ComponentTag) { "https://api.github.com/repos/$ComponentRepo/releases/tags/$ComponentTag" } else { "https://api.github.com/repos/$ComponentRepo/releases/latest" }
$hdr = $ua.Clone(); if ($env:GITHUB_TOKEN) { $hdr['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
$rel = Invoke-RestMethod -Headers $hdr $api
$asset = $rel.assets | Where-Object { $_.name -like '*.fb2k-component' } | Select-Object -First 1
if (-not $asset) { throw "No .fb2k-component asset in $ComponentRepo $($rel.tag_name)" }
Write-Host "foo_ui_webview2 $($rel.tag_name) — $($asset.name)"
$pkg = Join-Path $OutDir $asset.name
Fetch $asset.browser_download_url $pkg $asset.name
$raw = Join-Path $OutDir 'fuw2_raw'; $dst = Join-Path $OutDir 'foo_ui_webview2'
Remove-Item -Recurse -Force $raw, $dst -ErrorAction SilentlyContinue
Expand-Archive -Path $pkg -DestinationPath $raw -Force           # .fb2k-component is a zip
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item -Recurse -Force (Join-Path $raw '*') $dst
$x64 = Join-Path $raw 'x64'
if (Test-Path $x64) { Copy-Item -Recurse -Force (Join-Path $x64 '*') $dst }   # x64 files overwrite the root
if (-not (Test-Path (Join-Path $dst 'foo_ui_webview2.dll'))) { throw 'foo_ui_webview2.dll missing after layout' }
$bytes = [IO.File]::ReadAllBytes((Join-Path $dst 'foo_ui_webview2.dll'))
$peOff = [BitConverter]::ToInt32($bytes, 0x3C); $machine = [BitConverter]::ToUInt16($bytes, $peOff + 4)
if ($machine -ne 0x8664) { throw ("root foo_ui_webview2.dll is not x64 (machine 0x{0:X})" -f $machine) }

# ---------------------------------------------------------------- WebView2 bootstrapper
$wv = Join-Path $OutDir 'MicrosoftEdgeWebview2Setup.exe'
Fetch 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' $wv 'MicrosoftEdgeWebview2Setup.exe'
Check-Signature $wv -Required

# ---------------------------------------------------------------- versions + checksums
@"
#define FB2K_VERSION "$Fb2kVersion"
#define FB2K_FILE "$fbFile"
#define FUW2_VERSION "$($rel.tag_name)"
"@ | Set-Content -Encoding UTF8 (Join-Path $OutDir 'versions.iss')

$sums = Get-ChildItem -File $OutDir | Where-Object { $_.Name -ne 'SHA256SUMS.txt' -and $_.Name -ne 'versions.iss' } |
  ForEach-Object { "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower(), $_.Name }
$sums | Set-Content -Encoding ASCII (Join-Path $OutDir 'SHA256SUMS.txt')
$sums | ForEach-Object { Write-Host "  $_" }
"fb2k=$Fb2kVersion" | Out-File -Append -Encoding utf8 $env:GITHUB_OUTPUT -ErrorAction SilentlyContinue
"fuw2=$($rel.tag_name)" | Out-File -Append -Encoding utf8 $env:GITHUB_OUTPUT -ErrorAction SilentlyContinue
