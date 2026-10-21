"""README screenshots from the mocked emulator (original placeholder artwork only — no real album covers).
python tools/screenshots.py  → docs/screenshots/*.png (then converted to .webp)"""
import asyncio, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tests'))
os.environ.setdefault('E2E_IMPORT_ONLY', '1')
import importlib.util
spec = importlib.util.spec_from_file_location('e2e', Path(__file__).resolve().parent.parent / 'tests' / 'e2e.py')
from playwright.async_api import async_playwright

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'screenshots'
OUT.mkdir(parents=True, exist_ok=True)

async def main():
    e2e = importlib.util.module_from_spec(spec); spec.loader.exec_module(e2e)
    httpd = e2e.serve(); port = httpd.server_address[1]
    async with async_playwright() as p:
        kw = {'executable_path': os.environ['CHROMIUM']} if os.environ.get('CHROMIUM') else {}
        b = await p.chromium.launch(**kw)
        only = os.environ.get('ONLY_SOUND')
        shots = [] if only else [
            ('now', {'language': 'en'}, None, 'now-en'),
            ('playlist', {'language': 'en'}, "document.querySelector('#plModes [data-m=covers]').click()", 'playlist-en'),
            ('library', {'language': 'en'}, None, 'library-en'),
            ('library', {'language': 'en'}, "(async () => { const s = document.querySelector('#libSort'); s.value = 'color'; s.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 4500)); })()", 'colors-en'),
            ('playlist', {'language': 'en'}, "import('/theme/js/smartpl.js').then(m => m.open('lossless'))", 'smart-en'),
            ('settings', {'language': 'en', 'colorSource': 'album'}, None, 'settings-en'),
            ('now', {'language': 'en', 'colorSource': 'light'}, None, 'now-light-en'),
            ('now', {'language': 'ru'}, None, 'now-ru'),
        ]
        for i, (view, st, js, name) in enumerate(shots):
            ctx, pg, errs = await e2e.page(b, port, st)
            await e2e.nav(pg, view, 1600)
            if js: await pg.evaluate(js); await pg.wait_for_timeout(1600)
            name += '.png'
            await pg.screenshot(path=str(OUT / name))
            from PIL import Image
            im = Image.open(OUT / name).convert('RGB'); im = im.resize((1280, round(im.height * 1280 / im.width)), Image.LANCZOS)
            im.save(OUT / name.replace('.png', '.webp'), 'WEBP', quality=86, method=6); (OUT / name).unlink()
            print(name, errs)
            await ctx.close()
        # sound analysis with the stand-in models of the tests (tools/ml/fake_assets.py)
        if not (e2e.ML_FAKE / 'models' / 'manifest.json').exists():
            import subprocess; subprocess.run([sys.executable, str(e2e.ROOT / 'tools' / 'ml' / 'fake_assets.py'), str(e2e.ML_FAKE)], check=True)
        async def setup(ctx):
            async def raw(route):
                f = e2e.ML_FAKE / 'models' / route.request.url.split('/models/')[-1]
                await route.fulfill(status=200 if f.exists() else 404, body=f.read_bytes() if f.exists() else b'', headers={'Access-Control-Allow-Origin': '*'})
            await ctx.route('https://raw.githubusercontent.com/**', raw)
        ctx, pg, errs = await e2e.page(b, port, {'language': 'en', 'soundAI': True}, setup=setup, pre="localStorage.setItem('gatefold.ml.pace', '0'); Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })")
        await e2e.nav(pg, 'settings', 800)
        for _ in range(90):
            if 'Done' in await pg.evaluate("document.getElementById('sndStatus')?.innerText || ''"): break
            await pg.wait_for_timeout(1000)
        sound = [
            ('playlist', "import('/theme/js/smartpl.js').then(m => m.open('ai-calm')).then(() => new Promise(r => setTimeout(r, 600))).then(() => { const l = document.querySelector('.sp-list'); l.scrollTop = l.scrollHeight; })", 'sound-smart-en'),
            ('now', None, 'sound-now-en'),
        ]
        for view, js, name in sound:
            await e2e.nav(pg, view, 2500)
            if js: await pg.evaluate(js); await pg.wait_for_timeout(1800)
            else:
                for _ in range(30):
                    if await pg.evaluate("document.querySelectorAll('#npBadges .chip.ai').length"): break
                    await pg.wait_for_timeout(1000)
            await pg.screenshot(path=str(OUT / (name + '.png')))
            from PIL import Image
            im = Image.open(OUT / (name + '.png')).convert('RGB'); im = im.resize((1280, round(im.height * 1280 / im.width)), Image.LANCZOS)
            im.save(OUT / (name + '.webp'), 'WEBP', quality=86, method=6); (OUT / (name + '.png')).unlink()
            print(name, errs)
            if js: await pg.keyboard.press('Escape'); await pg.wait_for_timeout(400)
        await ctx.close()
        await b.close()
    httpd.shutdown()
asyncio.run(main())
