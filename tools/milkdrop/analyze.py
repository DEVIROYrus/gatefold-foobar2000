"""
Measure every preset of the Butterchurn packs, so Gatefold ships only good ones (select.mjs picks them).

    npm i --no-save butterchurn@2.6.7 butterchurn-presets@2.4.7
    python tools/milkdrop/analyze.py          # ~30 min (software WebGL) → tools/milkdrop/metrics.json
    node tools/milkdrop/select.mjs            # → theme/js/vendor/milkdrop/presets.json

Each preset is rendered at 128×72 for 5 s of a synthetic song (kick, bass, a chord, hats) and measured
10 times a second: flashing (WCAG 2.3.1: opposing luminance changes of ≥ 10 %, over the whole picture and
in each of 12 regions), motion, brightness and its variation, colourfulness, how much is near-black, detail.
"""
import asyncio, json, os, subprocess, sys, tempfile, shutil, threading, http.server
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NM = os.path.join(ROOT, 'node_modules')
PACKS = ['butterchurnPresets.min.js', 'butterchurnPresetsExtra.min.js', 'butterchurnPresetsExtra2.min.js', 'butterchurnPresetsMD1.min.js']

def main():
    site = tempfile.mkdtemp()
    shutil.copy(os.path.join(NM, 'butterchurn', 'lib', 'butterchurn.min.js'), site)
    shutil.copy(os.path.join(os.path.dirname(__file__), 'analyze.html'), os.path.join(site, 'an.html'))
    js = "const all={};global.self=global;global.window=global;for(const f of %s){const m=require(%r+f);Object.assign(all,(m.default||m).getPresets())}require('fs').writeFileSync(%r,JSON.stringify(all))" % (json.dumps(PACKS), os.path.join(NM, 'butterchurn-presets', 'lib') + os.sep, os.path.join(site, 'all.json'))
    subprocess.run(['node', '-e', js], check=True)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=site, **k))
    srv.RequestHandlerClass.log_message = lambda *a: None
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    async def run():
        async with async_playwright() as p:
            b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
            pg = await b.new_page()
            pg.on('console', lambda m: print(m.text, flush=True))
            await pg.goto(f'http://127.0.0.1:{srv.server_address[1]}/an.html')
            await pg.wait_for_function('window.__done === true', timeout=4 * 3600 * 1000, polling=2000)
            out = await pg.evaluate('window.__out')
            json.dump(out, open(os.path.join(os.path.dirname(__file__), 'metrics.json'), 'w'), indent=0, sort_keys=True)
            print('measured', len(out))
    asyncio.run(run())

if __name__ == '__main__':
    main()
