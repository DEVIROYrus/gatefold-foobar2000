<#
  Gatefold - first-start-check.ps1: after a silent install on a clean machine (CI), foobar2000's
  first start must open straight in Gatefold (Webview2 UI), without asking which interface to use.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$fb = "$env:ProgramFiles\foobar2000\foobar2000.exe"
Start-Process $fb
Start-Sleep 20
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
