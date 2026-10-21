"""
The README's demo: Gatefold in the mocked emulator (placeholder artwork only), recorded by headless
Chromium. python tools/demo_video.py → docs/screenshots/demo.webp (animated) and demo.mp4
"""
import asyncio, os, sys, glob, subprocess, shutil, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tests')); os.environ.setdefault('E2E_IMPORT_ONLY', '1')
import e2e
from playwright.async_api import async_playwright

W, H = 1280, 760
CAPTION = """(() => { const c = document.createElement('div'); c.id = 'demoCap';
  c.style.cssText = 'position:fixed;left:50%;top:4px;transform:translateX(-50%);z-index:99999;padding:9px 18px;border-radius:999px;font:600 16px Inter,system-ui,sans-serif;letter-spacing:-.01em;color:#fff;background:rgb(10 10 14/.86);backdrop-filter:blur(10px);opacity:0;transition:opacity .35s;pointer-events:none';
  document.body.append(c); window.__cap = (t) => { c.style.opacity = 0; setTimeout(() => { c.textContent = t; c.style.opacity = t ? 1 : 0; }, t ? 380 : 0); }; })()"""

VARY = """(async () => { const S = await import('/theme/js/ml/sound.js');
  //            aggr relax sad happy party dance instr acoust electr
  const P = [[ 20, 210, 120, 110,  40,  60,  60, 140,  90], [205,  30,  40, 120, 180, 190,  40,  30, 200],
             [ 30, 160, 215,  40,  30,  50,  60, 150,  60], [ 40,  90,  40, 215, 120, 130,  50, 120,  90],
             [ 80,  40,  40, 175, 225, 225,  40,  20, 210], [ 30, 185,  80,  80,  40,  60, 252,  90, 180],
             [ 20, 185,  90, 140,  30,  70,  80, 235,  20]];
  const h = (s) => { let x = 2166136261; for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return x >>> 0; };
  for (const r of S.all()) { const k = h((r.aa || r.ar || '') + '|' + (r.ti || '') + '|' + (r.p || '')), p = P[k % P.length];
    r.m = Uint8Array.from(p, (v, i) => Math.max(0, Math.min(255, v + ((k >>> (i + 3)) % 31) - 15)));
    r.mq = Uint8Array.from(r.m, (v) => Math.min(255, v + 4)); } })()"""

