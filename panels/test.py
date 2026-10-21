"""
Gatefold panels — end-to-end checks in headless Chromium with the mocked foobar2000 bridge of the
Gatefold tests (tests/fixtures). Builds the panels first:   python panels/test.py
"""
import asyncio, json, os, re, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tests')); os.environ['E2E_IMPORT_ONLY'] = '1'
import e2e
from e2e import check, failures, MOCK
from playwright.async_api import async_playwright

BUILD = ROOT / '.panels-build'
subprocess.run([sys.executable, str(ROOT / 'panels' / 'build.py'), str(BUILD)], check=True)
PANEL = ("window.__panel = { calls: [], menus: [] }; const _pn = () => { const f = window.fb2k.invoke.bind(window.fb2k); window.fb2k.invoke = (m, p) => {"
         " if (m === 'window.getMode') return Promise.resolve({ success: true, mode: 'cui', panelMode: true });"
         " if (m === 'panel.setConfig') { window.__panel.calls.push(p); return Promise.resolve({ success: true, changed: true }); }"
         " if (m === 'menu.show' && !window.__noMenuShow) { window.__panel.menus.push(p); return Promise.resolve({ success: true, menuId: 'm' + window.__panel.menus.length }); }"
         " if (m === 'menu.show') return Promise.resolve({ success: false, code: 'UNKNOWN_METHOD' });"
         " return f(m, p); }; };"
         " const _pt = setInterval(() => { if (window.fb2k && window.fb2k.invoke && !window.__pnHooked) { window.__pnHooked = 1; _pn(); clearInterval(_pt); } }, 1);")
SHOTS = os.environ.get('SHOTS')

