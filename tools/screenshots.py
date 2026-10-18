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
        shots = [
            ('now', {'language': 'en'}, None),
            ('playlist', {'language': 'en'}, "document.querySelector('#plModes [data-m=covers]').click()"),
            ('library', {'language': 'en'}, None),
            ('settings', {'language': 'en', 'colorSource': 'album'}, None),
            ('now', {'language': 'en', 'colorSource': 'light'}, None),
            ('now', {'language': 'ru'}, None),
        ]
        for i, (view, st, js) in enumerate(shots):
            ctx, pg, errs = await e2e.page(b, port, st)
            await e2e.nav(pg, view, 1600)
            if js: await pg.evaluate(js); await pg.wait_for_timeout(1400)
            name = f"{view}{'-' + st.get('colorSource') if st.get('colorSource') not in (None, 'album') else ''}-{st['language']}.png"
            await pg.screenshot(path=str(OUT / name))
            from PIL import Image
            im = Image.open(OUT / name).convert('RGB'); im = im.resize((1280, round(im.height * 1280 / im.width)), Image.LANCZOS)
            im.save(OUT / name.replace('.png', '.webp'), 'WEBP', quality=86, method=6); (OUT / name).unlink()
            print(name, errs)
            await ctx.close()
        await b.close()
    httpd.shutdown()
asyncio.run(main())
