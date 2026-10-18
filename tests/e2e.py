"""
Gatefold end-to-end tests: the theme runs in headless Chromium against a mock of the
foo_ui_webview2 bridge (tests/fixtures/mock-bridge.js + mock-extras.js) — no foobar2000 needed.

  pip install playwright && python -m playwright install chromium
  python tests/e2e.py            (CHROMIUM=/path/to/chrome to use a specific browser)

Checks: every screen renders without page errors in Russian and English; the English interface
contains no untranslated Russian text; playlist view modes; likes; YouTube search modes; the
language switch; settings search.
"""
import asyncio, os, sys, threading, http.server, socketserver, functools, json
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / 'tests' / 'fixtures'
MOCK = (FIX / 'mock-bridge.js').read_text(encoding='utf-8') + (FIX / 'mock-extras.js').read_text(encoding='utf-8')
VIEWS = ['now', 'playlist', 'artists', 'library', 'queue', 'youtube', 'covers', 'settings']
# Russian strings that come from the mock music library itself (data, not interface text)
DATA = ['Слепое пятно', 'Тихий Час', 'Неизвестный Бэнд', 'Другой альбом', 'Кто-то ещё', 'Без обложки', 'Локальная строка',
        'Вечерняя ротация', 'Белый лист', 'Русский', 'НБ', 'ТЧ']
SCAN = """(() => { const out = new Set(); const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const v = n.nodeValue.trim(); if (/[А-Яа-яЁё]/.test(v) && n.parentElement && n.parentElement.offsetParent !== null) out.add(v.slice(0, 100)); }
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) for (const a of ['title','placeholder','aria-label']) { const v = el.getAttribute(a); if (v && /[А-Яа-яЁё]/.test(v) && el.offsetParent !== null) out.add('@' + a + ': ' + v.slice(0, 100)); }
  return [...out]; })()"""

class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = path.split('?')[0]
        if p.startswith('/covers/'): return str(FIX / 'covers' / p[len('/covers/'):])
        return str(ROOT / p.lstrip('/'))
    def log_message(self, *a): pass

def serve():
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

failures = []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond: failures.append(msg)

async def page(browser, port, settings):
    ctx = await browser.new_context(viewport={'width': 1600, 'height': 940})
    pg = await ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    # seeded once per context: a reload (e.g. after a language switch) keeps what the page saved
    seed = "if (!localStorage.getItem('aurora.settings.v1')) localStorage.setItem('aurora.settings.v1', JSON.stringify(%s));" % json.dumps({'fontMode': 'inter', 'coverSweep': False, 'coverAuto': False, 'artistAuto': False, 'canvasIdleMin': 0, **settings})
    await pg.add_init_script(seed + MOCK)
    await pg.goto(f'http://127.0.0.1:{port}/theme/index.html')
    await pg.wait_for_timeout(1500)
    return ctx, pg, errs

async def nav(pg, v, wait=1100):
    await pg.evaluate(f"document.querySelector('.nav-item[data-view={v}]').click()")
    await pg.wait_for_timeout(wait)

async def test_language(browser, port, lang):
    print(f'· every screen, language={lang}')
    ctx, pg, errs = await page(browser, port, {'language': lang})
    leftovers = {}
    for v in VIEWS:
        await nav(pg, v)
        if v == 'now':
            await pg.evaluate("document.querySelector('[data-tab=lyrics]')?.click()"); await pg.wait_for_timeout(900)
        if lang == 'en':
            for s in await pg.evaluate(SCAN):
                if not any(d in s for d in DATA): leftovers.setdefault(s, v)
    check(not errs, f'{lang}: no page errors {errs[:2]}')
    if lang == 'en':
        missing = await pg.evaluate('[...window.__i18nMissing]')
        check(not missing, f'en: every string has a translation {missing[:5]}')
        check(not leftovers, f'en: no Russian interface text on screen {list(leftovers.items())[:5]}')
        check(await pg.evaluate("document.documentElement.lang") == 'en', 'en: <html lang="en">')
    await ctx.close()

