"""
Gatefold · fb2k-probe-scan.py — finds where foobar2000 keeps the chosen user interface.
Looks for the GUID of Webview2 UI (binary, little-endian as Windows stores a GUID, and as text)
in every file of the profile, and lists the tables and matching rows of SQLite files.
"""
import os, sys, sqlite3, uuid

prof = sys.argv[1]
G = uuid.UUID('3BF13CCC-477E-459A-A093-990D801AD37E')
NEEDLES = {'guid-le': G.bytes_le, 'guid-be': G.bytes, 'text': b'3bf13ccc', 'TEXT': b'3BF13CCC',
           'utf16': '3BF13CCC'.encode('utf-16-le'), 'utf16l': '3bf13ccc'.encode('utf-16-le')}

def hexdump(b):
    return ' '.join(f'{x:02x}' for x in b)

for root, dirs, files in os.walk(prof):
    dirs[:] = [d for d in dirs if d not in ('webview-ui', 'user-components-x64', 'EBWebView')]
    for f in files:
        p = os.path.join(root, f)
        try:
            data = open(p, 'rb').read()
        except OSError as e:
            print('cannot read', p, e); continue
        for name, n in NEEDLES.items():
            i = data.find(n)
            while i >= 0:
                print(f'{os.path.relpath(p, prof)} @ {i}: {name}\n   before: {hexdump(data[max(0, i - 64):i])}\n   after:  {hexdump(data[i + len(n):i + len(n) + 32])}')
                i = data.find(n, i + 1)
        if data[:16] == b'SQLite format 3\x00':
            try:
                con = sqlite3.connect(f'file:{p}?mode=ro', uri=True)
                print(f'\n--- {os.path.relpath(p, prof)} (SQLite)')
                for name, sql in con.execute("select name, sql from sqlite_master"):
                    print(' ', sql)
                    if not sql or not sql.upper().startswith('CREATE TABLE'): continue
                    cnt = con.execute(f'select count(*) from "{name}"').fetchone()[0]
                    print(f'    {cnt} rows')
                    for row in con.execute(f'select * from "{name}"'):
                        blob = b''.join(v if isinstance(v, bytes) else str(v).encode('utf-8', 'replace') for v in row)
                        if any(n in blob for n in NEEDLES.values()):
                            print('    MATCH:', [hexdump(v) if isinstance(v, bytes) else v for v in row])
                    # a sample, to see how keys look
                    for row in con.execute(f'select * from "{name}" limit 8'):
                        print('    sample:', [hexdump(v[:48]) if isinstance(v, bytes) else (str(v)[:80]) for v in row])
                con.close()
            except Exception as e:
                print('sqlite error', p, e)
