<#
  Gatefold - fb2k-probe.ps1 - what foobar2000 does on its very first start after the installer.

  Runs on a GitHub Windows runner right after a silent Gatefold install (fb2k-probe.yml):
    1. starts foobar2000 and records every window it opens (screenshot + UI Automation tree);
    2. if it asks which user interface to use, picks "Webview2 UI" like a person would;
    3. closes foobar2000 and finds where the choice was stored (the UI's GUID in the profile);
    4. starts it again to see that the choice stuck.
  Everything goes to .\probe (pushed to the probe-log branch by the workflow).
#>
$ErrorActionPreference = 'Continue'
$out = Join-Path (Get-Location) 'probe'; New-Item -ItemType Directory -Force $out | Out-Null
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
$A = [System.Windows.Automation.AutomationElement]
$fb = "$env:ProgramFiles\foobar2000\foobar2000.exe"
$prof = Join-Path $env:APPDATA 'foobar2000-v2'

function Shot($name) {
  try {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $out "$name.png")); $g.Dispose(); $bmp.Dispose()
  } catch { "shot $name failed: $_" }
}
function Tree($el, $d, $max) {
  if ($d -gt $max) { return }
  $c = $el.Current
  Write-Host ('{0}{1} | {2} | "{3}" | {4}' -f ('  ' * $d), $c.ControlType.ProgrammaticName, $c.ClassName, $c.Name, $c.AutomationId)
  foreach ($k in $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) { Tree $k ($d + 1) $max }
}
function Wins($tag) {
  $p = Get-Process foobar2000 -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { Write-Host "[$tag] foobar2000 is not running"; return @() }
  $cond = New-Object System.Windows.Automation.PropertyCondition ($A::ProcessIdProperty), $p.Id
  $w = @($A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond))
  Write-Host "[$tag] $($w.Count) top-level window(s)"
  foreach ($x in $w) { Tree $x 0 5 }
  return ,$w
}
function Find($root, $re) {
  foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if ($e.Current.Name -match $re) { return $e } }
  return $null
}
function Stop-Fb {
  & $fb /exit 2>$null
  for ($i = 0; $i -lt 30 -and (Get-Process foobar2000 -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
  if (Get-Process foobar2000 -ErrorAction SilentlyContinue) { 'foobar2000 did not exit on /exit - killed'; Stop-Process -Name foobar2000 -Force; Start-Sleep 2 }
}

"== profile before the first start"
Get-ChildItem -Recurse -File $prof | Where-Object { $_.FullName -notmatch '\\webview-ui\\' } | ForEach-Object { '{0,10}  {1}' -f $_.Length, $_.FullName.Substring($prof.Length) }

"`n== first start"
Start-Process $fb
Start-Sleep 15
Shot '1-first-start'
$w = Wins 'first start'

# foobar2000 asks "New user interface module(s) found": a list (libPPUI:CListControl, its rows are not
# exposed to UI Automation) and OK. Focus the list, type "w" (type-to-find: "Webview2 UI"), confirm.
$picked = $false
foreach ($x in $w) {
  if ($x.Current.Name -notmatch 'user interface') { continue }
  "dialog: '$($x.Current.Name)'"
  $list = $null
  foreach ($e in $x.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if ($e.Current.ClassName -match 'CListControl') { $list = $e } }
  if (-not $list) { 'no list in the dialog'; break }
  try { $list.SetFocus(); 'list focused' } catch { "cannot focus the list: $_" }
  Start-Sleep 1; [System.Windows.Forms.SendKeys]::SendWait('{HOME}'); Start-Sleep 1; Shot '2a-home'
  [System.Windows.Forms.SendKeys]::SendWait('w'); Start-Sleep 1; Shot '2b-typed-w'
  $ok = Find $x '^OK$'
  if ($ok) { try { $ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); "pressed OK" } catch { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); 'Enter' } }
  else { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); 'no OK button - Enter' }
  $picked = $true; break
}
if (-not $picked) { 'no user interface dialog' }
Start-Sleep 15
Shot '3-after-choice'
Wins 'after choice' | Out-Null
Stop-Fb

"`n== where the choice is stored (GUID of Webview2 UI = {3BF13CCC-477E-459A-A093-990D801AD37E})"
Get-ChildItem -Recurse -File $prof | Where-Object { $_.FullName -notmatch '\\webview-ui\\|\\user-components' } | ForEach-Object { '{0,10}  {1}' -f $_.Length, $_.FullName.Substring($prof.Length) }
$cfg = Join-Path $out 'config'; New-Item -ItemType Directory -Force $cfg | Out-Null
Get-ChildItem -File $prof | Where-Object { $_.Length -lt 20MB } | Copy-Item -Destination $cfg
if (Test-Path "$prof\configuration") { Copy-Item -Recurse "$prof\configuration" "$cfg\configuration" }
python -I "$PSScriptRoot\fb2k-probe-scan.py" $prof

"`n== second start (should open straight into Webview2 UI)"
Start-Process $fb
Start-Sleep 15
Shot '4-second-start'
Wins 'second start' | Out-Null
Stop-Fb
"`ndone"
