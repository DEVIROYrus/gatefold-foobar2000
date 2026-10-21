"""
Gatefold · showcase/scout.py — finds Creative-Commons albums on the Internet Archive for the README
screenshots and demo (real music instead of placeholders). Runs in CI (the Archive is reachable there):
    python tools/showcase/scout.py out/
writes out/scout.json (one entry per album: licence, files, cover candidates) and out/thumbs/<id>.jpg.
"""
import json, sys, time, urllib.parse, urllib.request
from pathlib import Path

OUT = Path(sys.argv[1]); (OUT / 'thumbs').mkdir(parents=True, exist_ok=True)
UA = {'User-Agent': 'Gatefold-showcase/1.0 (github.com/DEVIROYrus/gatefold-foobar2000)'}

def get(url, binary=False, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                b = r.read(); return b if binary else json.loads(b)
        except Exception as e:
            if i == tries - 1: print('  !', url, e); return None
            time.sleep(2 + i * 3)

def search(q, rows=120, sort='downloads desc'):
    u = 'https://archive.org/advancedsearch.php?' + urllib.parse.urlencode(
        [('q', q), ('rows', rows), ('output', 'json'), ('sort[]', sort)] + [('fl[]', f) for f in ('identifier', 'title', 'creator', 'date', 'licenseurl', 'downloads', 'subject', 'collection')])
    r = get(u); return (r or {}).get('response', {}).get('docs', [])

ARTISTS = ['Nine Inch Nails', 'Josh Woodward', 'Kevin MacLeod', 'Broke For Free', 'Jonathan Coulton', 'Brad Sucks', 'Chris Zabriskie',
           'Kai Engel', 'Monplaisir', 'Lee Rosevere', 'Podington Bear', 'Blue Dot Sessions', 'Silence Is Sexy', 'Revolution Void', 'Jahzzar',
           'Komiku', 'Ketsa', 'Scott Holmes', 'Rolemusic', 'The Freak Fandango Orchestra', 'Lobo Loco', 'Cullah', 'Steve Combs', 'Tours',
           'Dee Yan-Key', 'Jason Shaw', 'Sergey Cheremisinov', 'Mid-Air Machine', 'BoxCat Games', 'Loyalty Freak Music', 'Ryan Andersen',
           'Pierlo', 'Krackatoa', 'Ars Sonor', 'Unheard Music Concepts', 'Kosta T', 'Glass Boy', 'Crowander', 'Daniel Birch', 'Nctrnm']
NIN = ['nineinchnails_ghosts_I_IV', 'nine_inch_nails_the_slip', 'nine-inch-nails-the-slip_may2008', 'NineInchNails-TheSlip', 'nine-inch-nails-ghosts-i-iv-2008-web']

docs = {}
for d in search('collection:(netlabels) AND mediatype:(audio) AND licenseurl:(*creativecommons*)', rows=300): docs[d['identifier']] = d
for a in ARTISTS:
    for d in search(f'creator:("{a}") AND mediatype:(audio) AND licenseurl:(*)', rows=25): docs.setdefault(d['identifier'], d)
    time.sleep(0.5)
for i in NIN: docs.setdefault(i, {'identifier': i})
print(len(docs), 'candidates')

AUDIO = ('Flac', 'VBR MP3', '320Kbps MP3', '256Kbps MP3', '192Kbps MP3', '128Kbps MP3', 'Ogg Vorbis', 'MP3', '24bit Flac')
out = []
for n, (ident, d) in enumerate(docs.items()):
    m = get('https://archive.org/metadata/' + urllib.parse.quote(ident))
    if not m or 'files' not in m: continue
    md = m.get('metadata', {})
    files = m['files']
    audio = [f for f in files if f.get('format') in AUDIO and f.get('source') == 'original']
    if not audio: audio = [f for f in files if f.get('format') in AUDIO]
    imgs = [f['name'] for f in files if f.get('format') in ('JPEG', 'PNG', 'Item Image', 'JPEG Thumb') or f['name'].lower().endswith(('.jpg', '.jpeg', '.png'))]
    e = {'id': ident, 'title': md.get('title'), 'creator': md.get('creator'), 'date': md.get('date') or md.get('year'), 'license': md.get('licenseurl'),
         'downloads': d.get('downloads'), 'subject': md.get('subject'), 'collection': md.get('collection'),
         'tracks': len({f['name'].rsplit('.', 1)[0] for f in audio}), 'formats': sorted({f.get('format') for f in audio}),
         'audio': [{k: f.get(k) for k in ('name', 'format', 'title', 'creator', 'album', 'track', 'length', 'size', 'bitrate', 'genre', 'source')} for f in audio[:60]],
         'images': imgs[:30]}
    out.append(e)
    t = get(f'https://archive.org/services/img/{urllib.parse.quote(ident)}', binary=True)
    if t: (OUT / 'thumbs' / (ident.replace('/', '_') + '.jpg')).write_bytes(t)
    if n % 25 == 0: print(n, ident)
(OUT / 'scout.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
print('albums', len(out))
