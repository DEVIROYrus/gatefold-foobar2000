"""GitHub's social preview (Settings → Social preview, 1280 × 640): python tools/social_preview.py → docs/social-preview.png"""
import asyncio, base64
from pathlib import Path
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parent.parent
svg = (ROOT / 'installer/assets/gatefold.svg').read_text(encoding='utf-8')
shot = base64.b64encode((ROOT / 'docs/screenshots/now-en.webp').read_bytes()).decode()
fonts = ROOT / 'theme' / 'fonts'
HTML = f"""<html><head><style>
@font-face {{ font-family: Inter; src: url('{(fonts / 'inter-latin-opsz-normal.woff2').as_uri()}'); font-weight: 100 900; }}
body {{ margin: 0; width: 1280px; height: 640px; overflow: hidden; font-family: Inter, 'Segoe UI', system-ui, sans-serif; color: #f4f1ff;
  background: radial-gradient(70% 90% at 12% 18%, #6a1f63 0%, transparent 60%), radial-gradient(60% 80% at 95% 95%, #2a2f86 0%, transparent 65%), #120e1f; }}
.l {{ position: absolute; left: 72px; top: 110px; width: 470px; }}
.mark svg {{ width: 92px; height: 92px; filter: drop-shadow(0 16px 30px rgb(0 0 0 / .45)); }}
h1 {{ margin: 22px 0 10px; font-size: 76px; font-weight: 800; letter-spacing: -.035em; line-height: 1; }}
p {{ margin: 0; font-size: 27px; line-height: 1.3; color: #d9d2f0; font-weight: 500; letter-spacing: -.01em; }}
.tags {{ margin-top: 30px; display: flex; flex-wrap: wrap; gap: 10px; }}
.tags span {{ padding: 8px 15px; border-radius: 999px; background: rgb(255 255 255 / .09); border: 1px solid rgb(255 255 255 / .14); font-size: 18px; font-weight: 600; color: #ece6ff; }}
.shot {{ position: absolute; left: 590px; top: 70px; width: 820px; border-radius: 18px; overflow: hidden; box-shadow: 0 40px 90px -20px rgb(0 0 0 / .7), 0 0 0 1px rgb(255 255 255 / .1);
  transform: perspective(1600px) rotateY(-9deg) rotateX(3deg); transform-origin: left center; }}
.shot img {{ display: block; width: 100%; }}
</style></head><body>
<div class="l"><div class="mark">{svg}</div><h1>Gatefold</h1><p>foobar2000 that understands your music: radio and mood playlists by how songs sound.</p>
<div class="tags"><span>On your PC, no server</span><span>Free, no subscription</span><span>foobar2000 engine</span><span>One installer</span></div></div>
<div class="shot"><img src="data:image/webp;base64,{shot}"></div>
</body></html>"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1280, 'height': 640})
        await pg.set_content(HTML); await pg.wait_for_timeout(600)
        await pg.screenshot(path=str(ROOT / 'docs/social-preview.png')); await b.close()
asyncio.run(main())
print('docs/social-preview.png')
