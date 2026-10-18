"""
Gatefold end-to-end tests: the theme runs in headless Chromium against a mock of the
foo_ui_webview2 bridge (tests/fixtures/mock-bridge.js + mock-extras.js) — no foobar2000 needed.

  pip install playwright && python -m playwright install chromium
  python tests/e2e.py            (CHROMIUM=/path/to/chrome to use a specific browser)

Checks: every screen renders without page errors in Russian and English; the English interface
contains no untranslated Russian text; playlist view modes; likes; YouTube search modes; the
language switch; settings search; the one-click updater (checksum, component requirement, install,
rollback); the theme's own tooltips; the Canvas volume control.
"""
import asyncio, os, sys, threading, http.server, socketserver, functools, json, io, re, zipfile, hashlib
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / 'tests' / 'fixtures'
MOCK = ''.join((FIX / f).read_text(encoding='utf-8') for f in ('mock-bridge.js', 'mock-extras.js', 'mock-updates.js'))
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

async def page(browser, port, settings, setup=None):
    ctx = await browser.new_context(viewport={'width': 1600, 'height': 940})
    if setup: await setup(ctx)
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

# ---------------------------------------------------------------- updater
def release_zip(version):
    """the archive the release workflow publishes: one top folder, deflate, the theme at `version`"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in sorted((ROOT / 'theme').rglob('*')):
            if not f.is_file(): continue
            rel = f.relative_to(ROOT / 'theme').as_posix()
            data = f.read_bytes()
            if rel == 'js/version.js': data = re.sub(rb"VERSION = '[^']+'", b"VERSION = '" + version.encode() + b"'", data)
            if rel == 'gatefold.json': data = re.sub(rb'"version": "[^"]+"', b'"version": "' + version.encode() + b'"', data)
            z.writestr('gatefold/' + rel, data)
    b = buf.getvalue()
    return b, f'{hashlib.sha256(b).hexdigest()}  gatefold-theme-{version}.zip\n'

async def test_updates(browser, port):
    print('· updates: check, checksum, component requirement, install, rollback')
    zipb, sums = release_zip('1.1.0')
    files = sum(1 for f in (ROOT / 'theme').rglob('*') if f.is_file())
    served = {'version': '1.0.0'}
    async def setup(ctx):
        async def ver(route):
            src = (ROOT / 'theme/js/version.js').read_text(encoding='utf-8')
            src = re.sub(r"VERSION = '[^']+'", f"VERSION = '{served['version']}'", src)
            src = re.sub(r"REPO = '[^']*'", "REPO = 'test/gatefold'", src)
            await route.fulfill(body=src, content_type='text/javascript')
        await ctx.route('**/theme/js/version.js', ver)
        await ctx.route('**/__upd/theme.zip', lambda r: r.fulfill(body=zipb, content_type='application/zip'))
        await ctx.route('**/__upd/sums.txt', lambda r: r.fulfill(body=sums, content_type='text/plain'))
    ctx, pg, errs = await page(browser, port, {'language': 'en'}, setup)
    pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
    S = lambda k: pg.evaluate(f"window.__upd.S('{k}')")
    await nav(pg, 'settings', 900)
    await pg.evaluate("document.querySelector('#st-updates [data-x=check]').click()"); await pg.wait_for_timeout(800)
    check(len(await S('checks')) == 1, 'Check now asks GitHub for the latest release')
    check(await pg.evaluate("!document.querySelector('#updPill').hidden"), 'the sidebar shows the update pill')
    check('1.0.0 → 1.1.0' in await pg.inner_text('#updPill'), 'the pill names both versions')
    check('Update available' in await pg.inner_text('#updPill'), 'the pill is translated')
    check(await pg.evaluate("!!document.querySelector('#st-updates [data-x=open]')"), 'Settings offers «Update to 1.1.0»')

    # 1. a checksum that does not match: nothing is written
    await pg.evaluate("window.__upd.set({ badSum: true })")
    await pg.click('#updPill'); await pg.wait_for_timeout(500)
    check(await pg.evaluate("document.querySelector('.upd-veil').classList.contains('on')"), 'the pill opens the update sheet')
    notes = await pg.inner_html('.upd-notes')
    check('<li>' in notes and '<b>Faster</b>' in notes and 'aaaa' not in notes, 'release notes render as safe Markdown without the checksum block')
    await pg.click('.upd-sheet [data-u=go]'); await pg.wait_for_timeout(1500)
    check('checksum' in (await pg.inner_text('.upd-err')).lower(), 'a bad checksum is reported')
    check(not await S('written') and not await S('copies'), 'a bad checksum writes nothing')

    # 2. the release needs a newer component than the one installed
    await pg.evaluate("window.__upd.set({ badSum: false, comp: '1.9.0' })")
    await pg.click('.upd-sheet [data-u=go]'); await pg.wait_for_timeout(1500)
    check(await pg.evaluate("!!document.querySelector('.upd-sheet [data-u=setup]')"), 'an older WebView2 UI component turns the button into «Download installer»')
    check(not await S('written'), 'nothing is written when the component is too old')
    await ctx.close()

    # 3. a real install, then the note after the reload, then rollback
    ctx, pg, errs = await page(browser, port, {'language': 'en'}, setup)
    pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
    S = lambda k: pg.evaluate(f"window.__upd.S('{k}')")
    await nav(pg, 'settings', 900)
    await pg.evaluate("document.querySelector('#st-updates [data-x=check]').click()"); await pg.wait_for_timeout(800)
    served['version'] = '1.1.0'          # what the template folder serves once the files are written
    await pg.click('#updPill'); await pg.wait_for_timeout(400)
    await pg.click('.upd-sheet [data-u=go]'); await pg.wait_for_timeout(4500)
    copies, written = await S('copies'), await S('written')
    check(copies[:1] == [[r'C:\Users\me\AppData\Roaming\foobar2000-v2\webview-ui\gatefold', r'%profile%\gatefold\backup\1.0.0', True]], f'the current template is backed up first {copies[:1]}')
    check(len(written) == files, f'every file of the release is written ({len(written)}/{files})')
    check(all(w[1] and w[2] == 'binary' for w in written), 'writes are atomic and binary')
    check(written and written[-1][0].endswith('.html') and not any(w[0].endswith('.html') for w in written[:-2]), 'pages are written last')
    check("VERSION = '1.1.0'" in (await pg.evaluate("sessionStorage.getItem('upd.versionjs')") or ''), 'the written version.js is the new one')
    toast = await pg.evaluate("[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')")
    check('Gatefold updated to 1.1.0' in toast, f'after the reload a note says what was installed {toast[:80]}')
    check(await pg.evaluate("document.querySelector('#updPill').hidden"), 'no pill once up to date')
    await nav(pg, 'settings', 900)
    check(await pg.evaluate("!!document.querySelector('#st-updates [data-x=rollback]')"), 'Settings offers to restore the previous version')
    await pg.evaluate("document.querySelector('#st-updates [data-x=rollback]').click()"); await pg.wait_for_timeout(2500)
    copies = await S('copies')
    check(copies[-1] == [r'%profile%\gatefold\backup\1.0.0', r'C:\Users\me\AppData\Roaming\foobar2000-v2\webview-ui\gatefold', True], f'rollback copies the backup back {copies[-1:]}')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def test_tooltips(browser, port):
    print('· tooltips')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await nav(pg, 'now', 900)
    # the order button (its title changes with the order — the clipped one in the bug report), the
    # top-left corner, the far right of the player bar, and a sidebar item in the collapsed sidebar
    for sel in ['#btnOrder', '#btnSidebar', '#btnFull', '#sidebar .nav-item[data-view=settings]']:
        if 'nav-item' in sel: await pg.evaluate("document.body.classList.add('side-collapsed')"); await pg.wait_for_timeout(400)
        el = await pg.query_selector(sel)
        await pg.mouse.move(5, 470); await pg.wait_for_timeout(100)
        await el.hover(); await pg.wait_for_timeout(700)
        r = await pg.evaluate("""(el) => { const t = document.querySelector('.gf-tip'); if (!t) return null; const a = t.getBoundingClientRect(), b = el.getBoundingClientRect();
            return { on: t.classList.contains('on'), text: t.textContent, native: el.hasAttribute('title'), inside: a.left >= 0 && a.top >= 0 && a.right <= innerWidth && a.bottom <= innerHeight,
                     near: Math.min(Math.abs(a.top - b.bottom), Math.abs(b.top - a.bottom)) < 16, label: el.getAttribute('aria-label') || el.textContent.trim() }; }""", el)
        check(bool(r and r['on'] and r['text']), f'{sel}: the theme tooltip shows ({r and r["text"]!r})')
        check(bool(r and not r['native']), f'{sel}: the native title tooltip is suppressed')
        check(bool(r and r['inside'] and r['near']), f'{sel}: the tooltip sits next to the element and inside the window')
        check(bool(r and r['label']), f'{sel}: the element keeps an accessible name')
        await pg.keyboard.press('Shift'); await pg.wait_for_timeout(200)
        check(not await pg.evaluate("document.querySelector('.gf-tip').classList.contains('on')"), f'{sel}: a key press hides it')
    # the label of a collapsed-sidebar item is its tooltip only while the sidebar is collapsed
    await pg.evaluate("document.body.classList.remove('side-collapsed')"); await pg.wait_for_timeout(400)
    await pg.mouse.move(5, 470); await pg.hover('#sidebar .nav-item[data-view=library]'); await pg.wait_for_timeout(700)
    check(not await pg.evaluate("document.querySelector('.gf-tip').classList.contains('on')"), 'expanded sidebar items show no redundant tooltip')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def test_canvas_volume(browser, port):
    print('· Canvas volume')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await pg.evaluate("document.querySelector('#btnFull').click()"); await pg.wait_for_timeout(1500)
    check(await pg.evaluate("document.querySelector('.cv-range')?.value") == '72', 'the slider shows the foobar2000 volume')
    await pg.evaluate("(() => { const r = document.querySelector('.cv-range'); r.value = 40; r.dispatchEvent(new Event('input', { bubbles: true })); })()"); await pg.wait_for_timeout(200)
    calls = await pg.evaluate("window.__calls.filter(c => c[0].startsWith('playback.setVolume') || c[0] === 'playback.toggleMute').map(c => c.join(' '))")
    check(any('"volume":40' in c for c in calls), f'moving the slider sets the volume {calls[-2:]}')
    await pg.keyboard.press('ArrowUp'); await pg.wait_for_timeout(200)
    check(await pg.evaluate("document.querySelector('.cv-range').value") == '45', '↑ raises the volume by 5')
    await pg.keyboard.press('m'); await pg.wait_for_timeout(200)
    check(await pg.evaluate("window.__calls.some(c => c[0] === 'playback.toggleMute')"), 'M toggles mute')
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
        await test_updates(browser, port)
        await test_tooltips(browser, port)
        await test_canvas_volume(browser, port)
        await browser.close()
    httpd.shutdown()
    print(f'\n{len(failures)} failure(s)')
    sys.exit(1 if failures else 0)

if not os.environ.get('E2E_IMPORT_ONLY'):
    asyncio.run(main())
