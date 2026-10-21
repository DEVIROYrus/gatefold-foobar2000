"""
installer/assets/fresh-config.sqlite — foobar2000's configuration for a profile that has none yet,
so that its first start opens straight in Gatefold instead of asking which interface to use.

Found by tools/fb2k-probe.ps1 on foobar2000 2.26 (the probe-log branch): the configuration lives in
<profile>\\config.sqlite; the dialog «New user interface module(s) found» appears while the list of
known interfaces is missing, and the chosen interface is a GUID in its own variable:
  cfg_var.094A28DA-C6E8-4392-BAF1-AD0F29E5B303  the user interface: Webview2 UI {3BF13CCC-…}
  cfg_var.AD13B1D4-A6F7-425E-A93B-2A3C7DC37A93  interfaces already offered: count + GUIDs
                                                 (Webview2 UI and Default User Interface)
Everything else foobar2000 fills in itself on the first start. The installer copies this file only
when the profile has no config.sqlite (never over an existing configuration).

  python tools/make_fresh_config.py
"""
import sqlite3, struct, uuid
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'installer' / 'assets' / 'fresh-config.sqlite'
WEBVIEW2_UI = uuid.UUID('3BF13CCC-477E-459A-A093-990D801AD37E')
DEFAULT_UI = uuid.UUID('6EBCE8DE-A55C-4E09-9EFE-A8B6A66D69FD')

OUT.unlink(missing_ok=True)
db = sqlite3.connect(OUT)
for t, ty in (('config', 'INTEGER'), ('configStrings', 'TEXT'), ('configInts', 'INTEGER'), ('configBlobs', 'BLOB'), ('configReals', 'REAL')):
    db.execute(f'CREATE TABLE {t} ( name TEXT UNIQUE PRIMARY KEY NOT NULL, value {ty})')
db.executemany('INSERT INTO config VALUES (?, ?)', [('version', 1), ('version2', 2)])
db.execute('INSERT INTO configInts VALUES (?, ?)', ('core.configVersion', 2000))
db.executemany('INSERT INTO configBlobs VALUES (?, ?)', [
    ('cfg_var.094A28DA-C6E8-4392-BAF1-AD0F29E5B303', WEBVIEW2_UI.bytes_le),
    ('cfg_var.AD13B1D4-A6F7-425E-A93B-2A3C7DC37A93', struct.pack('<I', 2) + WEBVIEW2_UI.bytes_le + DEFAULT_UI.bytes_le),
])
db.commit(); db.execute('VACUUM'); db.close()
print(OUT, OUT.stat().st_size)