async def main():
    tmp = Path(tempfile.mkdtemp())
    httpd = e2e.serve(); port = httpd.server_address[1]
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': W, 'height': H}, record_video_dir=str(tmp), record_video_size={'width': W, 'height': H})
        # sound analysis with the stand-in models of the tests (tools/ml/fake_assets.py)
        if not (e2e.ML_FAKE / 'models' / 'manifest.json').exists():
            subprocess.run([sys.executable, str(ROOT / 'tools' / 'ml' / 'fake_assets.py'), str(e2e.ML_FAKE)], check=True)
        async def raw(route):
            f = e2e.ML_FAKE / 'models' / route.request.url.split('/models/')[-1]
            await route.fulfill(status=200 if f.exists() else 404, body=f.read_bytes() if f.exists() else b'', headers={'Access-Control-Allow-Origin': '*'})
        await ctx.route('https://raw.githubusercontent.com/**', raw)
        pg = await ctx.new_page()
        seed = "localStorage.setItem('gatefold.ml.pace', '0'); Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 }); if (!localStorage.getItem('aurora.settings.v1')) localStorage.setItem('aurora.settings.v1', JSON.stringify({language: 'en', fontMode: 'inter', coverSweep: false, coverAuto: false, artistAuto: false, canvasIdleMin: 0, soundAI: true}));"
        await pg.add_init_script(seed + e2e.MOCK)
        await pg.goto(f'http://127.0.0.1:{port}/theme/index.html'); await pg.wait_for_timeout(2500)
        # warm-up, off the record: the library analysed, covers decoded, cover colours measured, views built once
        await e2e.nav(pg, 'settings', 800)
        for _ in range(120):
            if 'Done' in await pg.evaluate("document.getElementById('sndStatus')?.innerText || ''"): break
            await pg.wait_for_timeout(1000)
        await e2e.nav(pg, 'playlist', 400); await pg.evaluate("document.querySelector('#plModes [data-m=covers]').click()"); await pg.wait_for_timeout(1500)
        await e2e.nav(pg, 'library', 1500)
        for i in (1, 4, 2, 0): await pg.evaluate(f'window.__setAlbum({i})'); await pg.wait_for_timeout(700)
        # the stand-in models hear the synthetic fixture tracks almost alike; give them distinct moods so that
        # each recipe picks its own tracks, as it does with the real models on a real library
        await pg.evaluate(VARY)
        await e2e.nav(pg, 'now', 1500)
        for _ in range(30):
            if await pg.evaluate("document.querySelectorAll('#npBadges .chip.ai').length"): break
            await pg.wait_for_timeout(1000)
        await pg.evaluate(CAPTION)
        t0 = await pg.evaluate('performance.now()')
        cap = lambda t: pg.evaluate(f'window.__cap({t!r})')
        card = lambda i: pg.evaluate(f"(c => {{ c?.scrollIntoView({{block: 'nearest'}}); c?.click(); }})(document.querySelector('.sp-card[data-id={i}]'))")
        await cap('Gatefold — foobar2000 that understands your music'); await pg.wait_for_timeout(2800)
        await cap('It listens to your library — on your PC, nothing uploaded'); await pg.wait_for_timeout(600)
        await pg.wait_for_timeout(2600)
        await cap('Radio and Similar tracks that go by the sound'); await pg.mouse.move(10, 400)
        await pg.hover("#npActions .btn:has-text('Similar')"); await pg.wait_for_timeout(2600)
        await cap('Mood playlists from your own files — no server, no subscription'); await pg.mouse.move(10, 400)
        # the stand-in models give the fixture library only some moods: show those that match tracks
        moods = await pg.evaluate("import('/theme/js/ml/sound-ui.js').then(U => ['instrumental', 'energy', 'sad', 'party', 'acoustic', 'happy'].filter(k => U.matching(k).n >= 4))")
        print('moods with tracks:', moods)
        await pg.evaluate("import('/theme/js/smartpl.js').then(m => m.open('ai-calm'))"); await pg.wait_for_timeout(1700)
        for i in moods[:3]: await card('ai-' + i); await pg.wait_for_timeout(1400)
        await cap('Smart playlists without the query language')
        for i in ('decade', 'lossless', 'hires'): await card(i); await pg.wait_for_timeout(1600)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(500)
        await cap('foobar2000 underneath: every format, gapless, DSP, your components'); await e2e.nav(pg, 'playlist', 400)
        await pg.evaluate("document.querySelector('#plModes [data-m=covers]').click()"); await pg.wait_for_timeout(2600)
        await cap('And it looks the part'); await e2e.nav(pg, 'now', 400)
        for i in (1, 4): await pg.evaluate(f'window.__setAlbum({i})'); await pg.wait_for_timeout(1900)
        await pg.evaluate("document.querySelector('#btnFull').click()"); await pg.wait_for_timeout(2600)
        await cap(''); await pg.wait_for_timeout(400)
        t1 = await pg.evaluate('performance.now()')
        await ctx.close(); await b.close()
    httpd.shutdown()
    src = glob.glob(str(tmp / '*.webm'))[0]
    # the recording starts with the page load: keep from the first caption on
    total = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).decode().strip() or 0)
    start = max(0.0, total - (t1 - t0) / 1000)
    out = ROOT / 'docs' / 'screenshots'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.2f}', '-i', src, '-vf', 'fps=15,scale=960:-2:flags=lanczos', '-c:v', 'libwebp_anim', '-quality', '72', '-compression_level', '6', '-loop', '0', str(out / 'demo.webp')], check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.2f}', '-i', src, '-vf', 'fps=30,scale=1280:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', '-an', str(out / 'demo.mp4')], check=True)
    shutil.rmtree(tmp)
    for f in ('demo.webp', 'demo.mp4'): print(f, (out / f).stat().st_size // 1024, 'KB')
asyncio.run(main())
