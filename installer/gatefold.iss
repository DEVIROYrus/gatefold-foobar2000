; ============================================================================
;  Gatefold — installer (Inno Setup 6.4+; 6.6+ adds the automatic dark wizard)
;
;  What it does, in order:
;   1. finds foobar2000 (App Paths, uninstall keys, Program Files, or a folder the user picks —
;      portable installs included) and reads its version and architecture;
;   2. installs foobar2000 x64 if there is none, or updates a standard install that is older
;      than the bundled version (the unmodified official installer, run with /S);
;   3. installs the WebView2 Runtime if it is missing (Microsoft's bootstrapper, per-user);
;   4. installs foo_ui_webview2 into <profile>\user-components-x64\foo_ui_webview2 exactly as
;      foobar2000's own component installer lays it out, unless a same or newer version is there;
;   5. installs the theme into <profile>\webview-ui\<template>:
;        – updates an existing Gatefold/Aurora template in place (no re-selection needed),
;        – otherwise uses "default" when the profile has no templates yet (it loads with no
;          template selected), else a new "gatefold" template.
;  foobar2000 is closed (politely) before anything in its profile is touched.
;
;  Build: the release workflow runs installer\fetch-deps.ps1 (downloads foobar2000,
;  foo_ui_webview2 and the WebView2 bootstrapper, verifies them, writes deps\versions.iss),
;  then ISCC installer\gatefold.iss /DAppVersion=x.y.z
; ============================================================================

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef RepoUrl
  #define RepoUrl "https://github.com/DEVIROYrus/gatefold-foobar2000"
#endif
#ifndef Compression
  #define Compression "lzma2/ultra64"
#endif
#include "deps\versions.iss"

#define AppName "Gatefold"
#define ThemeSignature "js\palette-core.js"

[Setup]
AppId={{6B3F4C1E-2A7D-4E59-9C1B-8F0D2E7A5C31}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Gatefold contributors
AppPublisherURL={#RepoUrl}
AppSupportURL={#RepoUrl}/issues
AppUpdatesURL={#RepoUrl}/releases
VersionInfoVersion={#AppVersion}
VersionInfoDescription=Gatefold — a theme for foobar2000 (WebView2 UI)
DefaultDirName={localappdata}\Programs\Gatefold
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=Gatefold-Setup-{#AppVersion}
SetupIconFile=assets\gatefold.ico
UninstallDisplayIcon={app}\gatefold.ico
UninstallDisplayName={#AppName} for foobar2000
Compression={#Compression}
SolidCompression=yes
ShowLanguageDialog=auto
LanguageDetectionMethod=uilanguage
CloseApplications=no
RestartApplications=no
WizardImageFile=assets\wizard-100.bmp,assets\wizard-125.bmp,assets\wizard-150.bmp,assets\wizard-175.bmp,assets\wizard-200.bmp
WizardSmallImageFile=assets\wizard-small-100.bmp,assets\wizard-small-125.bmp,assets\wizard-small-150.bmp,assets\wizard-small-175.bmp,assets\wizard-small-200.bmp
#if Ver >= EncodeVer(6,6,0)
WizardStyle=modern dynamic
#else
WizardStyle=modern
#endif
WizardSizePercent=110

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Messages]
en.WelcomeLabel2=This will set up Gatefold — a modern interface for foobar2000 that takes its colours from your music.%n%nAnything that's missing (foobar2000, the WebView2 UI component, the WebView2 Runtime) is installed or updated automatically.
ru.WelcomeLabel2=Будет установлен Gatefold — современный интерфейс для foobar2000, который берёт цвета из вашей музыки.%n%nВсё недостающее (foobar2000, компонент WebView2 UI, среда WebView2) установится или обновится автоматически.

[CustomMessages]
en.PlanTitle=What will happen
ru.PlanTitle=Что будет сделано
en.PlanSub=Gatefold checked your computer. Nothing is changed until you press Install.
ru.PlanSub=Установщик проверил компьютер. Ничего не изменится, пока вы не нажмёте «Установить».
en.Fb2kNone=foobar2000: not found — foobar2000 %1 (64-bit) will be installed
ru.Fb2kNone=foobar2000: не найден — будет установлен foobar2000 %1 (64-бит)
en.Fb2kUpdate=foobar2000 %1 — will be updated to %2
ru.Fb2kUpdate=foobar2000 %1 — будет обновлён до %2
en.Fb2kOk=foobar2000 %1 — up to date
ru.Fb2kOk=foobar2000 %1 — актуальная версия
en.Fb2kPortable=foobar2000 %1 (portable) — used as is
ru.Fb2kPortable=foobar2000 %1 (портативный) — используется как есть
en.Fb2kOld=foobar2000 %1 (portable) is older than 2.0 — Gatefold needs foobar2000 2.x 64-bit; update it from foobar2000.org
ru.Fb2kOld=foobar2000 %1 (портативный) старше 2.0 — Gatefold нужен foobar2000 2.x 64-бит; обновите его с foobar2000.org
en.Fb2k32=foobar2000 %1 is 32-bit — a 64-bit foobar2000 %2 will be installed next to it
ru.Fb2k32=foobar2000 %1 32-битный — рядом будет установлен 64-битный foobar2000 %2
en.CompNew=WebView2 UI component — will be installed (%1)
ru.CompNew=Компонент WebView2 UI — будет установлен (%1)
en.CompUpd=WebView2 UI component %1 — will be updated to %2
ru.CompUpd=Компонент WebView2 UI %1 — будет обновлён до %2
en.CompOk=WebView2 UI component %1 — up to date
ru.CompOk=Компонент WebView2 UI %1 — актуальная версия
en.Wv2New=WebView2 Runtime — will be installed (from Microsoft)
ru.Wv2New=Среда WebView2 — будет установлена (с сайта Microsoft)
en.Wv2Ok=WebView2 Runtime %1 — present
ru.Wv2Ok=Среда WebView2 %1 — есть
en.ThemeTo=Gatefold %1 — into the “%2” template
ru.ThemeTo=Gatefold %1 — в шаблон «%2»
en.ThemeUpd=Gatefold — will update your “%1” template in place
ru.ThemeUpd=Gatefold — обновит ваш шаблон «%1» на месте
en.Profile=Profile: %1
ru.Profile=Профиль: %1
en.OtherFolder=Use a different foobar2000 folder (e.g. a portable one)…
ru.OtherFolder=Указать другую папку foobar2000 (например, портативную)…
en.PickFolder=Choose the folder that contains foobar2000.exe
ru.PickFolder=Выберите папку, в которой лежит foobar2000.exe
en.NoExe=There is no foobar2000.exe in this folder.
ru.NoExe=В этой папке нет foobar2000.exe.
en.Running=foobar2000 is running. It has to be closed while Gatefold installs into its profile.%n%nClose foobar2000 now?
ru.Running=foobar2000 запущен. Его нужно закрыть, пока Gatefold устанавливается в профиль.%n%nЗакрыть foobar2000 сейчас?
en.StillRunning=foobar2000 is still running. Close it and press Next again.
ru.StillRunning=foobar2000 всё ещё запущен. Закройте его и снова нажмите «Далее».
en.StInstallFb=Installing foobar2000 %1…
ru.StInstallFb=Устанавливаю foobar2000 %1…
en.StInstallWv=Installing the WebView2 Runtime…
ru.StInstallWv=Устанавливаю среду WebView2…
en.FbFailed=The foobar2000 installer did not finish (code %1). Gatefold will still be installed; run the foobar2000 installer again later.
ru.FbFailed=Установщик foobar2000 не завершился (код %1). Gatefold всё равно будет установлен; запустите установку foobar2000 позже ещё раз.
en.WvFailed=The WebView2 Runtime could not be installed (code %1). Install it from Microsoft: https://go.microsoft.com/fwlink/p/?LinkId=2124703
ru.WvFailed=Не удалось установить среду WebView2 (код %1). Установите её с сайта Microsoft: https://go.microsoft.com/fwlink/p/?LinkId=2124703
en.LastStepTitle=One last step in foobar2000
ru.LastStepTitle=Последний шаг в foobar2000
en.LastStep1=In foobar2000 open File → Preferences → Display, choose “Webview2 UI” as the Default User Interface and press OK. foobar2000 does not let other programs change this setting, so it takes one click — only once.
ru.LastStep1=В foobar2000 откройте File → Preferences → Display, выберите «Webview2 UI» в списке Default User Interface и нажмите OK. foobar2000 не даёт другим программам менять этот параметр, поэтому нужен один щелчок — только один раз.
en.LastStep2=Then on the Display → WebView2 UI page choose the “%1” template and press Apply.
ru.LastStep2=Затем на странице Display → WebView2 UI выберите шаблон «%1» и нажмите Apply.
en.LastStepUpd=Everything is in place — your interface is updated. Restart foobar2000 if it was open.
ru.LastStepUpd=Всё на месте — интерфейс обновлён. Перезапустите foobar2000, если он был открыт.
en.Launch=Open foobar2000
ru.Launch=Открыть foobar2000
en.Recommend=Recommended (optional) components: Playback Statistics (foo_playcount) and DR Meter (foo_dr_meter) — foobar2000.org/components
ru.Recommend=Рекомендуемые (необязательные) компоненты: Playback Statistics (foo_playcount) и DR Meter (foo_dr_meter) — foobar2000.org/components
en.NeedsX64=Gatefold needs 64-bit Windows 10 or 11.
ru.NeedsX64=Gatefold нужна 64-битная Windows 10 или 11.

[Files]
; theme
Source: "..\theme\*"; DestDir: "{code:ThemeDir}"; Flags: recursesubdirs createallsubdirs ignoreversion
; the component, laid out as foobar2000 itself installs it (see fetch-deps.ps1)
Source: "deps\foo_ui_webview2\*"; DestDir: "{code:ComponentDir}"; Flags: recursesubdirs createallsubdirs ignoreversion uninsneveruninstall; Check: NeedComponent
; installers run during setup, never copied
Source: "deps\{#FB2K_FILE}"; Flags: dontcopy
Source: "deps\MicrosoftEdgeWebview2Setup.exe"; Flags: dontcopy
; uninstaller icon
Source: "assets\gatefold.ico"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Gatefold"; ValueType: string; ValueName: "ThemeDir"; ValueData: "{code:ThemeDir}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Gatefold"; ValueType: string; ValueName: "Profile"; ValueData: "{code:ProfileDir}"
Root: HKCU; Subkey: "Software\Gatefold"; ValueType: string; ValueName: "Foobar2000"; ValueData: "{code:FoobarDir}"
Root: HKCU; Subkey: "Software\Gatefold"; ValueType: string; ValueName: "Version"; ValueData: "{#AppVersion}"

[Run]
Filename: "{code:FoobarExe}"; Description: "{cm:Launch}"; Flags: postinstall nowait skipifsilent unchecked; Check: HaveFoobar

[Code]
const
  WV2_KEY = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

var
  FbDir, FbVer, ProfDir, TplName, TplDir, CompVer, WvVer: String;
  FbFound, FbPortable, Fb64, NeedFb, NeedWv, NeedComp, InPlace, Fb2kTooOld: Boolean;
  PlanPage: TWizardPage;
  PlanText: TNewStaticText;
  PickBtn: TNewButton;
  FinishNote, FinishHead: TNewStaticText;

{ ---------------------------------------------------------------- helpers }
function VerPart(var S: String): Integer;
var P: Integer; T: String;
begin
  P := Pos('.', S);
  if P = 0 then begin T := S; S := ''; end else begin T := Copy(S, 1, P - 1); S := Copy(S, P + 1, Length(S)); end;
  Result := StrToIntDef(Trim(T), 0);
end;

{ -1 if A < B, 0 if equal, 1 if A > B ("2.26.1" vs "2.24.5.0") }
function CompareVer(A, B: String): Integer;
var I, X, Y: Integer;
begin
  Result := 0;
  for I := 1 to 4 do begin
    X := VerPart(A); Y := VerPart(B);
    if X < Y then begin Result := -1; Exit; end;
    if X > Y then begin Result := 1; Exit; end;
  end;
end;

function StripV(S: String): String;
begin
  Result := S;
  if (Length(Result) > 0) and ((Result[1] = 'v') or (Result[1] = 'V')) then Delete(Result, 1, 1);
end;

{ machine type from the PE header: $8664 = x64, $14C = x86, $AA64 = ARM64 }
function PEMachine(const FileName: String): Integer;
var FS: TFileStream; Buf: AnsiString; Off: Integer;
begin
  Result := 0;
  try
    FS := TFileStream.Create(FileName, fmOpenRead or fmShareDenyNone);
    try
      SetLength(Buf, 4096);
      FS.ReadBuffer(Buf, 4096);
      Off := Ord(Buf[$3C + 1]) or (Ord(Buf[$3C + 2]) shl 8) or (Ord(Buf[$3C + 3]) shl 16);
      if (Off > 0) and (Off + 6 < 4096) and (Copy(Buf, Off + 1, 2) = 'PE') then
        Result := Ord(Buf[Off + 5]) or (Ord(Buf[Off + 6]) shl 8);
    finally
      FS.Free;
    end;
  except
    Result := 0;
  end;
end;

function FileVer(const FileName: String): String;
begin
  if not GetVersionNumbersString(FileName, Result) then Result := '';
end;

{ ---------------------------------------------------------------- detection }
procedure UseFoobarDir(const Dir: String);
var Exe: String;
begin
  Exe := AddBackslash(Dir) + 'foobar2000.exe';
  FbFound := FileExists(Exe);
  if not FbFound then Exit;
  FbDir := RemoveBackslash(Dir);
  FbVer := FileVer(Exe);
  Fb64 := PEMachine(Exe) <> $14C;
  FbPortable := FileExists(AddBackslash(FbDir) + 'portable_mode_enabled');
end;

function TryDir(const Dir: String): Boolean;
begin
  Result := (Dir <> '') and FileExists(AddBackslash(Dir) + 'foobar2000.exe');
  if Result then UseFoobarDir(Dir);
end;

procedure FindFoobar;
var S: String;
begin
  FbFound := False;
  if RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\foobar2000.exe', '', S) then
    if TryDir(ExtractFileDir(RemoveQuotes(S))) and Fb64 then Exit;
  if RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\foobar2000', 'UninstallString', S) then
    if TryDir(ExtractFileDir(RemoveQuotes(S))) and Fb64 then Exit;
  if TryDir(ExpandConstant('{commonpf64}\foobar2000')) and Fb64 then Exit;
  if RegQueryStringValue(HKCU, 'Software\Gatefold', 'Foobar2000', S) then
    if TryDir(S) and Fb64 then Exit;
  { a 32-bit install: noted, a 64-bit one is installed next to it }
  if not FbFound then TryDir(ExpandConstant('{commonpf32}\foobar2000'));
end;

function HasAnyTemplate: Boolean;
var FR: TFindRec;
begin
  Result := False;
  if FindFirst(AddBackslash(ProfDir) + 'webview-ui\*', FR) then
    try
      repeat
        if (FR.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0) and (FR.Name <> '.') and (FR.Name <> '..') and
           FileExists(AddBackslash(ProfDir) + 'webview-ui\' + FR.Name + '\index.html') then Result := True;
      until Result or not FindNext(FR);
    finally
      FindClose(FR);
    end;
end;

procedure DetectAll;
var S, Dll: String; FR: TFindRec; Cand: String;
begin
  { profile }
  if FbFound and FbPortable then ProfDir := AddBackslash(FbDir) + 'profile'
  else ProfDir := ExpandConstant('{userappdata}\foobar2000-v2');

  { foobar2000: install / update / keep }
  Fb2kTooOld := False;
  if not FbFound then NeedFb := True
  else if not Fb64 then NeedFb := True
  else if FbPortable then begin
    NeedFb := False;
    Fb2kTooOld := CompareVer(FbVer, '2.0') < 0;
  end else NeedFb := CompareVer(FbVer, '{#FB2K_VERSION}') < 0;
  if NeedFb and (not FbFound or not Fb64) then ProfDir := ExpandConstant('{userappdata}\foobar2000-v2');

  { WebView2 Runtime (machine-wide or per-user) }
  WvVer := '';
  if not RegQueryStringValue(HKLM32, WV2_KEY, 'pv', WvVer) then
    if not RegQueryStringValue(HKLM64, WV2_KEY, 'pv', WvVer) then
      RegQueryStringValue(HKCU, WV2_KEY, 'pv', WvVer);
  NeedWv := (WvVer = '') or (WvVer = '0.0.0.0');

  { component }
  Dll := AddBackslash(ProfDir) + 'user-components-x64\foo_ui_webview2\foo_ui_webview2.dll';
  CompVer := '';
  if FileExists(Dll) then CompVer := FileVer(Dll);
  NeedComp := (CompVer = '') or (CompareVer(CompVer, StripV('{#FUW2_VERSION}')) < 0);

  { theme target: an existing Gatefold/Aurora template is updated in place }
  InPlace := False; TplName := '';
  if RegQueryStringValue(HKCU, 'Software\Gatefold', 'ThemeDir', S) and FileExists(AddBackslash(S) + '{#ThemeSignature}')
     and (Pos(Lowercase(AddBackslash(ProfDir)), Lowercase(S)) = 1) then begin
    TplDir := S; TplName := ExtractFileName(RemoveBackslash(S)); InPlace := True;
  end;
  if (TplName = '') and FindFirst(AddBackslash(ProfDir) + 'webview-ui\*', FR) then begin
    try
      repeat
        if (FR.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0) and (FR.Name <> '.') and (FR.Name <> '..') then begin
          Cand := AddBackslash(ProfDir) + 'webview-ui\' + FR.Name;
          if FileExists(AddBackslash(Cand) + '{#ThemeSignature}') then begin
            TplDir := Cand; TplName := FR.Name; InPlace := True;
          end;
        end;
      until InPlace or not FindNext(FR);
    finally
      FindClose(FR);
    end;
  end;
  if TplName = '' then begin
    { "default" is what the component loads while no template was ever selected — use it when the
      profile has no templates at all; otherwise a new "gatefold" template (selected once, see the finish page) }
    if HasAnyTemplate then TplName := 'gatefold' else TplName := 'default';
    TplDir := AddBackslash(ProfDir) + 'webview-ui\' + TplName;
  end;
end;

{ ---------------------------------------------------------------- getters used as code: constants }
function ThemeDir(Param: String): String; begin Result := TplDir; end;
function ProfileDir(Param: String): String; begin Result := ProfDir; end;
function FoobarDir(Param: String): String; begin Result := FbDir; end;
function ComponentDir(Param: String): String; begin Result := AddBackslash(ProfDir) + 'user-components-x64\foo_ui_webview2'; end;
function FoobarExe(Param: String): String; begin Result := AddBackslash(FbDir) + 'foobar2000.exe'; end;
function NeedComponent: Boolean; begin Result := NeedComp; end;
function HaveFoobar: Boolean; begin Result := FileExists(AddBackslash(FbDir) + 'foobar2000.exe'); end;

{ ---------------------------------------------------------------- the plan page }
{ ✓ nothing to do · ＋ will be installed/updated · ! needs your attention }
function Mark(Act, Warn: Boolean): String;
begin
  if Warn then Result := '!   ' else if Act then Result := '+   ' else Result := '✓   ';
end;

procedure RenderPlan;
var L: String;
begin
  if not FbFound then L := FmtMessage(CustomMessage('Fb2kNone'), ['{#FB2K_VERSION}'])
  else if not Fb64 then L := FmtMessage(CustomMessage('Fb2k32'), [FbVer, '{#FB2K_VERSION}'])
  else if FbPortable and Fb2kTooOld then L := FmtMessage(CustomMessage('Fb2kOld'), [FbVer])
  else if FbPortable then L := FmtMessage(CustomMessage('Fb2kPortable'), [FbVer])
  else if NeedFb then L := FmtMessage(CustomMessage('Fb2kUpdate'), [FbVer, '{#FB2K_VERSION}'])
  else L := FmtMessage(CustomMessage('Fb2kOk'), [FbVer]);
  L := Mark(not FbFound or NeedFb, FbPortable and Fb2kTooOld) + L + #13#10#13#10;
  if NeedComp and (CompVer <> '') then L := L + Mark(True, False) + FmtMessage(CustomMessage('CompUpd'), [CompVer, StripV('{#FUW2_VERSION}')])
  else if NeedComp then L := L + Mark(True, False) + FmtMessage(CustomMessage('CompNew'), [StripV('{#FUW2_VERSION}')])
  else L := L + Mark(False, False) + FmtMessage(CustomMessage('CompOk'), [CompVer]);
  L := L + #13#10#13#10;
  if NeedWv then L := L + Mark(True, False) + CustomMessage('Wv2New') else L := L + Mark(False, False) + FmtMessage(CustomMessage('Wv2Ok'), [WvVer]);
  L := L + #13#10#13#10;
  if InPlace then L := L + Mark(True, False) + FmtMessage(CustomMessage('ThemeUpd'), [TplName])
  else L := L + Mark(True, False) + FmtMessage(CustomMessage('ThemeTo'), ['{#AppVersion}', TplName]);
  L := L + #13#10#13#10 + FmtMessage(CustomMessage('Profile'), [ProfDir]);
  PlanText.Caption := L;
end;

procedure PickClick(Sender: TObject);
var Dir: String;
begin
  Dir := FbDir;
  if BrowseForFolder(CustomMessage('PickFolder'), Dir, False) then begin
    if not FileExists(AddBackslash(Dir) + 'foobar2000.exe') then begin
      MsgBox(CustomMessage('NoExe'), mbError, MB_OK); Exit;
    end;
    UseFoobarDir(Dir);
    DetectAll;
    RenderPlan;
  end;
end;

function InitializeSetup: Boolean;
begin
  Result := IsWin64;
  if not Result then begin MsgBox(CustomMessage('NeedsX64'), mbCriticalError, MB_OK); Exit; end;
  FindFoobar;
  DetectAll;
end;

procedure InitializeWizard;
begin
  PlanPage := CreateCustomPage(wpWelcome, CustomMessage('PlanTitle'), CustomMessage('PlanSub'));
  PlanText := TNewStaticText.Create(PlanPage);
  PlanText.Parent := PlanPage.Surface;
  PlanText.AutoSize := False;
  PlanText.WordWrap := True;
  PlanText.Left := 0; PlanText.Top := 0;
  PlanText.Width := PlanPage.SurfaceWidth;
  PlanText.Height := PlanPage.SurfaceHeight - ScaleY(36);
  PickBtn := TNewButton.Create(PlanPage);
  PickBtn.Parent := PlanPage.Surface;
  PickBtn.Caption := CustomMessage('OtherFolder');
  PickBtn.Left := 0;
  PickBtn.Top := PlanPage.SurfaceHeight - ScaleY(28);
  PickBtn.Width := PlanPage.SurfaceWidth;
  PickBtn.Height := ScaleY(26);
  PickBtn.OnClick := @PickClick;
  RenderPlan;
end;

{ ---------------------------------------------------------------- foobar2000 must be closed }
function FoobarRunning: Boolean;
var Loc, Svc, Res: Variant;
begin
  Result := False;
  try
    Loc := CreateOleObject('WbemScripting.SWbemLocator');
    Svc := Loc.ConnectServer('.', 'root\CIMV2');
    Res := Svc.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE Name = ''foobar2000.exe''');
    Result := Res.Count > 0;
  except
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var I, RC: Integer;
begin
  Result := '';
  if not FoobarRunning then Exit;
  if WizardSilent or (MsgBox(CustomMessage('Running'), mbConfirmation, MB_YESNO) = IDYES) then begin
    { taskkill without /F asks the window to close, like the user would }
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM foobar2000.exe', '', SW_HIDE, ewWaitUntilTerminated, RC);
    for I := 1 to 40 do begin
      if not FoobarRunning then Exit;
      Sleep(250);
    end;
  end;
  if FoobarRunning then Result := CustomMessage('StillRunning');
end;

{ ---------------------------------------------------------------- dependencies, before the files }
procedure SuspendAndLog(const Msg: String);
begin
  Log(Msg);
  if not WizardSilent then MsgBox(Msg, mbError, MB_OK);
end;

procedure InstallDependencies;
var Exe, Args: String; RC: Integer;
begin
  if NeedWv then begin
    WizardForm.StatusLabel.Caption := CustomMessage('StInstallWv');
    ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
    if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, RC) or (RC <> 0) then
      SuspendAndLog(FmtMessage(CustomMessage('WvFailed'), [IntToStr(RC)]));
  end;
  if NeedFb then begin
    WizardForm.StatusLabel.Caption := FmtMessage(CustomMessage('StInstallFb'), ['{#FB2K_VERSION}']);
    ExtractTemporaryFile('{#FB2K_FILE}');
    Exe := ExpandConstant('{tmp}\{#FB2K_FILE}');
    Args := '/S';
    if FbFound and Fb64 and not FbPortable then Args := Args + ' /D=' + FbDir;
    { the official installer asks for elevation itself (UAC); ShellExec lets it }
    if not ShellExec('', Exe, Args, '', SW_SHOWNORMAL, ewWaitUntilTerminated, RC) or (RC <> 0) then
      SuspendAndLog(FmtMessage(CustomMessage('FbFailed'), [IntToStr(RC)]))
    else begin
      if not (FbFound and Fb64) then begin
        FbFound := False; Fb64 := False;
        if not TryDir(ExpandConstant('{commonpf64}\foobar2000')) then FindFoobar;
      end else UseFoobarDir(FbDir);
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then InstallDependencies;
end;

{ ---------------------------------------------------------------- finish page: the one manual step }
procedure CurPageChanged(CurPageID: Integer);
var T: String;
begin
  if CurPageID <> wpFinished then Exit;
  if InPlace then T := CustomMessage('LastStepUpd')
  else begin
    T := CustomMessage('LastStep1');
    if TplName <> 'default' then T := T + #13#10#13#10 + FmtMessage(CustomMessage('LastStep2'), [TplName]);
  end;
  T := T + #13#10#13#10 + CustomMessage('Recommend');
  if FinishNote = nil then begin
    FinishHead := TNewStaticText.Create(WizardForm);
    FinishHead.Parent := WizardForm.FinishedPage;
    FinishHead.Font.Style := [fsBold];
    FinishHead.Left := WizardForm.FinishedLabel.Left;
    FinishNote := TNewStaticText.Create(WizardForm);
    FinishNote.Parent := WizardForm.FinishedPage;
    FinishNote.AutoSize := False;
    FinishNote.WordWrap := True;
    FinishNote.Left := WizardForm.FinishedLabel.Left;
    FinishNote.Width := WizardForm.FinishedLabel.Width;
  end;
  FinishHead.Visible := not InPlace;
  FinishHead.Caption := CustomMessage('LastStepTitle');
  FinishHead.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(14);
  if InPlace then FinishNote.Top := FinishHead.Top else FinishNote.Top := FinishHead.Top + FinishHead.Height + ScaleY(6);
  FinishNote.Height := WizardForm.FinishedPage.Height - FinishNote.Top - ScaleY(60);
  FinishNote.Caption := T;
  if WizardForm.RunList.Items.Count > 0 then
    WizardForm.RunList.Top := FinishNote.Top + FinishNote.Height + ScaleY(4);
end;
