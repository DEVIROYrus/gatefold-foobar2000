"""
Gatefold · showcase/shoot.py — README screenshots, the demo video and the social preview, made from the
real Creative-Commons library that build.py prepared (git fetch origin showcase-build; the data dir):

    python tools/showcase/shoot.py <data dir> [screens] [demo] [preview]

The page is Gatefold itself with tools/showcase/mock-showcase.js in place of foobar2000. The sound
analysis is the real one, made in CI on the real audio (sound.json), loaded into the page's database.
"""
import asyncio, base64, glob, http.server, json, os, shutil, socketserver, subprocess, sys, tempfile, threading, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
HERE = Path(__file__).resolve().parent
DATA = Path(sys.argv[1]).resolve()
WHAT = set(sys.argv[2:]) or {'screens', 'demo', 'preview'}
SHOTS = ROOT / 'docs' / 'screenshots'
sys.path.insert(0, str(ROOT / 'tests')); os.environ.setdefault('E2E_IMPORT_ONLY', '1')
import e2e
from playwright.async_api import async_playwright
from PIL import Image

catalog = json.loads((DATA / 'catalog.json').read_text(encoding='utf-8'))
waves = json.loads((DATA / 'waves.json').read_text(encoding='utf-8'))
httprec = json.loads((DATA / 'http.json').read_text(encoding='utf-8')) if (DATA / 'http.json').exists() else {}
sound = json.loads((DATA / 'sound.json').read_text(encoding='utf-8'))
kv = json.loads((DATA / 'kv.json').read_text(encoding='utf-8'))
PLAN = json.loads((HERE / 'shots.json').read_text(encoding='utf-8'))

class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = urllib.parse.unquote(path.split('?')[0])
        if p.startswith('/showcase/'): return str(DATA / p[len('/showcase/'):])
        return str(ROOT / p.lstrip('/'))
    def log_message(self, *a): pass

SEED_IDB = """async (data) => { const IDB = await import('/theme/js/idb.js');
  const dec = (v) => (v && v.__ta ? new globalThis[v.__ta](v.d) : v);
  await IDB.putMany('sound', data.recs.map((r) => { const o = {}; for (const k in r) o[k] = dec(r[k]); return o; }));
  for (const [k, v] of Object.entries(data.kv)) if (v) await IDB.kvSet(k, v);
  return data.recs.length; }"""

def show(extra=None):
    s = {'catalog': catalog, 'http': httprec, 'waves': waves, 'mode': 'replay', **PLAN.get('show', {}), **(extra or {})}
    return 'window.__SHOW = ' + json.dumps(s) + ';'

async def page(b, port, settings, w=1600, h=940, video=None, extra=None):
    kw = {'record_video_dir': video, 'record_video_size': {'width': w, 'height': h}} if video else {}
    ctx = await b.new_context(viewport={'width': w, 'height': h}, **kw)
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    st = {'language': 'en', 'fontMode': 'inter', 'coverSweep': False, 'coverAuto': False, 'artistAuto': False, 'canvasIdleMin': 0, 'soundAI': False, **settings}
    await pg.add_init_script("localStorage.setItem('gatefold.ml.pace', '0'); if (!localStorage.getItem('aurora.settings.v1')) localStorage.setItem('aurora.settings.v1', %s);" % json.dumps(json.dumps(st))
                             + e2e.MOCK + show(extra) + (HERE / 'mock-showcase.js').read_text(encoding='utf-8'))
    await pg.goto(f'http://127.0.0.1:{port}/theme/index.html'); await pg.wait_for_timeout(1500)
    n = await pg.evaluate(SEED_IDB, {'recs': sound['recs'], 'kv': kv})
    # sound analysis on, now that its results are in the database: a reload starts with them
    await pg.evaluate("(() => { const s = JSON.parse(localStorage.getItem('aurora.settings.v1')); s.soundAI = %s; localStorage.setItem('aurora.settings.v1', JSON.stringify(s)); })()" % ('true' if settings.get('soundAI', True) else 'false'))
    await pg.reload(); await pg.wait_for_timeout(2500)
    for _ in range(60):
        if await pg.evaluate("import('/theme/js/ml/sound.js').then(S => S.ready() && S.all().length)"): break
        await pg.wait_for_timeout(1000)
    return ctx, pg, errs

