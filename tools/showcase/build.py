"""
Gatefold · showcase/build.py — a real music library for the README screenshots and the demo.
Runs in CI (the Internet Archive is reachable there):  python tools/showcase/build.py out/

1. downloads the Creative-Commons albums of albums.json (audio stays in CI, it is never committed);
2. reads their tags and cover art → out/catalog.json, out/covers/*.jpg, out/waves.json;
3. runs Gatefold's own sound analysis on them (the real models; audio decoded by ffmpeg) in headless
   Chromium, with MusicBrainz reached for real → out/sound.json, out/kv.json, out/http.json;
4. looks up synced lyrics on LRCLIB → out/http.json;
5. out/covers.png: a contact sheet to check the covers.
tools/showcase/shoot.py then takes the screenshots from out/ locally.
"""
import asyncio, base64, hashlib, http.server, io, json, os, re, socketserver, subprocess, sys, threading, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]).resolve(); (OUT / 'covers').mkdir(parents=True, exist_ok=True)
DL = ROOT / '.showcase-dl'; DL.mkdir(exist_ok=True)
UA = {'User-Agent': 'Gatefold-showcase/1.0 (github.com/DEVIROYrus/gatefold-foobar2000)'}
CFG = json.loads((HERE / 'albums.json').read_text(encoding='utf-8'))

def fetch(url, tries=4, timeout=120):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r: return r.status, r.read()
        except urllib.error.HTTPError as e:
            if e.code in (404, 400): return e.code, e.read()
            err = e
        except Exception as e: err = e
        time.sleep(3 + i * 5)
    print('  ! giving up on', url, err); return 0, b''

# ------------------------------------------------------------------ 1–2. albums, tags, covers
from mutagen import File as MFile
from mutagen.flac import FLAC
from mutagen.mp3 import MP3
from PIL import Image

PREF = ['24bit Flac', 'Flac', 'VBR MP3', '320Kbps MP3', '256Kbps MP3', '192Kbps MP3', 'Ogg Vorbis', '128Kbps MP3']
slug = lambda s: re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
safe = lambda s: re.sub(r'[\\/:*?"<>|]+', '', s).strip()

def tag(m, *keys):
    if not m or not m.tags: return ''
    for k in keys:
        v = m.tags.get(k)
        if v is None: continue
        if hasattr(v, 'text'): v = v.text
        if isinstance(v, list): v = v[0] if v else ''
        v = str(v).strip()
        if v: return v
    return ''

def pictures(m):
    out = []
    try:
        if isinstance(m, FLAC): out += [p.data for p in m.pictures]
        if m.tags is not None and hasattr(m.tags, 'getall'): out += [p.data for p in m.tags.getall('APIC')]
        if m.tags is not None and 'metadata_block_picture' in m.tags:
            from mutagen.flac import Picture
            out += [Picture(base64.b64decode(x)).data for x in m.tags['metadata_block_picture']]
    except Exception as e: print('  picture:', e)
    return out

def size_of(b):
    try: im = Image.open(io.BytesIO(b)); return im.size[0] * im.size[1]
    except Exception: return 0

FAKE = os.environ.get('SHOWCASE_FAKE')   # a local smoke test: synthetic audio, fixture covers, no Archive
if FAKE: CFG['albums'] = CFG['albums'][:3]

def fake_album(A):
    adir = DL / A['id']; adir.mkdir(exist_ok=True)
    covers = sorted((ROOT / 'tests' / 'fixtures' / 'covers').glob('*.jpg'))
    fl = []
    for i in range(3):
        name = f'{i + 1:02d}_fake_{i}.flac'; loc = adir / name
        if not loc.exists():
            src = ['-f', 'lavfi', '-i', f'sine=f={110 * (i + 1) + len(A["id"]) * 7}:d=60', '-f', 'lavfi', '-i', 'anoisesrc=d=60:a=0.05', '-filter_complex', 'amix=inputs=2']
            subprocess.run(['ffmpeg', '-v', 'error', '-y'] + src + ['-ar', '44100', str(loc)], check=True)
            m = FLAC(loc); m['title'] = f'Fake {i + 1}'; m['tracknumber'] = str(i + 1)
            from mutagen.flac import Picture
            pic = Picture(); pic.type = 3; pic.mime = 'image/jpeg'; pic.data = covers[(len(A['id']) + i) % len(covers)].read_bytes(); m.add_picture(pic); m.save()
        fl.append({'name': name, 'format': 'Flac', 'title': f'Fake {i + 1}'})
    A = dict(A); return {'metadata': {'licenseurl': 'fake'}}, fl