async def seekbar(browser, port):
    print('· seekbar panel')
    ctx = await browser.new_context(viewport={'width': 1000, 'height': 40})
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script("localStorage.setItem('aurora.settings.v1', JSON.stringify({language: 'en', colorSource: 'dark'}));" + MOCK + PANEL)
    await pg.goto(f'http://127.0.0.1:{port}/.panels-build/gatefold-seekbar/index.html'); await pg.wait_for_timeout(2500)
    px = await pg.evaluate("""(() => { const c = document.getElementById('sbWave'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, sat = 0, grey = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) { n++; const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); if (mx - mn > 60) sat++; else grey++; }
      return { w: c.width, n, sat, grey }; })()""")
    check(px['n'] > px['w'] * 3, f'the waveform is drawn {px}')
    check(px['sat'] > 50 and px['grey'] > 50, 'played part in the album colours, the rest neutral')
    t = await pg.inner_text('#sbCur'), await pg.inner_text('#sbDur')
    check(re.match(r'^\d+:\d\d$', t[0]) and re.match(r'^\d+:\d\d$', t[1]), f'elapsed and total time {t}')
    r = await pg.evaluate("(() => { const b = document.getElementById('sbTrack').getBoundingClientRect(); return [b.left, b.width, b.top + b.height / 2]; })()")
    dur = await pg.evaluate("window.fb2k.invoke('playback.getCurrentTrack').then(r => r.track.duration)")
    await pg.mouse.move(r[0] + r[1] * 0.25, r[2]); await pg.wait_for_timeout(250)
    check(await pg.evaluate("document.getElementById('sbTip').classList.contains('on')"), 'hovering shows the time under the pointer')
    await pg.mouse.down(); await pg.mouse.move(r[0] + r[1] * 0.5, r[2], steps=4); await pg.mouse.up(); await pg.wait_for_timeout(300)
    pos = [c[1] for c in await pg.evaluate("window.__calls") if c[0] == 'playback.setPosition']
    check(pos and abs(pos[-1] - dur * 0.5) < dur * 0.03, f'dragging seeks to where it is released ({pos[-1:]} of {dur})')
    await pg.mouse.wheel(0, 100); await pg.wait_for_timeout(300)
    pos2 = [c[1] for c in await pg.evaluate("window.__calls") if c[0] == 'playback.setPosition']
    check(len(pos2) == len(pos) + 1 and 4 < pos2[-1] - pos[-1] < 6.5, f'the wheel steps 5 s {pos2[-1:]}')
    await pg.mouse.click(r[0] + 50, r[2], button='right'); await pg.wait_for_timeout(300)
    menus = await pg.evaluate("window.__panel.menus")
    check(menus and menus[0].get('windowModel') == 'contentSized' and [i.get('type') for i in menus[0]['items'][:4]] == ['segmented'] * 4, 'right click: the settings menu of the component, sized for a panel')
    check(menus and [s['label'] for s in menus[0]['items'][0]['segments']] == ['Bars', 'Solid', 'Line'], 'in English')
    for item, v in (('style', 1), ('bg', 1), ('colors', 2)):
        await pg.evaluate(f"window.__emit('menu:valueChanged', {{ menuId: 'm1', itemId: '{item}', value: {v} }})"); await pg.wait_for_timeout(250)
    await pg.wait_for_timeout(400)
    pref = await pg.evaluate("JSON.parse(localStorage.getItem('gatefold.seekbar.v1'))")
    check(pref.get('style') == 'solid' and pref.get('bg') == 'none' and pref.get('colors') == 'light', f'the menu changes the panel settings {pref}')
    check(any(c.get('transparentBackground') is True for c in await pg.evaluate("window.__panel.calls")), 'a transparent background is switched on in the panel too')
    check(await pg.evaluate("document.documentElement.dataset.scheme") == 'light', 'light colours apply at once')
    check(await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1')).colorSource") == 'dark', "Gatefold's own settings are not touched")
    await pg.mouse.click(r[0] + 50, r[2], button='middle'); await pg.wait_for_timeout(200)
    check(any(c[0] == 'playback.playOrPause' for c in await pg.evaluate("window.__calls")), 'middle click plays / pauses')
    if SHOTS: await pg.screenshot(path=SHOTS + '/seekbar.png')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()
    # a component without menu.show: a strip of options inside the panel
    ctx = await browser.new_context(viewport={'width': 900, 'height': 34})
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script("window.__noMenuShow = 1; localStorage.setItem('aurora.settings.v1', JSON.stringify({language: 'ru'}));" + MOCK + PANEL)
    await pg.goto(f'http://127.0.0.1:{port}/.panels-build/gatefold-seekbar/index.html'); await pg.wait_for_timeout(2000)
    await pg.mouse.click(300, 17, button='right'); await pg.wait_for_timeout(300)
    txt = await pg.evaluate("document.querySelector('.sb-opts')?.innerText || ''")
    check('Вид: Столбики' in txt, f'older components: options in the panel, in Russian {txt[:60]!r}')
    await pg.evaluate("document.querySelector('.sb-opts button').click()"); await pg.wait_for_timeout(200)
    check(await pg.evaluate("JSON.parse(localStorage.getItem('gatefold.seekbar.v1')).style") == 'solid', 'a click moves to the next look')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def covers(browser, port):
    print('· covers panel')
    ctx = await browser.new_context(viewport={'width': 760, 'height': 640})
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script("localStorage.setItem('aurora.settings.v1', JSON.stringify({language: 'en', coverSweep: false}));" + MOCK + PANEL)
    await pg.goto(f'http://127.0.0.1:{port}/.panels-build/gatefold-covers/index.html'); await pg.wait_for_timeout(2500)
    cards = await pg.evaluate("[...document.querySelectorAll('#cpBody .card h3')].map(e => e.innerText)")
    check(cards[:2] == ['Status', 'Cover quality'] and 'Sources' in cards, f'the Covers screen of Gatefold, in English {cards}')
    await pg.evaluate("[...document.querySelectorAll('#cpBody .btn')].find(b => /Check library/.test(b.innerText)).click()"); await pg.wait_for_timeout(1500)
    sw = await pg.evaluate("import('./gf/coverfetch.js').then(m => [m.state.sweeping, m.state.scanned, m.state.sweepDone])")
    check(sw[0] or sw[2] or sw[1] > 0, f'«Check library» runs the finder {sw}')
    check(await pg.evaluate("getComputedStyle(document.body).backgroundColor") not in ('', 'rgba(0, 0, 0, 0)'), 'with its own colours')
    await pg.select_option('#cpLook', 'light'); await pg.wait_for_timeout(200)
    check(await pg.evaluate("document.documentElement.dataset.scheme") == 'light', 'a light look can be chosen')
    miss = await pg.evaluate("[...(window.__i18nMissing || [])]")
    check(not miss, f'every string translated {miss[:3]}')
    if SHOTS: await pg.screenshot(path=SHOTS + '/covers.png')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def main():
    httpd = e2e.serve(); port = httpd.server_address[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'])
        await seekbar(b, port); await covers(b, port)
        await b.close()
    httpd.shutdown()
    print(f'\n{len(failures)} failure(s)'); sys.exit(1 if failures else 0)

asyncio.run(main())