def webp(png, name):
    im = Image.open(png).convert('RGB'); im = im.resize((1280, round(im.height * 1280 / im.width)), Image.LANCZOS)
    im.save(SHOTS / (name + '.webp'), 'WEBP', quality=88, method=6); Path(png).unlink()

async def run_steps(pg, steps):
    for s in steps:
        if 'cap' in s: await pg.evaluate(f"window.__cap({s['cap']!r})"); await pg.wait_for_timeout(s.get('hold', 0))
        if 'nav' in s: await e2e.nav(pg, s['nav'], s.get('wait', 1500))
        if 'js' in s: await pg.evaluate(s['js']); await pg.wait_for_timeout(s.get('wait', 1200))
        if 'click' in s: await pg.click(s['click']); await pg.wait_for_timeout(s.get('wait', 900))
        if 'hover' in s: await pg.hover(s['hover']); await pg.wait_for_timeout(s.get('wait', 900))
        if 'key' in s: await pg.keyboard.press(s['key']); await pg.wait_for_timeout(s.get('wait', 500))
        if 'until' in s:
            for _ in range(s.get('tries', 30)):
                if await pg.evaluate(s['until']): break
                await pg.wait_for_timeout(1000)
        if 'sleep' in s: await pg.wait_for_timeout(s['sleep'])

async def screens(b, port):
    for shot in PLAN['screens']:
        ctx, pg, errs = await page(b, port, shot.get('settings', {}))
        await run_steps(pg, shot['steps'])
        png = str(SHOTS / (shot['name'] + '.png')); await pg.screenshot(path=png); webp(png, shot['name'])
        print(shot['name'], errs[:2], flush=True)
        await ctx.close()

CAPTION = """(() => { const c = document.createElement('div'); c.id = 'demoCap';
  c.style.cssText = 'position:fixed;left:50%;top:4px;transform:translateX(-50%);z-index:99999;padding:9px 18px;border-radius:999px;font:600 16px Inter,system-ui,sans-serif;letter-spacing:-.01em;color:#fff;background:rgb(10 10 14/.86);backdrop-filter:blur(10px);opacity:0;transition:opacity .35s;pointer-events:none;white-space:nowrap';
  document.body.append(c); window.__cap = (t) => { c.style.opacity = 0; setTimeout(() => { c.textContent = t; c.style.opacity = t ? 1 : 0; }, t ? 380 : 0); }; })()"""

async def demo(b, port):
    D = PLAN['demo']; W, Hh = D.get('size', [1280, 760])
    tmp = Path(tempfile.mkdtemp())
    ctx, pg, errs = await page(b, port, D.get('settings', {}), W, Hh, video=str(tmp))
    await run_steps(pg, D.get('warmup', []))
    await pg.evaluate(CAPTION)
    t0 = await pg.evaluate('performance.now()')
    await run_steps(pg, D['steps'])
    t1 = await pg.evaluate('performance.now()')
    await ctx.close()
    src = glob.glob(str(tmp / '*.webm'))[0]
    total = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).decode().strip() or 0)
    start = max(0.0, total - (t1 - t0) / 1000)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.2f}', '-i', src, '-vf', 'fps=12,scale=960:-2:flags=lanczos', '-c:v', 'libwebp_anim', '-quality', '62', '-compression_level', '6', '-loop', '0', str(SHOTS / 'demo.webp')], check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.2f}', '-i', src, '-vf', 'fps=30,scale=1280:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', '-an', str(SHOTS / 'demo.mp4')], check=True)
    shutil.rmtree(tmp)
    print('demo', errs[:2], [(f, (SHOTS / f).stat().st_size // 1024) for f in ('demo.webp', 'demo.mp4')], flush=True)

async def main():
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start(); port = httpd.server_address[1]
    async with async_playwright() as p:
        b = await p.chromium.launch()
        if 'screens' in WHAT: await screens(b, port)
        if 'demo' in WHAT: await demo(b, port)
        await b.close()
    httpd.shutdown()
    if 'preview' in WHAT: subprocess.run([sys.executable, str(ROOT / 'tools' / 'social_preview.py')], check=True)

asyncio.run(main())
