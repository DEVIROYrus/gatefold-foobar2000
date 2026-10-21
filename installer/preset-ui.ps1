<#
  Gatefold - preset-ui.ps1: make Webview2 UI foobar2000's user interface, so that it opens straight in
  Gatefold instead of asking "New user interface module(s) found" or needing Preferences.

  Run by the installer (ssPostInstall) with foobar2000 closed:
    powershell -NoProfile -ExecutionPolicy Bypass -File preset-ui.ps1 -Db "<profile>\config.sqlite"

  foobar2000 keeps its settings in <profile>\config.sqlite (found with tools/fb2k-probe.ps1, 2.26):
    configBlobs  cfg_var.094A28DA-C6E8-4392-BAF1-AD0F29E5B303  the user interface: a GUID (16 bytes)
    configBlobs  cfg_var.AD13B1D4-A6F7-425E-A93B-2A3C7DC37A93  interfaces already offered: uint32 count + GUIDs
  The file is copied to config.sqlite.before-gatefold first. SQLite is Windows' own winsqlite3.dll.
  Exit code 0 = done; anything else = nothing changed (the installer then shows the manual step).
#>
param([Parameter(Mandatory = $true)][string]$Db)
$ErrorActionPreference = 'Stop'
try {
  if (-not (Test-Path -LiteralPath $Db)) { Write-Output "no configuration at $Db"; exit 2 }
  $bak = "$Db.before-gatefold"
  if (-not (Test-Path -LiteralPath $bak)) { Copy-Item -LiteralPath $Db -Destination $bak }

  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class GfSql {
  const string L = "winsqlite3.dll";
  [DllImport(L)] static extern int sqlite3_open_v2(byte[] name, out IntPtr db, int flags, IntPtr vfs);
  [DllImport(L)] static extern int sqlite3_close(IntPtr db);
  [DllImport(L)] static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int n, out IntPtr st, IntPtr tail);
  [DllImport(L)] static extern int sqlite3_bind_blob(IntPtr st, int i, byte[] v, int n, IntPtr destructor);
  [DllImport(L)] static extern int sqlite3_bind_text(IntPtr st, int i, byte[] v, int n, IntPtr destructor);
  [DllImport(L)] static extern int sqlite3_step(IntPtr st);
  [DllImport(L)] static extern IntPtr sqlite3_column_blob(IntPtr st, int i);
  [DllImport(L)] static extern int sqlite3_column_bytes(IntPtr st, int i);
  [DllImport(L)] static extern int sqlite3_finalize(IntPtr st);
  [DllImport(L)] static extern IntPtr sqlite3_errmsg(IntPtr db);
  static readonly IntPtr TRANSIENT = new IntPtr(-1);
  static byte[] U(string s) { return Encoding.UTF8.GetBytes(s + "\0"); }
  static IntPtr db;
  static string Err() { return Marshal.PtrToStringAnsi(sqlite3_errmsg(db)); }
  static IntPtr Prep(string sql) {
    IntPtr st; if (sqlite3_prepare_v2(db, U(sql), -1, out st, IntPtr.Zero) != 0) throw new Exception(sql + ": " + Err()); return st;
  }
  static void Exec(string sql) { IntPtr st = Prep(sql); int rc = sqlite3_step(st); sqlite3_finalize(st); if (rc != 101) throw new Exception(sql + ": " + Err()); }
  static byte[] GetBlob(string name) {
    IntPtr st = Prep("SELECT value FROM configBlobs WHERE name = ?");
    byte[] n = Encoding.UTF8.GetBytes(name); sqlite3_bind_text(st, 1, n, n.Length, TRANSIENT);
    byte[] r = null;
    if (sqlite3_step(st) == 100) { int len = sqlite3_column_bytes(st, 0); r = new byte[len]; if (len > 0) Marshal.Copy(sqlite3_column_blob(st, 0), r, 0, len); }
    sqlite3_finalize(st); return r;
  }
  static void SetBlob(string name, byte[] v) {
    IntPtr st = Prep("INSERT OR REPLACE INTO configBlobs (name, value) VALUES (?, ?)");
    byte[] n = Encoding.UTF8.GetBytes(name); sqlite3_bind_text(st, 1, n, n.Length, TRANSIENT);
    sqlite3_bind_blob(st, 2, v, v.Length, TRANSIENT);
    int rc = sqlite3_step(st); sqlite3_finalize(st); if (rc != 101) throw new Exception("write " + name + ": " + Err());
  }
  public static string Run(string path) {
    byte[] ui = new Guid("3BF13CCC-477E-459A-A093-990D801AD37E").ToByteArray();     // Webview2 UI (little-endian, as stored)
    byte[] dui = new Guid("6EBCE8DE-A55C-4E09-9EFE-A8B6A66D69FD").ToByteArray();    // Default User Interface
    if (sqlite3_open_v2(U(path), out db, 2 /* READWRITE */, IntPtr.Zero) != 0) throw new Exception("open: " + path);
    try {
      Exec("CREATE TABLE IF NOT EXISTS configBlobs ( name TEXT UNIQUE PRIMARY KEY NOT NULL, value BLOB)");
      Exec("BEGIN IMMEDIATE");
      // the interfaces foobar2000 has already offered: add Webview2 UI (and Default UI on a fresh list)
      const string KNOWN = "cfg_var.AD13B1D4-A6F7-425E-A93B-2A3C7DC37A93";
      byte[] k = GetBlob(KNOWN);
      var list = new System.Collections.Generic.List<byte[]>();
      if (k != null && k.Length >= 4) {
        int cnt = BitConverter.ToInt32(k, 0);
        if (cnt < 0 || 4 + cnt * 16 != k.Length) throw new Exception("unexpected list of interfaces (" + k.Length + " bytes)");
        for (int i = 0; i < cnt; i++) { byte[] g = new byte[16]; Array.Copy(k, 4 + i * 16, g, 0, 16); list.Add(g); }
      } else list.Add(dui);
      bool has = false; foreach (var g in list) if (Convert.ToBase64String(g) == Convert.ToBase64String(ui)) has = true;
      if (!has) list.Insert(0, ui);
      byte[] outList = new byte[4 + list.Count * 16];
      BitConverter.GetBytes(list.Count).CopyTo(outList, 0);
      for (int i = 0; i < list.Count; i++) list[i].CopyTo(outList, 4 + i * 16);
      SetBlob(KNOWN, outList);
      SetBlob("cfg_var.094A28DA-C6E8-4392-BAF1-AD0F29E5B303", ui);
      Exec("COMMIT");
      return "Webview2 UI is the user interface (" + list.Count + " interfaces known)";
    } catch { try { Exec("ROLLBACK"); } catch { } throw; }
    finally { sqlite3_close(db); }
  }
}
'@
  Write-Output ([GfSql]::Run((Resolve-Path -LiteralPath $Db).Path))
  exit 0
} catch {
  Write-Output "preset-ui failed: $($_.Exception.Message)"
  exit 1
}
