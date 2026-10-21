<#
  Gatefold - first-start-check.ps1: after a silent install on a clean machine (CI), foobar2000's
  first start must open straight in Gatefold (Webview2 UI), without asking which interface to use.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
$A = [System.Windows.Automation.AutomationElement]
$fb = "$env:ProgramFiles\foobar2000\foobar2000.exe"
$prof = Join-Path $env:APPDATA 'foobar2000-v2'
'profile before the first start:'
Get-ChildItem -Recurse -File $prof -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch 'webview-ui|user-components' } | ForEach-Object { '  {0,10}  {1}' -f $_.Length, $_.FullName.Substring($prof.Length) }
# the installer's preset, run again on a copy, so its output is here too
$copy = Join-Path $env:TEMP 'config-copy.sqlite'
Copy-Item (Join-Path $prof 'config.sqlite') $copy -Force -ErrorAction SilentlyContinue
'preset-ui on a copy:'
& powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '..\installer\preset-ui.ps1') -Config $copy 2>&1 | ForEach-Object { "  $_" }
"  exit code: $LASTEXITCODE"
Start-Process $fb
Start-Sleep 20
try {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $bmp.Save((Join-Path (Get-Location) 'first-start.png')); $g.Dispose(); $bmp.Dispose()
} catch { "screenshot failed: $_" }
$p = Get-Process foobar2000 -ErrorAction SilentlyContinue | Select-Object -First 1
$wins = @()
if ($p) {
  $cond = New-Object System.Windows.Automation.PropertyCondition ($A::ProcessIdProperty), $p.Id
  $wins = @($A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond))
}
foreach ($w in $wins) { 'window: {0} | "{1}"' -f $w.Current.ClassName, $w.Current.Name }
& $fb /exit 2>$null
for ($i = 0; $i -lt 20 -and (Get-Process foobar2000 -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
Stop-Process -Name foobar2000 -Force -ErrorAction SilentlyContinue
if (-not $p) { throw 'foobar2000 did not start' }
if ($wins | Where-Object { $_.Current.Name -match 'user interface' }) { throw 'foobar2000 asked which user interface to use' }
if (-not ($wins | Where-Object { $_.Current.ClassName -eq 'foo_ui_webview2_MainWindow' })) { throw 'foobar2000 did not open in Webview2 UI' }
'ok: the first start opens in Gatefold'