catalog = {'albums': [], 'tracks': [], 'credits': []}
waves = {}
files = {}   # absolutePath → local file
for A in CFG['albums']:
    ident = A['id']; print('==', ident, flush=True)
    if FAKE: meta, fl = fake_album(A)
    else:
        st, raw = fetch('https://archive.org/metadata/' + urllib.parse.quote(ident))
        meta = json.loads(raw) if st == 200 else {}
        fl = meta.get('files', [])
    groups = {}
    for f in fl:
        if f.get('format') not in PREF: continue
        groups.setdefault(re.sub(r'(_(64|128|192|256|320)kb|_vbr)?\.[^.]+$', '', f['name']), []).append(f)
    names = sorted(groups)
    best = [sorted(groups[n], key=lambda f: PREF.index(f['format']))[0] for n in names]
    if A.get('skip'): best = [f for f in best if not re.search(A['skip'], (f.get('title') or f['name']), re.I)]
    pick = best if FAKE else [best[i - 1] for i in A.get('pick', range(1, len(best) + 1)) if 0 < i <= len(best)]
    adir = DL / ident; adir.mkdir(exist_ok=True)
    pics, tracks = [], []
    for f in pick:
        loc = adir / f['name']
        if not FAKE and (not loc.exists() or loc.stat().st_size < 1000):
            st, b = fetch(f'https://archive.org/download/{urllib.parse.quote(ident)}/{urllib.parse.quote(f["name"])}', timeout=600)
            if st != 200: continue
            loc.write_bytes(b)
        m = MFile(loc)
        info = m.info if m else None
        title = tag(m, 'TIT2', 'title', 'TITLE') or f.get('title') or Path(f['name']).stem
        title = re.sub(r'^\d+\s*[-_.]?\s*_?', '', title) if re.match(r'^\d+\s*[-_. ]', title) and not A.get('keepnum') else title
        title = re.sub(r'^_?' + re.escape(A['artist']) + r'_-_', '', title, flags=re.I).replace('_', ' ').strip()
        tn = tag(m, 'TRCK', 'tracknumber', 'TRACKNUMBER') or str(len(tracks) + 1)
        tn = int(re.match(r'\d+', tn).group()) if re.match(r'\d+', tn) else len(tracks) + 1
        codec = 'FLAC' if isinstance(m, FLAC) else 'MP3' if isinstance(m, MP3) else 'Vorbis'
        prof = ''
        if isinstance(m, MP3): prof = {1: 'CBR', 2: 'VBR', 3: 'ABR'}.get(getattr(info, 'bitrate_mode', 0), '') or ('VBR' if 'VBR' in f['format'] else 'CBR')
        rg = bool(tag(m, 'TXXX:replaygain_track_gain', 'replaygain_track_gain', 'REPLAYGAIN_TRACK_GAIN'))
        dur = float(getattr(info, 'length', 0) or 0)
        ext = Path(f['name']).suffix.lower()
        path = f'D:\\Music\\{safe(A["artist"])}\\{safe(A["album"])}\\{tn:02d} {safe(title)}{ext}'
        bits = getattr(info, 'bits_per_sample', 0) or 0
        br = getattr(info, 'bitrate', 0) or 0
        t = {'title': title, 'artist': tag(m, 'TPE1', 'artist', 'ARTIST') or A['artist'], 'album': A['album'], 'albumArtist': A['artist'],
             'trackNumber': tn, 'duration': round(dur, 2), 'codec': codec, 'profile': prof, 'bitrate': round(br / 1000) if br else 0,
             'sampleRate': getattr(info, 'sample_rate', 44100), 'bitsPerSample': bits, 'channels': getattr(info, 'channels', 2),
             'date': A.get('year') or (tag(m, 'TDRC', 'date', 'DATE') or '')[:4], 'genre': A.get('genre') or tag(m, 'TCON', 'genre', 'GENRE'),
             'rg': rg, 'absolutePath': path}
        if t['artist'].lower().replace(' ', '') in (A['artist'].lower().replace(' ', ''), 'nin'): t['artist'] = A['artist']
        tracks.append(t); files[path] = str(loc); pics += pictures(m)
        # the waveform the seek bar draws: 1600 peaks, 0–100
        pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(loc), '-ac', '1', '-ar', '4000', '-f', 's16le', '-'], capture_output=True).stdout
        import array
        a = array.array('h'); a.frombytes(pcm[: len(pcm) // 2 * 2])
        n = 1600; step = max(1, len(a) // n)
        peaks = [max((abs(x) for x in a[i * step:(i + 1) * step]), default=0) for i in range(n)]
        top = max(peaks) or 1
        waves[path] = [round(100 * p / top) for p in peaks]
        print('  ', tn, title, codec, t['bitrate'], t['sampleRate'], bits, f'{dur:.0f}s', flush=True)
    tracks.sort(key=lambda t: t['trackNumber'])
    # cover: the biggest embedded picture, else the biggest image of the item
    cover = max(pics, key=size_of) if pics else None
    if not FAKE and (not cover or size_of(cover) < 300 * 300):
        for f in fl:
            if f['name'].lower().endswith(('.jpg', '.jpeg', '.png')) and not re.search(r'spectrogram|_thumb|_vbr\.png$|^\d+[_-].*\.png$', f['name']):
                st, b = fetch(f'https://archive.org/download/{urllib.parse.quote(ident)}/{urllib.parse.quote(f["name"])}')
                if st == 200 and size_of(b) > size_of(cover or b''): cover = b
    if not cover: st, cover = fetch(f'https://archive.org/services/img/{urllib.parse.quote(ident)}')
    im = Image.open(io.BytesIO(cover)).convert('RGB'); src = im.size
    im.thumbnail((1200, 1200), Image.LANCZOS)
    cname = f'covers/{slug(A["artist"] + "-" + A["album"])}.jpg'; im.save(OUT / cname, 'JPEG', quality=90)
    md = meta.get('metadata', {})
    genre = A.get('genre') or next((t['genre'] for t in tracks if t['genre']), '')
    catalog['albums'].append({'album': A['album'], 'artist': A['artist'], 'year': tracks[0]['date'] if tracks else '', 'genre': genre, 'cover': cname, 'coverSize': src})
    catalog['credits'].append({'album': A['album'], 'artist': A['artist'], 'license': md.get('licenseurl', ''), 'source': f'https://archive.org/details/{ident}'})
    catalog['tracks'] += tracks
(OUT / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding='utf-8')
(OUT / 'waves.json').write_text(json.dumps(waves), encoding='utf-8')
print(len(catalog['albums']), 'albums,', len(catalog['tracks']), 'tracks', flush=True)

# contact sheet of the covers
W = 240; sheet = Image.new('RGB', (W * 7, W * 2), 'white')
for i, a in enumerate(catalog['albums'][:14]):
    if not (OUT / a['cover']).exists(): continue
    im = Image.open(OUT / a['cover']); im.thumbnail((W, W)); sheet.paste(im, ((i % 7) * W, (i // 7) * W))
sheet.save(OUT / 'covers.png')

# ------------------------------------------------------------------ 4. lyrics (LRCLIB)
http_rec = {}
for t in ([] if FAKE else catalog['tracks']):
    q = urllib.parse.urlencode({'artist_name': t['artist'], 'track_name': t['title'], 'album_name': t['album'], 'duration': round(t['duration'])})
    st, b = fetch('https://lrclib.net/api/get?' + q, tries=2, timeout=30)
    if st == 200:
        j = json.loads(b)
        if j.get('syncedLyrics') or j.get('plainLyrics'): http_rec['lrclib|' + t['artist'].lower() + '|' + t['title'].lower()] = j; print('  lyrics:', t['artist'], '-', t['title'], 'synced' if j.get('syncedLyrics') else 'plain')
    time.sleep(0.3)

# ------------------------------------------------------------------ 3. sound analysis in Gatefold itself
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = urllib.parse.unquote(path.split('?')[0])
        if p.startswith('/showcase/'): return str(OUT / p[len('/showcase/'):])
        return str(ROOT / p.lstrip('/'))
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == '/pcm':
            f = files.get(q['path'][0]); s = float(q.get('start', ['0'])[0]); e = float(q.get('end', ['0'])[0]); sr = q.get('sr', ['16000'])[0]
            cmd = ['ffmpeg', '-v', 'error', '-ss', str(s)] + (['-t', str(max(0.1, e - s))] if e > s else []) + ['-i', f, '-ac', '1', '-ar', sr, '-f', 'f32le', '-']
            b = subprocess.run(cmd, capture_output=True).stdout if f else b''
            self.send_response(200); self.send_header('Content-Type', 'application/octet-stream'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b); return
        if u.path == '/proxy':
            url = q['url'][0]; time.sleep(1.1 if 'musicbrainz' in url else 0.2)
            st, b = fetch(url, tries=3, timeout=40)
            r = {'status': st, 'body': b.decode('utf-8', 'replace')}
            if st == 200: http_rec[url] = r
            out = json.dumps(r).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(out))); self.end_headers(); self.wfile.write(out); return
        return super().do_GET()
    def log_message(self, *a): pass

httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start(); port = httpd.server_address[1]
sys.path.insert(0, str(ROOT / 'tests')); os.environ.setdefault('E2E_IMPORT_ONLY', '1')
import e2e
from playwright.async_api import async_playwright

EXPORT = """(async () => { const S = await import('/theme/js/ml/sound.js'); const IDB = await import('/theme/js/idb.js');
  const enc = (v) => (ArrayBuffer.isView(v) ? { __ta: v.constructor.name, d: Array.from(v) } : v);
  const recs = []; await IDB.eachBatch('sound', 2000, (rows) => { for (const r of rows) { const o = {}; for (const k in r) o[k] = enc(r[k]); recs.push(o); } });
  return { model: S.state.modelId, recs, genres: await IDB.kvGet('mbgenres.v1', null) }; })()"""

async def analyse():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width': 1600, 'height': 940})
        pg = await ctx.new_page(); logs = []
        pg.on('console', lambda m: logs.append(m.text) if 'ml' in m.text.lower() else None)
        pg.on('pageerror', lambda e: print('  pageerror', e))
        show = {'catalog': catalog, 'mode': 'record', 'waves': {}}
        seed = "localStorage.setItem('gatefold.ml.pace', '0'); localStorage.setItem('aurora.settings.v1', JSON.stringify(%s));" % json.dumps({'language': 'en', 'fontMode': 'inter', 'coverSweep': False, 'coverAuto': False, 'artistAuto': False, 'soundAI': True, 'soundSpeed': 'max'})
        await pg.add_init_script(seed + e2e.MOCK + 'window.__SHOW = ' + json.dumps(show) + ';' + (HERE / 'mock-showcase.js').read_text(encoding='utf-8'))
        await pg.goto(f'http://127.0.0.1:{port}/theme/index.html'); await pg.wait_for_timeout(3000)
        await e2e.nav(pg, 'settings', 800)
        t0 = time.time(); last = ''
        while time.time() - t0 < 2400:
            st = await pg.evaluate("document.getElementById('sndStatus')?.innerText || ''")
            if st != last: print('  ', round(time.time() - t0), st.replace('\n', ' ')[:140], flush=True); last = st
            if 'Done' in st: break
            await pg.wait_for_timeout(5000)
        # genres: MusicBrainz for every artist (1 request a second)
        for _ in range(120):
            g = await pg.evaluate("import('/theme/js/ml/genres.js').then(G => ({ ...G.state }))")
            if g.get('artists') and not g.get('running') and g.get('done', 0) >= g.get('artists', 0): break
            await pg.wait_for_timeout(2000)
        print('  genres', g, flush=True)
        await pg.wait_for_timeout(4000)
        data = await pg.evaluate(EXPORT)
        print('  model', data['model'], 'records', len(data['recs']), 'bad', sum(1 for r in data['recs'] if r.get('bad')), flush=True)
        # how the recipes split the library, for the log
        moods = await pg.evaluate("import('/theme/js/ml/sound-ui.js').then(U => Object.fromEntries(['calm','energy','sad','happy','party','instrumental','acoustic'].map(k => [k, U.matching(k).n])))")
        print('  moods', moods, flush=True)
        for k in ['instrumental', 'calm', 'energy', 'party', 'sad', 'acoustic', 'happy']:
            top = await pg.evaluate(f"import('/theme/js/ml/sound-ui.js').then(U => U.matching('{k}').top.map(t => t.artist + ' — ' + t.title))")
            print('   ', k, top, flush=True)
        (OUT / 'sound.json').write_text(json.dumps({'model': data['model'], 'recs': data['recs']}), encoding='utf-8')
        (OUT / 'kv.json').write_text(json.dumps({'mbgenres.v1': data['genres']}), encoding='utf-8')
        (OUT / 'ml-console.txt').write_text('\n'.join(logs[-400:]), encoding='utf-8')
        await b.close()

asyncio.run(analyse())
(OUT / 'http.json').write_text(json.dumps(http_rec, ensure_ascii=False), encoding='utf-8')
httpd.shutdown()
print('done', flush=True)
