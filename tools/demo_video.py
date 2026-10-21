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

async def main():
    tmp = Path(tempfile.mkdtemp())
    httpd = e2e.serve(); port = httpd.server_address[1]
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': W, 'height': H}, record_video_dir=str(tmp), record_video_size={'width': W, 'height': H})
        pg = await ctx.new_page()
        seed = "localStorage.setItem('aurora.settings.v1', JSON.stringify({language: 'en', fontMode: 'inter', coverSweep: false, coverAuto: false, artistAuto: false, canvasIdleMin: 0}));"
        await pg.add_init_script(seed + e2e.MOCK)
        await pg.goto(f'http://127.0.0.1:{port}/theme/index.html'); await pg.wait_for_timeout(2500)
        # warm-up, off the record: covers decoded, cover colours measured, views built once
        await e2e.nav(pg, 'playlist', 400); await pg.evaluate("document.querySelector('#plModes [data-m=covers]').click()"); await pg.wait_for_timeout(1500)
        await e2e.nav(pg, 'library', 1500)
        await pg.evaluate("(() => { const s = document.querySelector('#libSort'); s.value = 'color'; s.dispatchEvent(new Event('change')); })()"); await pg.wait_for_timeout(5000)
        await pg.evaluate("(() => { const s = document.querySelector('#libSort'); s.value = 'artist'; s.dispatchEvent(new Event('change')); })()"); await pg.wait_for_timeout(1500)
        for i in (1, 4, 2, 0): await pg.evaluate(f'window.__setAlbum({i})'); await pg.wait_for_timeout(700)
        await e2e.nav(pg, 'now', 1500)
        await pg.evaluate(CAPTION)
        t0 = await pg.evaluate('performance.now()')
        cap = lambda t: pg.evaluate(f'window.__cap({t!r})')
        await cap('Gatefold — foobar2000 in the colours of your music'); await pg.wait_for_timeout(2600)
        await cap('Every album repaints the interface')
        for i in (1, 4, 2):
            await pg.evaluate(f'window.__setAlbum({i})'); await pg.wait_for_timeout(2100)
        await cap('Playlists with covers'); await e2e.nav(pg, 'playlist', 400)
        await pg.evaluate("document.querySelector('#plModes [data-m=covers]').click()"); await pg.wait_for_timeout(2400)
        await cap('Your library by cover colour'); await e2e.nav(pg, 'library', 400)
        await pg.evaluate("(() => { const s = document.querySelector('#libSort'); s.value = 'color'; s.dispatchEvent(new Event('change')); })()"); await pg.wait_for_timeout(2600)
        await pg.evaluate("document.querySelector('.cr-b[data-c=blue]')?.click()"); await pg.wait_for_timeout(2200)
        await pg.evaluate("document.querySelector('.cr-b[data-c=blue]')?.click()"); await pg.wait_for_timeout(600)
        await cap('Smart playlists in two clicks')
        await pg.evaluate("import('/theme/js/smartpl.js').then(m => m.open('lossless'))"); await pg.wait_for_timeout(1500)
        await pg.evaluate("document.querySelector('.sp-card[data-id=long]')?.click()"); await pg.wait_for_timeout(1300)
        await pg.evaluate("document.querySelector('.sp-card[data-id=decade]')?.click()"); await pg.wait_for_timeout(1500)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(500)
        await cap('Canvas — full screen, even on a second monitor'); await e2e.nav(pg, 'now', 500)
        await pg.evaluate("document.querySelector('#btnFull').click()"); await pg.wait_for_timeout(3400)
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
