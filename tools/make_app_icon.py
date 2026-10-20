"""
Gatefold's icon from installer/assets/gatefold.svg: gatefold.ico (16–256 px, for the installer, the
Start menu and desktop shortcuts), gatefold-256.png (the tray icon, see make_win_icons.py) and the
small wizard images of the installer. Rendered by headless Chromium, downsampled per size.

  python tools/make_app_icon.py && python tools/make_win_icons.py
"""
import asyncio, io
from pathlib import Path
from PIL import Image
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / 'installer' / 'assets'
BIG = 1024

async def render():
    svg = (A / 'gatefold.svg').read_text(encoding='utf-8')
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': BIG, 'height': BIG})
        await pg.set_content(f"<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{BIG}px;height:{BIG}px}}</style>{svg}")
        png = await pg.screenshot(omit_background=True); await b.close()
    return Image.open(io.BytesIO(png)).convert('RGBA')

def at(im, sz, pad=0.0):
    """the mark at sz × sz; small sizes get a little room so the anti-aliased edge is not cut"""
    inner = round(sz * (1 - 2 * pad))
    out = Image.new('RGBA', (sz, sz), (0, 0, 0, 0))
    out.alpha_composite(im.resize((inner, inner), Image.LANCZOS), ((sz - inner) // 2, (sz - inner) // 2))
    return out

im = asyncio.run(render())
sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
frames = [at(im, s, 0.04 if s <= 32 else 0.02) for s in sizes]
frames[-1].save(A / 'gatefold.ico', format='ICO', sizes=[(s, s) for s in sizes], append_images=frames[:-1])
frames[-1].save(A / 'gatefold-256.png')
# installer: the small image at the top right of every page (white, the mark centred)
for pct, (w, h) in {100: (55, 55), 125: (64, 68), 150: (83, 80), 175: (92, 97), 200: (110, 106)}.items():
    s = round(min(w, h) * 0.78)
    bg = Image.new('RGBA', (w, h), (255, 255, 255, 255)); bg.alpha_composite(at(im, s), ((w - s) // 2, (h - s) // 2))
    bg = bg.convert('RGB'); bg.save(A / f'wizard-small-{pct}.bmp'); bg.save(A / f'wizard-small-{pct}.png')
print('ok')