async def test_playlists(browser, port):
    print('· playlist views and likes')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await nav(pg, 'playlist', 1500)
    for m, sel in [('covers', '#plList .vrow.wc'), ('grid', '#plList .vtile'), ('compact', '#plList .vrow'), ('albums', '#plList .vhead')]:
        await pg.evaluate(f"document.querySelector('#plModes [data-m={m}]').click()"); await pg.wait_for_timeout(1200)
        n = await pg.evaluate(f"document.querySelectorAll('{sel}').length")
        check(n > 0, f'view "{m}" renders ({n})')
    await pg.evaluate("document.querySelector('#btnLike').click()"); await pg.wait_for_timeout(700)
    check(await pg.evaluate("window.__liked.items.length") == 1, 'like from the player bar adds to the Liked playlist')
    check(await pg.evaluate("window.__liked.name") == 'Liked', 'the Liked playlist is named in the interface language')
    await pg.evaluate("document.querySelector('.pb-meta [data-go=album]').click()"); await pg.wait_for_timeout(1200)
    check(await pg.evaluate("document.querySelector('.view.active')?.id") == 'view-album', 'album link in the player bar')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def test_youtube(browser, port):
    print('· YouTube search modes')
    for mode, extra, expect in [('off', {}, 0), ('api', {'ytSearch': 'api', 'ytApiKey': 'AIzaTEST'}, 10), ('web', {'ytSearch': 'web'}, 12)]:
        ctx, pg, errs = await page(browser, port, {'language': 'en', **extra})
        await nav(pg, 'youtube', 800)
        await pg.click('#view-youtube .yt-search input'); await pg.keyboard.type('synthwave'); await pg.keyboard.press('Enter')
        await pg.wait_for_timeout(1800)
        n = await pg.evaluate("document.querySelectorAll('#view-youtube .yt-grid .yt-card[data-i]').length")
        check(n == expect, f'search mode "{mode}": {n} results (expected {expect})')
        if mode == 'off':
            check('off' in (await pg.evaluate("document.querySelector('#view-youtube .yt-note')?.innerText || ''")).lower(), 'search off: explains how to turn it on')
        check(not errs, f'{mode}: no page errors {errs[:2]}')
        await ctx.close()

async def test_settings(browser, port):
    print('· settings: search, language switch')
    ctx, pg, errs = await page(browser, port, {'language': 'ru'})
    await nav(pg, 'settings', 900)
    await pg.fill('.st-search input', 'язык'); await pg.wait_for_timeout(300)
    vis = await pg.evaluate("[...document.querySelectorAll('.st-sec:not([hidden]) .row:not([hidden]) .lbl b')].map(e=>e.innerText)")
    check(any('Язык' in v for v in vis), f'settings search finds the language row {vis[:3]}')
    await pg.fill('.st-search input', '')
    await pg.evaluate("[...document.querySelectorAll('#st-window .seg button')].find(b => b.innerText === 'English').click()")
    await pg.wait_for_timeout(2500)
    check(await pg.evaluate("document.documentElement.lang") == 'en', 'switching to English reloads the interface in English')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def main():
    httpd = serve(); port = httpd.server_address[1]
    async with async_playwright() as p:
        kw = {'executable_path': os.environ['CHROMIUM']} if os.environ.get('CHROMIUM') else {}
        browser = await p.chromium.launch(**kw)
        for lang in ('ru', 'en'): await test_language(browser, port, lang)
        await test_playlists(browser, port)
        await test_youtube(browser, port)
        await test_settings(browser, port)
        await browser.close()
    httpd.shutdown()
    print(f'\n{len(failures)} failure(s)')
    sys.exit(1 if failures else 0)

if not os.environ.get('E2E_IMPORT_ONLY'):
    asyncio.run(main())
