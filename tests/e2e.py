"""
Gatefold end-to-end tests: the theme runs in headless Chromium against a mock of the
foo_ui_webview2 bridge (tests/fixtures/mock-bridge.js + mock-extras.js) — no foobar2000 needed.

  pip install -r tests/requirements.txt && python -m playwright install chromium
  python tests/e2e.py              every test (CHROMIUM=/path/to/chrome to use a specific browser)
  ONLY=columns,language python tests/e2e.py     some tests, by name («language» = every language)
  SHARD=3/8 python tests/e2e.py    part 3 of 8 (CI runs the parts side by side; E2E_PLAN=8 shows them)
  tools/test-all.sh                the static checks and every part at once, on all CPU cores

Checks: every screen renders without page errors in Russian and English; the English interface
contains no untranslated Russian text; playlist view modes; likes; YouTube search modes; the
language switch; settings search; the one-click updater (checksum, component requirement, install,
rollback); the theme's own tooltips; the Canvas volume control; Settings → foobar2000; the first-run welcome.
"""
from collections import Counter
import asyncio, os, sys, threading, http.server, socketserver, functools, json, io, re, zipfile, hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / 'tests' / 'fixtures'
MOCK = ''.join((FIX / f).read_text(encoding='utf-8') for f in ('mock-bridge.js', 'mock-extras.js', 'mock-updates.js', 'mock-prefs.js', 'mock-welcome.js', 'mock-edit.js', 'mock-win.js', 'mock-more.js', 'mock-ml.js', 'mock-level.js', 'mock-editions.js'))
VIEWS = ['now', 'playlist', 'artists', 'library', 'queue', 'youtube', 'covers', 'settings']
# Russian strings that come from the mock music library itself (data, not interface text)
DATA = ['Слепое пятно', 'Тихий Час', 'Неизвестный Бэнд', 'Другой альбом', 'Кто-то ещё', 'Без обложки', 'Локальная строка',
        'Вечерняя ротация', 'Белый лист', 'Русский', 'НБ', 'ТЧ']
SCAN = """(() => { const out = new Set(); const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const v = n.nodeValue.trim(); if (/[А-Яа-яЁё]/.test(v) && n.parentElement && n.parentElement.offsetParent !== null) out.add(v.slice(0, 100)); }
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) for (const a of ['title','placeholder','aria-label']) { const v = el.getAttribute(a); if (v && /[А-Яа-яЁё]/.test(v) && el.offsetParent !== null) out.add('@' + a + ': ' + v.slice(0, 100)); }
  // tooltip.js moves every title into data-tip (and an icon button's aria-label): those are read
  // whether or not the element is on screen right now — the player bar, menus and hidden panels all show them later
  for (const el of document.querySelectorAll('[data-tip],button[aria-label]')) for (const a of ['data-tip','aria-label']) { const v = el.getAttribute(a); if (v && /[А-Яа-яЁё]/.test(v)) out.add('@' + a + ': ' + v.slice(0, 100)); }
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
    print(('  ok   ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: failures.append(msg)

async def page(browser, port, settings, setup=None, pre=''):
    ctx = await browser.new_context(viewport={'width': 1600, 'height': 940})
    if setup: await setup(ctx)
    pg = await ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    if pre: await pg.add_init_script(pre)
    # seeded once per context: a reload (e.g. after a language switch) keeps what the page saved
    seed = "if (!localStorage.getItem('gatefold.soundOffer') && !window.__offerTest) localStorage.setItem('gatefold.soundOffer', 'tests'); if (!localStorage.getItem('aurora.settings.v1')) localStorage.setItem('aurora.settings.v1', JSON.stringify(%s));" % json.dumps({'fontMode': 'inter', 'coverSweep': False, 'coverAuto': False, 'artistAuto': False, 'canvasIdleMin': 0, **settings})
    await pg.add_init_script(seed + MOCK)
    await pg.goto(f'http://127.0.0.1:{port}/theme/index.html')
    await pg.wait_for_timeout(1500)
    return ctx, pg, errs

async def choose(pg, sel, value):
    # selects are drawn by select.js: open the button's menu and pick the item, like a person would
    await pg.click(f'{sel} + .sel-btn'); await pg.wait_for_timeout(250)
    label = await pg.evaluate(f"[...document.querySelector('{sel}').options].find(o => o.value === {json.dumps(value)}).textContent")
    await pg.click(f"#layer .menu .mi:has-text({json.dumps(label, ensure_ascii=False)})"); await pg.wait_for_timeout(300)

async def nav(pg, v, wait=1100):
    await pg.evaluate(f"document.querySelector('.nav-item[data-view={v}]').click()")
    await pg.wait_for_timeout(wait)

async def slow_locales(ctx):
    # the language file arrives late (a cold disk, a busy machine): modules that run before it is
    # in must not take the Russian markup as it is (issue #2: the play button's tooltip stayed Russian)
    async def late(route):
        await asyncio.sleep(0.6); await route.continue_()
    await ctx.route('**/js/locales/*.js', late)

async def test_language(browser, port, lang):
    print(f'· every screen, language={lang}')
    ctx, pg, errs = await page(browser, port, {'language': lang}, setup=slow_locales)
    await pg.wait_for_timeout(700)
    leftovers = {}
    for v in VIEWS:
        await nav(pg, v)
        if v == 'now':
            await pg.evaluate("document.querySelector('[data-tab=lyrics]')?.click()"); await pg.wait_for_timeout(900)
        if lang != 'ru':
            for s in await pg.evaluate(SCAN):
                if not any(d in s for d in DATA): leftovers.setdefault(s, v)
    check(not errs, f'{lang}: no page errors {errs[:2]}')
    if lang != 'ru':
        missing = await pg.evaluate('[...window.__i18nMissing]')
        check(not missing, f'{lang}: every string has a translation {missing[:5]}')
        check(not leftovers, f'{lang}: no Russian interface text on screen {list(leftovers.items())[:5]}')
        check(await pg.evaluate("document.documentElement.lang") == lang, f'{lang}: <html lang="{lang}">')
    await ctx.close()
    if lang == 'ru': return
    # the mini player and the Canvas window are pages of their own
    for pagefile in ('mini.html', 'canvas.html'):
        ctx = await browser.new_context(viewport={'width': 900, 'height': 560}); await slow_locales(ctx)
        pg = await ctx.new_page(); perrs = []
        pg.on('pageerror', lambda e: perrs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('aurora.settings.v1', JSON.stringify({language: %s}));" % json.dumps(lang) + MOCK)
        await pg.goto(f'http://127.0.0.1:{port}/theme/{pagefile}'); await pg.wait_for_timeout(2200)
        await pg.mouse.move(450, 280); await pg.wait_for_timeout(300)
        left = [s for s in await pg.evaluate(SCAN) if not any(d in s for d in DATA)]
        check(not left, f'{lang} {pagefile}: no Russian interface text {left[:5]}')
        check(not perrs, f'{lang} {pagefile}: no page errors {perrs[:2]}')
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

async def test_youtube_captions(browser, port):
    print('· YouTube subtitles: off by default, C, language, translation, size, next video')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await nav(pg, 'youtube', 800)
    async def watch(vid):
        await pg.fill('#view-youtube .yt-search input', f'https://www.youtube.com/watch?v={vid}'); await pg.press('#view-youtube .yt-search input', 'Enter')
        await pg.evaluate("document.activeElement.blur()"); await pg.wait_for_timeout(1500)
    shown = lambda: pg.evaluate("window.__yt.shown")
    btn = lambda: pg.evaluate("(() => { const b = document.querySelector('#view-youtube .yt-cc'); return { on: b.classList.contains('on'), none: b.classList.contains('none'), pressed: b.getAttribute('aria-pressed'), label: b.querySelector('span').textContent, tip: b.dataset.tip || b.title }; })()")
    async def menu():
        await pg.click('#view-youtube .yt-ccm'); await pg.wait_for_timeout(900)
        return await pg.evaluate("[...document.querySelectorAll('#layer .menu .mi')].map(m => (m.querySelector('.chk').textContent ? '✓' : '') + m.textContent.replace(/[✓›]/g, '').trim())")
    async def pick(label):
        await pg.click(f"#layer .menu .mi:has-text({json.dumps(label)})"); await pg.wait_for_timeout(500)

    await watch('vidAAAAAAA1')
    b = await btn()
    check(await shown() == '', f'off by default, even when YouTube turns captions on by itself ({await shown()!r})')
    check(not b['on'] and b['pressed'] == 'false' and 'Subtitles off' in b['tip'], f'the button shows they are off {b}')

    await pg.keyboard.press('c'); await pg.wait_for_timeout(1200)
    b = await btn()
    check(await shown() == 'en', f'C turns them on, in the interface language ({await shown()!r})')
    check(b['on'] and b['label'] == 'EN' and b['pressed'] == 'true' and 'English' in b['tip'], f'the button shows the language {b}')
    check('Subtitles: English' in await pg.evaluate("document.body.innerText"), 'a toast says which subtitles are on')

    items = await menu()
    check(items[:4] == ['Off', '✓English', 'German', 'Russian (auto-generated)'] and 'Auto-translate: English' in items and 'Subtitle size' in items, f'the menu lists the tracks, the current one ticked {items}')
    await pick('German')
    check(await shown() == 'de' and (await btn())['label'] == 'DE', f'a track from the menu ({await shown()!r})')
    check(await pg.evaluate("JSON.parse(localStorage.getItem('aurora.yt.ccLang'))") == 'de', 'the language is remembered')

    await menu(); await pg.hover("#layer .menu .mi:has-text('Subtitle size')"); await pg.wait_for_timeout(300)
    await pick('Large')
    check(await pg.evaluate("window.__yt.fs") == 1, 'subtitle size')

    await menu(); await pick('Auto-translate: English')
    check(await shown() == 'de>en' and (await btn())['label'] == 'EN', f'YouTube translates into the interface language ({await shown()!r})')
    await menu(); await pick('Auto-translate: English')
    check(await shown() == 'de', f'translation off again ({await shown()!r})')

    await watch('vidBBBBBBB2'); await pg.wait_for_timeout(600)
    check(await shown() == 'de' and await pg.evaluate("window.__yt.fs") == 1, f'the next video: the same language and size ({await shown()!r})')

    await watch('noccCCCCCC3'); await pg.wait_for_timeout(3500)
    b = await btn()
    check(b['none'] and not b['on'] and 'no subtitles' in b['tip'], f'a video without subtitles says so {b}')
    items = await menu()
    check('This video has no subtitles' in items, f'… and so does the menu {items}')
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)

    await watch('vidDDDDDDD4'); await pg.wait_for_timeout(600)
    check(await shown() == 'de', f'subtitles return with the next video that has them ({await shown()!r})')
    await pg.keyboard.press('c'); await pg.wait_for_timeout(500)
    check(await shown() == '' and await pg.evaluate("JSON.parse(localStorage.getItem('aurora.yt.cc'))") is False, 'C turns them off and that is remembered')
    await watch('vidEEEEEEE5'); await pg.wait_for_timeout(600)
    check(await shown() == '', f'still off on the next video, though YouTube turns them on ({await shown()!r})')

    items = await menu()
    check(items[0] == '✓Off' and 'German' in items, f'switched off, the menu still lists the tracks {items}')
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(800)
    check(await shown() == '', f'looking at the list does not switch them on ({await shown()!r})')

    await pg.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'с', code: 'KeyC', bubbles: true }))"); await pg.wait_for_timeout(1200)   # Russian layout: the same key
    check(await shown() == 'de', f'С on the Russian layout ({await shown()!r})')

    await pg.evaluate("document.querySelector('#view-youtube [data-a=full]').click()"); await pg.wait_for_timeout(600)
    r = await pg.evaluate("(() => { const b = document.querySelector('.yt-fsbar .yt-cc'); if (!b) return null; const x = b.getBoundingClientRect(); return [x.width, x.height, x.right <= innerWidth]; })()")
    check(r and r[0] > 20 and r[2], f'the button is in the fullscreen controls {r}')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def test_columns(browser, port):
    print('· your own columns (title formatting) and links in the lists')
    cols = [{'id': 'g', 'name': 'Genre', 'tf': '%genre%', 'w': 'm', 'align': 'auto', 'pl': True, 'al': True},
            {'id': 'y', 'name': 'Year', 'tf': '$year(%date%)', 'w': 's', 'align': 'auto', 'pl': True, 'al': True}]
    ctx, pg, errs = await page(browser, port, {'language': 'en', 'trackColumns': cols})
    await pg.evaluate("(() => { window.__plays = []; const o = fb2k.invoke.bind(fb2k); fb2k.invoke = (m, p) => { if (m === 'playlist.playTrack') window.__plays.push(p); return o(m, p); }; })()")
    await nav(pg, 'playlist', 1500)
    await pg.evaluate("document.querySelector('#plModes [data-m=compact]').click()"); await pg.wait_for_timeout(1200)
    head = await pg.evaluate("[...document.querySelectorAll('#view-playlist .pl-lh > div')].map(d => d.textContent)")
    check(head[-3:] == ['Genre', 'Year', ''] or ('Genre' in head and 'Year' in head), f'the columns are in the playlist header {head}')
    row = await pg.evaluate("[...document.querySelector('#plList .vrow[data-t=\"0\"]').querySelectorAll('.c-cx')].map(c => [c.textContent, c.classList.contains('r')])")
    check(row == [['Synthwave', False], ['2021', True]], f'values from foobar2000, numbers on the right {row}')
    aligned = await pg.evaluate("(() => { const h = [...document.querySelectorAll('#view-playlist .pl-lh .h-cx')].map(e => Math.round(e.getBoundingClientRect().left)); const c = [...document.querySelector('#plList .vrow[data-t=\"0\"]').querySelectorAll('.c-cx')].map(e => Math.round(e.getBoundingClientRect().left)); return [h, c]; })()")
    check(aligned[0] == aligned[1] and len(aligned[0]) == 2, f'header and cells line up {aligned}')
    for m in ('albums', 'covers'):
        await pg.evaluate(f"document.querySelector('#plModes [data-m={m}]').click()"); await pg.wait_for_timeout(1000)
        v = await pg.evaluate("[...document.querySelectorAll('#plList .vrow .c-cx')].slice(0, 2).map(c => c.textContent)")
        check(v == ['Synthwave', '2021'], f'and in the «{m}» view {v}')
    # the header's menu switches a column off for playlists only
    await pg.click('#view-playlist .pl-lh', button='right'); await pg.wait_for_timeout(300)
    await pg.click("#layer .menu .mi:has-text('Year')"); await pg.wait_for_timeout(700)
    head = await pg.evaluate("[...document.querySelectorAll('#view-playlist .pl-lh .h-cx')].map(d => d.textContent)")
    check(head == ['Genre'], f'right click on the header: a column off {head}')
    saved = await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1')).trackColumns.map(c => [c.name, c.pl, c.al])")
    check(saved == [['Genre', True, True], ['Year', False, True]], f'remembered, for playlists only {saved}')
    # links: the artist, the album, the song (marked on its album page); a double click still plays
    await pg.evaluate("document.querySelector('#plModes [data-m=compact]').click()"); await pg.wait_for_timeout(900)
    await pg.click("#plList .vrow[data-t='3'] .c-artist .lnk"); await pg.wait_for_timeout(1000)
    check(await pg.evaluate("document.querySelector('.view.active')?.id") == 'view-artist', 'the artist is a link')
    await nav(pg, 'playlist', 1200)
    await pg.click("#plList .vrow[data-t='3'] .c-album .lnk"); await pg.wait_for_timeout(1500)
    check(await pg.evaluate("document.querySelector('.view.active')?.id") == 'view-album', 'the album is a link')
    yr = await pg.evaluate("[...document.querySelectorAll('#albumList .vrow')][0] && [...document.querySelectorAll('#albumList .vrow')][0].querySelectorAll('.c-cx').length")
    check(yr == 2, f'the album page shows both columns (Year is off for playlists only) ({yr})')
    await nav(pg, 'playlist', 1200)
    title = await pg.evaluate("document.querySelector(\"#plList .vrow[data-t='3'] .c-title\").textContent")
    await pg.click("#plList .vrow[data-t='3'] .c-title .lnk"); await pg.wait_for_timeout(1600)
    marked = await pg.evaluate("[...document.querySelectorAll('#albumList .vrow.sel')].map(r => r.querySelector('.c-title').textContent)")
    check(await pg.evaluate("document.querySelector('.view.active')?.id") == 'view-album' and marked == [title], f'the song opens its album with the song marked ({title} → {marked})')
    await nav(pg, 'playlist', 1200)
    await pg.dblclick("#plList .vrow[data-t='5'] .c-title .lnk"); await pg.wait_for_timeout(900)
    check(await pg.evaluate("document.querySelector('.view.active')?.id") == 'view-playlist' and await pg.evaluate("window.__plays.some(p => p.index === 5)"), 'a double click on the title plays it and stays')
    # the editor: a preset, its preview, a broken pattern does not break the others
    await nav(pg, 'settings', 900)
    await pg.evaluate("document.getElementById('cxEditor').scrollIntoView()")
    await pg.click('#cxEditor .cx-add'); await pg.wait_for_timeout(300)
    await pg.click("#layer .menu .mi:has-text('Composer')"); await pg.wait_for_timeout(900)
    pv = await pg.evaluate("[...document.querySelectorAll('#cxEditor .cx-item')].map(i => [i.querySelector('.cx-name').value, i.querySelector('.cx-pv').textContent])")
    check(pv[-1] == ['Composer', 'J. Doe'], f'a ready-made column, previewed on the playing track {pv}')
    await pg.fill('#cxEditor .cx-item:last-child .cx-tf', '$if2(%genre%'); await pg.wait_for_timeout(1000)
    bad = await pg.evaluate("document.querySelector('#cxEditor .cx-item:last-child .cx-pv').textContent")
    check('Error' in bad, f'a pattern that does not compile says so ({bad})')
    await nav(pg, 'playlist', 1500)
    v = await pg.evaluate("[...document.querySelector('#plList .vrow[data-t=\"0\"]').querySelectorAll('.c-cx')].map(c => c.textContent)")
    check(v[:1] == ['Synthwave'], f'the other columns still show {v}')
    check(not errs, f'no page errors {errs[:2]}')
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
    nh = sum(1 for w in written if w[0].endswith('.html'))
    check(written and nh and all(w[0].endswith('.html') for w in written[-nh:]), 'pages are written last')
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

async def test_fb2k_prefs(browser, port):
    print('· Settings → foobar2000')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await nav(pg, 'settings', 1200)
    sec = '#st-foobar'
    calls = lambda: pg.evaluate("window.__calls.map(c => c.join(' '))")
    check('[WASAPI shared]' in await pg.inner_text(f'{sec} .st-pick'), 'the output device in effect is shown')
    await pg.click(f'{sec} .st-pick'); await pg.wait_for_timeout(300)
    await pg.click("#layer .menu .mi:has-text('Headphones (USB DAC)')"); await pg.wait_for_timeout(400)
    check(any('config.setOutputDevice' in c and '{33333333' in c for c in await calls()), 'picking a device switches foobar2000 output')
    check('Headphones' in await pg.inner_text(f'{sec} .st-pick'), 'the picker shows the new device')
    await pg.click(f"{sec} .seg button:has-text('Track')"); await pg.wait_for_timeout(300)
    check(any('replaygain.setMode' in c and '"sourceMode":"track"' in c for c in await calls()), 'ReplayGain source mode is written')
    await pg.evaluate(f"(() => {{ const r = [...document.querySelectorAll('{sec} .row')].find(x => x.innerText.includes('Output buffer')).querySelector('input'); r.value = 500; r.dispatchEvent(new Event('input')); }})()"); await pg.wait_for_timeout(600)
    check(any('config.setOutputBuffer' in c and '"milliseconds":500' in c for c in await calls()), 'the buffer slider writes milliseconds (debounced)')
    check('Default' in await pg.inner_text(f'{sec}'), 'the active DSP preset is shown')
    roots = await pg.inner_text(f'{sec}')
    check('D:\\Music' in roots and '11,902' in roots, 'library folders are listed with track counts')
    await pg.fill(f'{sec} .adv-search input', 'id3'); await pg.wait_for_timeout(500)
    rows = await pg.evaluate(f"[...document.querySelectorAll('{sec} .adv-row')].map(r => r.innerText)")
    check(len(rows) == 1 and 'Tagging' in rows[0], f'Advanced search finds an entry with its path {rows}')
    check(await pg.evaluate(f"document.querySelector('{sec} .adv-row').classList.contains('changed')"), 'a non-default entry is marked')
    await pg.click(f'{sec} .adv-row .toggle'); await pg.wait_for_timeout(400)
    check(any('setAdvancedConfigValue' in c and '{C2}' in c and 'true' in c for c in await calls()), 'a checkbox entry is written')
    await pg.fill(f'{sec} .adv-search input', 'thread'); await pg.wait_for_timeout(400)
    await pg.fill(f'{sec} .adv-input', '5'); await pg.press(f'{sec} .adv-input', 'Enter'); await pg.wait_for_timeout(400)
    check(any('setAdvancedConfigValue' in c and '{B3}' in c and '"5"' in c for c in await calls()), 'an integer entry is written on Enter')
    await pg.click(f'{sec} .adv-reset'); await pg.wait_for_timeout(400)
    check(any('resetAdvancedConfig' in c and '{B3}' in c for c in await calls()), 'an entry can be reset to its default')
    await pg.fill(f'{sec} .adv-search input', ''); await pg.wait_for_timeout(300)
    await pg.click(f"{sec} .adv-d > summary:has-text('Playback')"); await pg.wait_for_timeout(300)
    await pg.click(f"{sec} .adv-d .adv-d > summary:has-text('Seek')"); await pg.wait_for_timeout(300)
    await pg.click(f"{sec} .adv-radio:not(.on)"); await pg.wait_for_timeout(400)
    check(any('setAdvancedConfigValue' in c and '{B6}' in c for c in await calls()), 'the tree opens branch by branch; a radio entry is selected')
    await pg.click(f"{sec} .btn:has-text('All foobar2000 preferences')"); await pg.wait_for_timeout(200)
    check(any(c.startswith('misc.showPreferences') for c in await calls()), 'the native Preferences dialog is one click away')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def test_welcome(browser, port):
    print('· first run: no music yet')
    for lang in ('ru', 'en'):
        ctx, pg, errs = await page(browser, port, {'language': lang}, pre='window.__emptyMusic = true;')
        await pg.wait_for_timeout(800)
        check(await pg.evaluate("!!document.querySelector('#view-now .welcome') && document.body.classList.contains('no-music')"), f'{lang}: the welcome replaces the empty Now playing screen')
        if lang == 'en':
            left = [s for s in await pg.evaluate(SCAN) if not any(d in s for d in DATA)]
            check(not left, f'en: the welcome is fully translated {left[:3]}')
        await ctx.close()
    ctx, pg, errs = await page(browser, port, {'language': 'en'}, pre='window.__emptyMusic = true;')
    await pg.wait_for_timeout(800)
    calls = lambda: pg.evaluate("window.__calls.map(c => c.join(' '))")
    # «Just listen»: a folder → a new playlist named after it → plays
    await pg.click(".welcome [data-welcome=folder]"); await pg.wait_for_timeout(1500)
    c = await calls()
    check(any('playlist.create' in x and 'Lumen Arcade' in x for x in c), 'Open a folder… creates a playlist named after the folder')
    check(any('playlist.addPathsAsync' in x and 'D:\\\\Music\\\\Lumen Arcade' in x for x in c), 'the folder is added asynchronously')
    check(any(x.startswith('playlist.playTrack') for x in c), 'and starts playing')
    check(await pg.evaluate("document.querySelector('.view.active')?.id") == 'view-playlist', 'the playlist opens')
    check(await pg.evaluate("!document.querySelector('.welcome') && !document.body.classList.contains('no-music')"), 'the welcome is gone once there is music')
    toast = await pg.evaluate("[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')")
    check('Added 12 tracks' in toast and 'Add the folder to the library' in toast, f'the result is reported, with an offer to add the folder to the library {toast[:120]}')
    await ctx.close()
    # «Connect your music folder»: native page opens, the theme waits, then opens Library
    ctx, pg, errs2 = await page(browser, port, {'language': 'en'}, pre='window.__emptyMusic = true;')
    await pg.wait_for_timeout(800)
    await pg.click(".welcome [data-welcome=library]"); await pg.wait_for_timeout(400)
    check(any(x.startswith('config.showLibraryPreferences') for x in await pg.evaluate("window.__calls.map(c => c.join(' '))")), 'Connect a folder… opens foobar2000’s Media Library page')
    check(await pg.evaluate("!document.querySelector('.wl-wait').hidden"), 'the welcome shows that it is waiting')
    await pg.evaluate("window.__wl.lib = 480"); await pg.wait_for_timeout(3800)
    check(await pg.evaluate("document.querySelector('.view.active')?.id") == 'view-library', 'when the library has music, Library opens by itself')
    toast = await pg.evaluate("[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')")
    check('Library connected: 480 tracks' in toast, f'and says how much it found {toast[:100]}')
    await ctx.close()
    # the empty Library and playlist screens offer the same buttons
    ctx, pg, errs3 = await page(browser, port, {'language': 'en'}, pre='window.__emptyMusic = true;')
    await pg.wait_for_timeout(800)
    await pg.click('.welcome [data-welcome=later]'); await pg.wait_for_timeout(300)
    await nav(pg, 'library', 1500)
    check(await pg.evaluate("!!document.querySelector('#view-library .empty [data-welcome=library]')"), 'empty Library offers to connect a folder')
    await nav(pg, 'artists', 1500)
    check(await pg.evaluate("!!document.querySelector('#view-artists .empty [data-welcome=library]')"), 'empty Artists offers to connect a folder')
    await nav(pg, 'playlist', 1500)
    check(await pg.evaluate("!!document.querySelector('#plList .empty [data-welcome=folder][data-guid]')"), 'an empty playlist offers to fill itself')
    check(not (errs + errs2 + errs3), f'no page errors {(errs + errs2 + errs3)[:2]}')
    await ctx.close()

async def test_playlist_editing(browser, port):
    print('· playlist editing')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await nav(pg, 'playlist', 1500)
    await pg.evaluate("document.querySelector('#plModes [data-m=compact]').click()"); await pg.wait_for_timeout(900)
    rows = lambda: pg.evaluate("[...document.querySelectorAll('#plList .vrow')].sort((a,b)=>a.dataset.t-b.dataset.t).map(r => r.children[1].textContent)")
    calls = lambda: pg.evaluate("window.__calls.map(c => c.join(' '))")
    first = await rows()
    row = lambda t: f"#plList .vrow[data-t='{t}']"
    # rows are selected by a click beside the links (the artist and the album are links now)
    sel = lambda t: row(t) + ' .c-n'
    await pg.click(sel(1)); await pg.click(sel(3), modifiers=['Shift']); await pg.click(sel(6), modifiers=['Control'])
    await pg.wait_for_timeout(300)
    check(await pg.evaluate("document.querySelectorAll('#plList .vrow.sel').length") == 4, 'click, Shift+click and Ctrl+click select four rows')
    check(await pg.evaluate("!document.querySelector('.pl-selbar').hidden"), 'the selection bar appears')
    check(await pg.evaluate("JSON.stringify(window.__edit.sel)") == '[1,2,3,6]', 'the selection is passed to foobar2000')
    await pg.keyboard.press('Delete'); await pg.wait_for_timeout(900)
    after = await rows()
    check(len(after) and after[1] == first[4] and after[2] == first[5] and after[3] == first[7], 'Delete removes exactly the selected rows')
    toast = await pg.evaluate("[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')")
    check('Removed from the playlist: 4 tracks' in toast and 'Undo' in toast, f'a toast offers to undo {toast[:80]}')
    await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(900)
    check((await rows())[:8] == first[:8], 'Ctrl+Z brings them back (foobar2000 undo)')
    # drag rows 0..1 below row 5
    await pg.click(sel(0)); await pg.click(sel(1), modifiers=['Shift']); await pg.wait_for_timeout(200)
    b0 = await pg.locator(row(0)).bounding_box(); b5 = await pg.locator(row(5)).bounding_box()
    await pg.mouse.move(b0['x'] + 200, b0['y'] + b0['height'] / 2); await pg.mouse.down()
    await pg.mouse.move(b0['x'] + 200, b0['y'] + 30, steps=4)
    await pg.mouse.move(b5['x'] + 200, b5['y'] + b5['height'] * 0.8, steps=8)
    check(await pg.evaluate("!!document.querySelector('.drag-ghost') && !document.querySelector('.drop-line').hidden"), 'dragging shows a ghost and the drop line')
    await pg.mouse.up(); await pg.wait_for_timeout(900)
    moved = await rows()
    check(moved[:6] == first[2:6] + first[0:2], f'dropping moves the rows there {moved[:6]}')
    check(await pg.evaluate("[...document.querySelectorAll('#plList .vrow.sel')].map(r => +r.dataset.t).sort().join()") == '4,5', 'the moved rows stay selected')
    await pg.keyboard.press('Alt+ArrowUp'); await pg.wait_for_timeout(900)
    check((await rows())[3:5] == first[0:2], 'Alt+↑ moves the selection up by one')
    # drag onto a sidebar playlist = copy there
    b = await pg.locator(row(3)).bounding_box(); side = await pg.locator("#playlists .pl-item[data-guid='{B}']").bounding_box()
    await pg.mouse.move(b['x'] + 200, b['y'] + 10); await pg.mouse.down(); await pg.mouse.move(b['x'] + 150, b['y'] + 40, steps=4)
    await pg.mouse.move(side['x'] + 40, side['y'] + side['height'] / 2, steps=10)
    check(await pg.evaluate("document.querySelector('#playlists .pl-item[data-guid=\"{B}\"]').classList.contains('drop-hl')"), 'a sidebar playlist lights up under the drag')
    await pg.mouse.up(); await pg.wait_for_timeout(700)
    check(await pg.evaluate("window.__edit.added['{B}']") == 2, 'dropping on it copies the rows into that playlist')
    # context menu
    await pg.click(row(8), button='right'); await pg.wait_for_timeout(400)
    labels = await pg.evaluate("[...document.querySelectorAll('#layer .menu .mi')].map(m => m.innerText)")
    check(any('Add to queue' in l for l in labels) and any('Remove from playlist' in l for l in labels) and any('foobar2000 actions' in l for l in labels), f'our context menu {labels}')
    await pg.click("#layer .menu .mi:has-text('foobar2000 actions')"); await pg.wait_for_timeout(500)
    check(any('menu.showNativePopup' in c and 'selection' in c for c in await calls()), 'foobar2000’s own menu opens for the selection')
    await pg.keyboard.press('Control+a'); await pg.wait_for_timeout(300)
    check(len(await pg.evaluate("window.__edit.sel")) == await pg.evaluate("window.__edit.rows.length"), 'Ctrl+A selects the whole playlist')
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
    check(await pg.evaluate("document.querySelectorAll('#plList .vrow.sel').length") == 0, 'Esc clears the selection')
    # sidebar: drag «Road trip» above «Aurora»
    src = await pg.locator("#playlists .pl-item[data-guid='{D}']").bounding_box(); dst = await pg.locator("#playlists .pl-item[data-guid='{B}']").bounding_box()
    await pg.mouse.move(src['x'] + 40, src['y'] + src['height'] / 2); await pg.mouse.down()
    await pg.mouse.move(src['x'] + 40, src['y'] - 10, steps=3); await pg.mouse.move(dst['x'] + 40, dst['y'] + 4, steps=8); await pg.mouse.up(); await pg.wait_for_timeout(900)
    order = await pg.evaluate("window.__edit.order")
    check(order and order.index('{D}') < order.index('{B}'), f'playlists reorder by dragging in the sidebar {order}')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def test_windows(browser, port):
    print('· taskbar, tray, mini player')
    # first start on a small screen: a window bigger than the screen is brought inside, centred
    pre = ("window.__fit = []; const _fi = () => { const f = window.fb2k.invoke.bind(window.fb2k); window.fb2k.invoke = (m, p) => {"
           " if (m === 'window.getBounds') return Promise.resolve({ success: true, x: -300, y: 0, width: 2400, height: 1300 });"
           " if (m === 'window.setBounds') { window.__fit.push(p); return Promise.resolve({ success: true }); } return f(m, p); }; };"
           " const _t = setInterval(() => { if (window.fb2k && window.fb2k.invoke && !window.__fitHooked) { window.__fitHooked = 1; _fi(); clearInterval(_t); } }, 1);")
    ctx, pg, errs = await page(browser, port, {'language': 'en'}, pre=pre)
    fit = await pg.evaluate("[window.__fit, screen.availWidth * devicePixelRatio, screen.availHeight * devicePixelRatio]")
    check(fit[0] and fit[0][-1]['width'] <= fit[1] and fit[0][-1]['height'] <= fit[2] and fit[0][-1]['x'] >= 0, f'a window larger than the screen is fitted onto it {fit}')
    await ctx.close()
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await pg.wait_for_timeout(1500)
    W = lambda: pg.evaluate("window.__win.calls.map(c => [c[0], JSON.stringify(c[1])])")
    c = await W()
    tb = [json.loads(x[1]) for x in c if x[0] == 'taskbar.setThumbnailButtons']
    check(len(tb) == 1 and [b['id'] for b in tb[0]['buttons']] == ['prev', 'pp', 'next', 'like'], 'four thumbnail buttons are installed once')
    check(tb and tb[0]['buttons'][0]['tooltip'] == 'Previous' and all(b.get('icon') for b in tb[0]['buttons']), 'with translated tooltips and our own icons')
    check(any(x[0] == 'taskbar.updateButton' and '"pp"' in x[1] and 'Pause' in x[1] for x in c), 'the play button turns into pause while playing')
    check(any(x[0] == 'taskbar.setProgress' and '"normal"' in x[1] for x in c), 'progress is drawn on the taskbar button')
    check(not any(x[0] == 'tray.create' for x in c), 'no tray icon until it is turned on')
    await pg.evaluate("window.__emit('taskbar:buttonClicked', { id: 'like' })"); await pg.wait_for_timeout(700)
    check(await pg.evaluate("window.__liked.items.length") == 1, 'the ♡ thumbnail button likes the playing track')
    await pg.wait_for_timeout(1200)
    check(any(x[0] == 'taskbar.updateButton' and '"like"' in x[1] and 'Remove from Liked' in x[1] for x in await W()), 'and turns into a filled heart')
    # tray
    await nav(pg, 'settings', 900)
    await pg.evaluate("[...document.querySelectorAll('#st-window .row')].find(r => r.innerText.includes('Notification area')).querySelector('.toggle').click()"); await pg.wait_for_timeout(900)
    c = await W()
    z = [json.loads(x[1]) for x in c if x[0] == 'tray.setMenuZones']
    check(any(x[0] == 'tray.create' for x in c) and z, 'turning the tray icon on creates it with a menu')
    check(z and [r.get('playbackAction') for r in z[-1]['playback'][:3]] == ['play-pause', 'previous', 'next'], 'playback rows run natively (work while the page sleeps)')
    check(z and [r.get('id') for r in z[-1]['bottom'] if r.get('id')][-2:] == ['_sys_show', '_sys_exit'], 'show and exit are native rows too')
    check(any(x[0] == 'tray.setMinimizeToTray' and 'false' in x[1] for x in c), 'minimize-to-tray stays off until asked')
    await pg.evaluate("[...document.querySelectorAll('#st-window .row')].find(r => r.innerText.includes('Close to tray')).querySelector('.toggle').click()"); await pg.wait_for_timeout(500)
    check(any(x[0] == 'tray.setCloseToTray' and 'true' in x[1] for x in await W()), 'close to tray can be turned on')
    await pg.evaluate("window.__emit('tray:click', { button: 0, x: 1, y: 1 })"); await pg.wait_for_timeout(200)
    check(any(x[0] == 'window.focus' and 'main' in x[1] for x in await W()), 'a click on the tray icon brings the window back')
    # mini player
    await pg.evaluate("document.querySelector('#btnMini').click()"); await pg.wait_for_timeout(500)
    pops = await pg.evaluate("window.__win.popups")
    check(len(pops) == 1 and pops[0]['url'] == 'mini.html' and pops[0]['profile'] == 'miniPlayer' and pops[0]['alwaysOnTop'] is True and pops[0]['frame'] is False, f'the mini player opens as a frameless always-on-top popup {pops[:1]}')
    await pg.evaluate("document.querySelector('#btnMini').click()"); await pg.wait_for_timeout(500)
    check(len(await pg.evaluate("window.__win.popups")) == 1, 'a second click brings the open one forward instead of a new window')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()
    # the mini player page itself
    ctx = await browser.new_context(viewport={'width': 400, 'height': 112})
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script("localStorage.setItem('aurora.settings.v1', JSON.stringify({language: 'en'}));" + MOCK)
    await pg.goto(f'http://127.0.0.1:{port}/theme/mini.html'); await pg.wait_for_timeout(1500)
    check(await pg.inner_text('#miTitle') not in ('', 'Gatefold'), 'the mini player shows the playing track')
    check(await pg.evaluate("document.querySelector('#miPlay use').getAttribute('href')") == '#i-pause', 'and the playing state')
    await pg.mouse.move(200, 60); await pg.mouse.wheel(0, -100); await pg.wait_for_timeout(300)
    check(any(c[0] == 'playback.setVolume' for c in await pg.evaluate("window.__calls")), 'the mouse wheel changes the volume')
    if os.environ.get('SHOTS'): await pg.screenshot(path=os.environ['SHOTS'] + '/mini.png')
    check(await pg.evaluate("(() => { const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true }); (document.querySelector('#mini img') || document.body).dispatchEvent(ev); return ev.defaultPrevented; })()"), 'mini: no native drag either')
    check(not errs, f'mini: no page errors {errs[:2]}')
    await ctx.close()

async def test_vu(browser, port):
    print('· VU meters (off by default)')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await nav(pg, 'now', 1200)
    check(not await pg.evaluate("!!document.querySelector('.vu-box')") and await pg.evaluate("getComputedStyle(document.getElementById('viz')).display") != 'none', 'off by default: the spectrum, no meters')
    # the level is read after foobar2000's ReplayGain, as foobar2000 computes it
    R = await pg.evaluate('''import('/theme/js/rg-now.js').then(R => {
      const c = (src, proc, pre = 0, preNo = -6) => ({ sourceMode: src, processingMode: proc, preampWithRg: pre, preampWithoutRg: preNo });
      const v = { trackGainRaw: -6, trackPeakRaw: 0.98, albumGainRaw: -8, albumPeakRaw: 0.99 }, quiet = { trackGainRaw: 12, trackPeakRaw: 0.4, albumGainRaw: 10, albumPeakRaw: 0.3 };
      const r = (x) => Math.round(x.db * 100) / 100;
      return [r(R.compute(c('album', 'gain_and_peak', 4), 0, v)), r(R.compute(c('album', 'gain_and_peak', 4), 0, quiet)), r(R.compute(c('auto', 'gain', 0), 4, v)), r(R.compute(c('auto', 'gain', 0), 0, v)),
              r(R.compute(c('album', 'gain', 0, -9), 0, null)), r(R.compute(c('none', 'gain'), 0, v)), R.compute(c('album', 'gain'), 0, v).lufs];
    })''')
    check(R == [-4, 10.46, -6, -8, -9, 0, -10], f'ReplayGain as foobar2000 applies it: album gain + preamp, peak limit, track gain in shuffle, preamp without values, off; album loudness {R}')
    await nav(pg, 'settings', 900)
    await pg.evaluate("[...document.querySelectorAll('#st-look .row')].find(r => r.innerText.includes('VU meters instead of the spectrum')).querySelector('.toggle input').click()"); await pg.wait_for_timeout(500)
    check(await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1')).vuMeters") is True, 'Settings → Appearance turns them on')
    check(await pg.evaluate("[...document.querySelectorAll('#st-look .row')].some(r => r.innerText.includes('0 VU equals'))"), 'with their own options once on')
    await nav(pg, 'now', 1500)
    check(await pg.evaluate("document.querySelectorAll('.vu-box canvas').length") == 2 and await pg.evaluate("getComputedStyle(document.getElementById('viz')).display") == 'none', 'two meters in place of the spectrum')
    snap = "(() => { const c = document.querySelector('.vu-box canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return [c.width, h]; })()"
    a = await pg.evaluate(snap); await pg.wait_for_timeout(180); b = await pg.evaluate(snap)
    check(a[0] > 100 and a[1] != b[1], f'the needles move with the music {a} {b}')
    check(await pg.evaluate("import('/theme/js/viz.js').then(V => { const r = V.channelRms(); return !!r && r[0] > 0; })"), 'from the live PCM of each channel')
    await pg.evaluate("window.__emit('playback:paused', { paused: true })"); await pg.wait_for_timeout(1800)
    a = await pg.evaluate(snap); await pg.wait_for_timeout(300); b = await pg.evaluate(snap)
    check(a[1] == b[1], 'on pause the needles fall and the drawing stops')
    await pg.evaluate("window.__emit('playback:paused', { paused: false })"); await pg.wait_for_timeout(300)
    await pg.evaluate("document.querySelector('#btnFull').click()"); await pg.wait_for_timeout(1200)
    check(await pg.evaluate("document.querySelectorAll('.cv .vu-box canvas').length") == 2, 'and in the Canvas')
    if os.environ.get('SHOTS'): await pg.screenshot(path=os.environ['SHOTS'] + '/vu-canvas.png')
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(600)
    check(not await pg.evaluate("!!document.querySelector('.cv .vu-box')"), 'gone with the Canvas')
    await pg.evaluate("import('/theme/js/settings.js').then(S => S.setSetting('vuStyle', 'album'))"); await pg.wait_for_timeout(500)
    c = await pg.evaluate("(() => { const c = document.querySelector('.vu-box canvas'); const d = c.getContext('2d').getImageData(Math.round(c.width * 0.3), Math.round(c.height * 0.35), 1, 1).data; return [...d]; })()")
    check(c[0] < 200 or c[1] < 180, f'«Album colours» repaints the dial {c}')
    if os.environ.get('SHOTS'): await pg.screenshot(path=os.environ['SHOTS'] + '/vu-now.png')
    # «Auto» 0 VU follows what is played: the needle averages around −6 VU and rarely reaches the red,
    # however hot the master (the mock stream is a loud, pumping signal)
    await pg.evaluate("import('/theme/js/settings.js').then(S => S.setSetting('vuStyle', 'classic'))")
    for gain in (1.0, 3.0):
        await pg.evaluate(f"window.__streamGain = {gain}"); await pg.wait_for_timeout(7000)
        vus = []
        for _ in range(30):
            d = await pg.evaluate("import('/theme/js/vu.js').then(V => V._debug())"); vus.append(sum(d['vu']) / 2); await pg.wait_for_timeout(100)
        mean = sum(vus) / len(vus); red = sum(1 for v in vus if v > 1) / len(vus)
        check(-10.5 < mean < -3.5 and red < 0.15, f'auto 0 VU, stream ×{gain}: mean {mean:.1f} VU, in the red {red:.0%} (ref {d["ref"]:.1f} dBFS)')
    await pg.evaluate("window.__streamGain = 1")
    await pg.evaluate("import('/theme/js/settings.js').then(S => S.setSetting('vuCal', -18))"); await pg.wait_for_timeout(300)
    check((await pg.evaluate("import('/theme/js/vu.js').then(V => V._debug())"))['ref'] == -18, 'a fixed reference is used as it is')
    await pg.evaluate("import('/theme/js/settings.js').then(S => S.setSetting('vuMeters', false))"); await pg.wait_for_timeout(400)
    check(not await pg.evaluate("!!document.querySelector('.vu-box')") and await pg.evaluate("getComputedStyle(document.getElementById('viz')).display") != 'none', 'off again: the spectrum is back')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def test_smart_color_radio(browser, port):
    print('· smart playlists, colour wall, radio')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await pg.wait_for_timeout(500)
    # smart playlist from a recipe
    await pg.click('#btnNewPl'); await pg.wait_for_timeout(300)
    await pg.click("#layer .menu .mi:has-text('Smart playlist')"); await pg.wait_for_timeout(500)
    check(await pg.evaluate("document.querySelector('.sp-veil').classList.contains('on') && document.querySelectorAll('.sp-card:not(.ai)').length") == 11, 'the smart playlist sheet offers eleven recipes')
    check(await pg.evaluate("document.querySelectorAll('.sp-card.ai').length") == 8, 'and eight made by sound (neural analysis)')
    await pg.click(".sp-card[data-id=ai-calm]"); await pg.wait_for_timeout(300)
    check('sound analysis' in (await pg.inner_text('.sp-form')).lower(), 'with the analysis off, a sound recipe points to the setting')
    await pg.click(".sp-card[data-id=genre]"); await pg.wait_for_timeout(500)
    await choose(pg, '.sp-genre', 'Ambient'); await pg.wait_for_timeout(700)
    check('137' in await pg.inner_text('.sp-count'), 'it shows how many tracks match right now')
    check('Low Tide' in await pg.inner_text('.sp-preview'), 'and a few of them')
    check(await pg.input_value('.sp-name') == 'Ambient', 'and names the playlist after the choice')
    await pg.click('.sp-go'); await pg.wait_for_timeout(700)
    auto = await pg.evaluate("window.__more.auto")
    check(auto and auto[-1]['query'] == 'genre IS "Ambient"' and auto[-1]['name'] == 'Ambient', f'an autoplaylist is created with the right query {auto[-1:]}')
    check(await pg.evaluate("document.querySelector('.view.active')?.id") == 'view-playlist', 'and opened')
    await pg.click('#btnNewPl'); await pg.wait_for_timeout(300); await pg.click("#layer .menu .mi:has-text('Smart playlist')"); await pg.wait_for_timeout(400)
    await pg.click(".sp-card[data-id=recent]"); await pg.wait_for_timeout(200); await pg.click(".sp-param .seg button:has-text('7 days')"); await pg.wait_for_timeout(600)
    check('foo_playcount' in await pg.inner_text('.sp-count'), 'recipes that need play statistics say so when nothing matches')
    await pg.click('.sp-go'); await pg.wait_for_timeout(600)
    check(await pg.evaluate("window.__more.auto.at(-1).query") == '%added% DURING LAST 7 DAYS SORT DESCENDING BY %added%', 'newest first through a SORT clause')
    # two «Eternity» by unrelated artists in one flat folder stay two albums
    await nav(pg, 'library', 1500)
    await pg.fill('#libFilter', 'Eternity'); await pg.wait_for_timeout(800)
    eters = await pg.evaluate("[...document.querySelectorAll('#libGrid .tile')].map(t => t.innerText.replace(/\\s+/g, ' '))")
    check(len(eters) == 2 and any('Anathema' in e for e in eters) and any('Kamelot' in e for e in eters), f'same-titled albums of different artists are not merged {eters}')
    await pg.fill('#libFilter', ''); await pg.wait_for_timeout(500)
    # colour wall
    await choose(pg, '#libSort', 'color'); await pg.wait_for_timeout(4500)
    check(await pg.evaluate("!document.querySelector('#libRibbon').hidden"), 'sorting by cover colour shows the colour ribbon')
    n_all = await pg.evaluate("document.querySelectorAll('#libGrid .tile').length")
    labels = await pg.evaluate("[...document.querySelectorAll('#libRibbon .cr-b span')].map(s => s.textContent)")
    check(labels[:3] == ['Red', 'Orange', 'Yellow'] and len(labels) == 12 and labels[-1] == 'Black', f'every colour is named {labels}')
    await pg.click("#libRibbon .cr-b[data-c='pink']"); await pg.wait_for_timeout(800)
    n_red = await pg.evaluate("document.querySelectorAll('#libGrid .tile').length")
    check(0 < n_red < n_all, f'a colour keeps only covers of that colour ({n_red} of {n_all})')
    names = await pg.evaluate("[...document.querySelectorAll('#libGrid .tile')].map(t => t.innerText.split('\\n')[0])")
    print('    pink:', sorted(set(names)))
    check(any('Nightdrive' in x for x in names), f'the pink sunset of Nightdrive is pink {names[:4]}')
    if os.environ.get('SHOTS'): await pg.screenshot(path=os.environ['SHOTS'] + '/colorwall.png')
    # radio: similar artists, then the ones that also sound alike
    await nav(pg, 'now', 900)
    # the next track of the same album plays: the radio is that track's (the button was drawn for the first one)
    nxt = await pg.evaluate("(async () => { const i = (await fb2k.invoke('playback.getCurrentTrackIndex')).index; const a = window.__track(i), b = window.__track(i + 1); window.__emit('playback:trackChanged', b); return a.album === b.album ? b : null; })()")
    await pg.wait_for_timeout(900)
    await pg.click("#npActions .btn:has-text('Radio')"); await pg.wait_for_timeout(3000)
    toast = await pg.evaluate("[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')")
    for _ in range(20):
        await pg.wait_for_timeout(1000)
        if len((await pg.evaluate("window.__more.radio") or {}).get('handles', [])) >= 15: break
    r = await pg.evaluate("window.__more.radio")
    check(nxt and r and r['handles'][0] == nxt['absolutePath'], f'the radio starts from the track playing now, not the first one played from the album ({nxt and nxt["title"]})')
    check(r and nxt and r['name'] == f"Radio: {nxt['title']} — Lumen Arcade", f'and is named after it ({r and r["name"]})')
    check(r and len(r['handles']) >= 15, f'radio builds a playlist from the library ({r and len(r["handles"])} tracks)')
    arts = await pg.evaluate("(() => { const all = window.__edit.rows || []; return window.__more.radio.handles.map(h => (all.find(t => t.absolutePath === h) || {}).albumArtist); })()")
    harsh = sum(1 for a in arts if a in ('Blue Hours', 'Fern Assembly'))
    check(arts and arts[0] == 'Lumen Arcade', 'it starts with the seed track')
    check(harsh <= len(arts) * 0.25, f'artists whose music sounds different stay rare ({harsh} of {len(arts)}: {sorted(set(arts))})')
    check('Mirage Theory' in arts, 'a similar artist that also sounds alike is played')
    check(all(arts[i] != arts[i + 1] for i in range(1, len(arts) - 1)), 'never the same artist twice in a row')
    check('Unknown Elsewhere' not in arts, 'only artists you have')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

ML_FAKE = ROOT / 'tests' / '.ml-fake'
async def test_sound_offer(browser, port):
    print('· the sound analysis is offered once')
    ctx, pg, errs = await page(browser, port, {'language': 'en'}, pre="window.__offerTest = 1; if (!sessionStorage.getItem('o')) { sessionStorage.setItem('o', 1); localStorage.setItem('gatefold.soundOffer.wait', '1500'); }")
    await pg.wait_for_timeout(3500)
    card = await pg.evaluate("document.querySelector('.snd-offer')?.innerText || ''")
    check('listen to your music' in card and 'Turn on' in card and 'Not now' in card, f'a card offers it a while after the start {card[:70]!r}')
    await pg.click('.snd-offer [data-a=on]'); await pg.wait_for_timeout(500)
    check(await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1')).soundAI") is True, '«Turn on» turns the analysis on')
    await pg.reload(); await pg.wait_for_timeout(3500)
    check(not await pg.evaluate("!!document.querySelector('.snd-offer')"), 'and it is never offered again')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await pg.wait_for_timeout(2500)
    check(not await pg.evaluate("!!document.querySelector('.snd-offer')"), 'not offered when it was offered before')
    await ctx.close()

async def test_similar_albums(browser, port):
    print('· albums that sound alike (album page)')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await pg.evaluate("(async () => { const L = await import('/theme/js/library.js'); const a = (await L.getAllAlbums())[0]; (await import('/theme/js/ui.js')).router.go('album', a); })()"); await pg.wait_for_timeout(1500)
    txt = await pg.evaluate("document.getElementById('albumSimilar').innerText")
    check('Sounds like' in txt and 'Sound analysis' in txt, f'without the analysis: what it would show and where to turn it on {txt[:80]!r}')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def test_sound_ai(browser, port):
    print('· sound analysis (neural network, stand-in models)')
    if not (ML_FAKE / 'models' / 'manifest.json').exists():
        import subprocess; subprocess.run([sys.executable, str(ROOT / 'tools' / 'ml' / 'fake_assets.py'), str(ML_FAKE)], check=True)
    served = []
    async def setup(ctx):
        async def raw(route):
            name = route.request.url.split('/models/')[-1]; served.append(name)
            f = ML_FAKE / 'models' / name
            if f.exists(): await route.fulfill(status=200, body=f.read_bytes(), headers={'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream'})
            else: await route.fulfill(status=404, body='')
        await ctx.route('https://raw.githubusercontent.com/**', raw)
    ctx, pg, errs = await page(browser, port, {'language': 'en', 'soundAI': True}, setup=setup, pre="localStorage.setItem('gatefold.ml.pace', '0'); Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })")
    await nav(pg, 'settings', 800)
    await pg.evaluate("document.querySelector('#st-sound').scrollIntoView()")
    # up to three minutes: on a busy machine (parts running side by side) the analysis takes longer; it
    # stops waiting as soon as the status says Done
    for _ in range(180):
        st = await pg.evaluate("document.getElementById('sndStatus')?.innerText || ''")
        if 'Done' in st: break
        await pg.wait_for_timeout(1000)
    check('Done: 143' in st, f'every track of the library gets analysed ({st[:120]})')
    check('manifest.json' in served and 'discogs-effnet.onnx' in served and 'ort-wasm-simd-threaded.wasm' in served, f'the models come from the ml-assets branch {served[:5]}')
    check('ms' in await pg.evaluate("(e => e.dataset.tip || e.title)(document.getElementById('sndStatus'))"), 'the cost per track is on the status tooltip')
    if os.environ.get('SHOTS'): await pg.screenshot(path=os.environ['SHOTS'] + '/sound-settings.png')
    # «Maximum» speed: several networks; the libraries' remaining tracks still get analysed
    await pg.click("#st-sound .seg button:has-text('Maximum')"); await pg.wait_for_timeout(300)
    check(await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1')).soundSpeed") == 'max', 'the analysis speed is a setting')
    w = await pg.evaluate("(async () => { const S = await import('/theme/js/ml/sound.js'); S.prioritize(S.all().slice(0, 30).map(r => ({ absolutePath: r.p + '.x', duration: 200, title: 'x' }))); await new Promise(r => setTimeout(r, 3000)); return S.state.workers; })()")
    check(w >= 2, f'«Maximum» runs several networks at once ({w})')
    await pg.click("#st-sound .seg button:has-text('Normal')"); await pg.wait_for_timeout(300)
    # chips on Now Playing: genres from MusicBrainz (album first, then artist), ordered by the sound
    await nav(pg, 'now', 1200)
    for _ in range(30):
        chips = await pg.evaluate("[...document.querySelectorAll('#npBadges .chip.ai')].map(c => [c.textContent, c.title])")
        if any(c[0] in ('Outrun', 'Synthwave') for c in chips): break
        await pg.wait_for_timeout(1000)
    check(chips and chips[0][0] in ('Outrun', 'Synthwave') and 'MusicBrainz' in chips[0][1], f'Now Playing shows the genre from MusicBrainz {chips[:2]}')
    check(any('Network:' in c[1] for c in chips), 'and what the network hears, on hover')
    mb = await pg.evaluate("window.__mbCalls.length")
    check(mb >= 3, f'MusicBrainz is asked by artist name ({mb} requests)')
    # an artist MusicBrainz does not know gets the genres of the artists that sound like it
    for _ in range(40):
        g = await pg.evaluate("(async () => { const S = await import('/theme/js/ml/sound.js'); const G = await import('/theme/js/ml/genres.js'); const r = S.all().find(x => x.aa === 'Тихий Час'); return r ? G.describe({ albumArtist: 'Тихий Час', album: r.al }, r, 2) : []; })()")
        if g and g[0]['src'] == 'sound': break
        await pg.wait_for_timeout(1000)
    check(g and g[0]['src'] == 'sound' and g[0]['name'] in ('Synthwave', 'Outrun', 'Dark Ambient'), f'unknown artists get the genres of close-sounding ones {g}')
    # similar tracks
    await pg.click("#npActions .btn:has-text('Similar')"); await pg.wait_for_timeout(1500)
    made = await pg.evaluate("window.__ml.created")
    sim = made[-1] if made else None
    check(sim and sim['name'].startswith('Like «') and len(sim['handles']) >= 10, f'«Similar» makes a playlist of close-sounding tracks ({sim and sim["name"]}, {sim and len(sim["handles"])})')
    arts = await pg.evaluate("(h) => { const all = window.__edit.rows || []; return h.map(x => (all.find(t => t.absolutePath === x) || {}).albumArtist); }", sim['handles'] if sim else [])
    check(arts and not any(a in ('Blue Hours', 'Fern Assembly') for a in arts), f'tracks that sound different are left out {arts}')
    per = {a: arts[1:].count(a) for a in set(arts[1:])}
    check(per and max(per.values()) <= 3, f'at most three tracks per artist {per}')
    # radio by sound
    await nav(pg, 'now', 900)
    await pg.click("#npActions .btn:has-text('Radio')"); await pg.wait_for_timeout(2500)
    toast = await pg.evaluate("[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')")
    for _ in range(25):
        await pg.wait_for_timeout(1000)
        if len((await pg.evaluate("window.__more.radio") or {}).get('handles', [])) >= 15: break
    print('    radio:', await pg.evaluate("(async () => { const R = (await import('/theme/js/radio.js'))._debug(); return R.planner ? R.planner.pool.map(p => p.name + ' ' + p.s.toFixed(2) + ' fit ' + p.fit.toFixed(2) + (p.dead ? ' dead' : '')).join(' | ') : 'no planner'; })()"))
    r = await pg.evaluate("window.__more.radio")
    arts = await pg.evaluate("(() => { const all = window.__edit.rows || []; return window.__more.radio.handles.map(h => (all.find(t => t.absolutePath === h) || {}).albumArtist); })()")
    harsh = sum(1 for a in arts if a in ('Blue Hours', 'Fern Assembly'))
    check(r and len(r['handles']) >= 15, f'the radio fills up ({r and len(r["handles"])})')
    check(harsh <= len(arts) * 0.1, f'tracks that sound different stay out ({harsh} of {len(arts)})')
    check(all(arts[i] != arts[i + 1] for i in range(1, len(arts) - 1)), 'never the same artist twice in a row')
    songs = await pg.evaluate("(async () => { const U = await import('/theme/js/ml/sound-ui.js'); return [['Mourning Heart - Interlude', 110], ['Im Fackelschein', 95], ['Intro', 300], ['Nocturne (Intro)', 260], ['Solitude', 470], ['Sunrise', 210]].map(([ti, du]) => U.isSong({ ti, du })); })()")
    check(songs == [False, False, False, False, True, True], f'intros, interludes and short pieces stay out of mood playlists {songs}')
    # «Instrumental» means no voice: a sung track never gets in on an average (the bug: vocal metal songs)
    inst = await pg.evaluate("""(async () => { const U = await import('/theme/js/ml/sound-ui.js'); const S = await import('/theme/js/ml/sound.js');
      const i = S.moodNames().indexOf('instrumental'); const rec = (mean, share, ti = 'Song') => { const m = new Uint8Array(9).fill(128); m[i] = Math.round(mean * 255); const r = { ti, m }; if (share != null) { r.mq = new Uint8Array(9).fill(128); r.mq[i] = Math.round(share * 255); } return r; };
      return [U.instrumental(rec(0.55, 0.4)), U.instrumental(rec(0.7)), U.instrumental(rec(0.82, 0.8)), U.instrumental(rec(0.9)), U.instrumental(rec(0.95, 1)), U.instrumental(rec(0.2, 0.1, 'Song (Instrumental)')), U.instrumental(rec(0.92, 0.95), true)]; })()""")
    check(inst == [False, False, False, True, True, True, False], f'instrumental = the voice wins (almost) no part of the track, not «half instrumental» on average {inst}')
    # mood playlist from the smart playlist sheet
    await pg.click('#btnNewPl'); await pg.wait_for_timeout(300)
    await pg.click("#layer .menu .mi:has-text('Smart playlist')"); await pg.wait_for_timeout(400)
    await pg.click(".sp-card[data-id=ai-calm]"); await pg.wait_for_timeout(400)
    cnt = await pg.inner_text('.sp-count')
    check(re.search(r'\d', cnt) is not None, f'a mood recipe counts the matching tracks ({cnt})')
    await pg.click('.sp-go'); await pg.wait_for_timeout(1200)
    made = await pg.evaluate("window.__ml.created")
    check(made and made[-1]['name'] == 'Calm' and len(made[-1]['handles']) > 0, f'and makes the playlist ({made[-1:] and made[-1]["name"]})')
    await pg.click('#btnNewPl'); await pg.wait_for_timeout(300)
    await pg.click("#layer .menu .mi:has-text('Smart playlist')"); await pg.wait_for_timeout(400)
    await pg.click(".sp-card[data-id=ai-style]"); await pg.wait_for_timeout(400)
    n_st = await pg.evaluate("document.querySelector('.sp-style').options.length")
    check(n_st > 1, f'styles heard in the library are offered ({n_st - 1})')
    await pg.keyboard.press('Escape')
    # the context menu of a playlist row
    await nav(pg, 'playlist', 1200)
    await pg.click('#plList .vrow >> nth=2', button='right'); await pg.wait_for_timeout(400)
    check(await pg.locator("#layer .menu .mi:has-text('Similar-sounding tracks')").count() == 1, 'a track menu offers similar-sounding tracks')
    await pg.keyboard.press('Escape')
    # the album page: albums of other artists that sound alike
    await pg.evaluate("(async () => { const L = await import('/theme/js/library.js'); const a = (await L.getAllAlbums()).find(x => x.albumArtist === 'Lumen Arcade'); (await import('/theme/js/ui.js')).router.go('album', a); })()")
    for _ in range(15):
        sim = await pg.evaluate("[...document.querySelectorAll('#albumSimilar .sim-tile')].map(e => e.title)")
        if sim: break
        await pg.wait_for_timeout(500)
    check(sim and not any(x.startswith('Lumen Arcade') for x in sim), f'«Sounds like» lists albums of other artists {sim[:3]}')
    if sim:
        await pg.click('#albumSimilar .sim-tile >> nth=0'); await pg.wait_for_timeout(1200)
        check(await pg.evaluate("document.querySelector('#albumHero h1').textContent") in [x.split(' — ', 1)[1] for x in sim[:1]], 'a click opens that album')
    # turning it off and removing everything
    await nav(pg, 'settings', 800)
    await pg.evaluate("document.querySelector('#st-sound').scrollIntoView()")
    await pg.click("#st-sound .btn:has-text('Remove data')"); await pg.wait_for_timeout(1200)
    left = await pg.evaluate("(async () => { const m = await import('/theme/js/idb.js'); return [(await m.getAll('sound')).length, await m.kvGet('ml.manifest', null)]; })()")
    check(left[0] == 0 and left[1] is None, f'«Remove» deletes the results and the models {left[0]}')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

MONKEY_PICK = r"""((seed, seen) => {
  let x = seed >>> 0; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const bad = /удал|remove|delete|reset|сброс|очист|clear|uninstall|rescan|переска|install|установ|откат|rollback|выход|quit|exit|close|закр|свернуть|minimi|maximi|развернуть|youtube\.com|github|папк|folder|файл|file|import|импорт/i;
  const els = [...document.querySelectorAll('button, [role=button], .tile, .atile, .vrow, .vtile, .pl-item, [data-go], .mi, .chip, .seg button, label.switch, .sw, .nav-item, .tab, [data-tab]')]
    .filter((e) => { const r = e.getBoundingClientRect(); if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
      if (e.closest('#winctl, .win-controls, .titlebar-controls') || /^btn(Close|Min|Max)$/.test(e.id)) return false;
      const t = (e.textContent || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.dataset.tip || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.id || '');
      if (bad.test(t)) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.pointerEvents !== 'none'; });
  if (!els.length) return null;
  const key = (e) => (e.id || e.className || e.tagName).toString().slice(0, 40);
  // a few random candidates; the least clicked kind wins, so one big grid does not eat the run
  let e = null; for (let k = 0; k < 4; k++) { const c = els[Math.floor(rnd() * els.length)]; if (!e || (seen[key(c)] || 0) < (seen[key(e)] || 0)) e = c; }
  const r = e.getBoundingClientRect();
  return { x: r.left + r.width * (0.3 + rnd() * 0.4), y: r.top + r.height * (0.3 + rnd() * 0.4), what: key(e) };
})"""

async def test_stability(browser, port):
    print('· stability: mouse after a drag, random clicking, track-change storm, leaks')
    pre = "window.__rej = []; addEventListener('unhandledrejection', (e) => window.__rej.push(String(e.reason && (e.reason.stack || e.reason))));"
    ctx, pg, errs = await page(browser, port, {'language': 'en'}, pre=pre)
    cons = []
    pg.on('console', lambda m: cons.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    missing = []
    pg.on('response', lambda r: missing.append(r.url) if r.status >= 400 and '/theme/' in r.url else None)
    # 1. native drag-and-drop never starts from the page (it froze clicks in foo_ui_webview2)
    await nav(pg, 'library', 1500)
    r = await pg.evaluate("""(() => { const img = document.querySelector('#view-library img, .tile img, img');
      if (!img) return null; const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true }); img.dispatchEvent(ev);
      const a = document.createElement('a'); a.href = '#x'; a.textContent = 'x'; document.body.appendChild(a); const ev2 = new DragEvent('dragstart', { bubbles: true, cancelable: true }); a.dispatchEvent(ev2); a.remove();
      return { img: ev.defaultPrevented, link: ev2.defaultPrevented, css: getComputedStyle(img).webkitUserDrag }; })()""")
    check(r and r['img'] and r['link'] and r['css'] == 'none', f'dragging a cover or a link never starts a native drag {r}')
    t = await pg.evaluate("(() => { const e = document.querySelector('#view-library .tile'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 3]; })()")
    if t:
        await pg.mouse.move(t[0], t[1]); await pg.mouse.down(); await pg.mouse.move(t[0] + 40, t[1] + 30, steps=8); await pg.mouse.move(t[0] + 160, t[1] + 90, steps=8); await pg.mouse.up()
        await pg.wait_for_timeout(400)
        b = await pg.evaluate("(() => { const r = document.querySelector('.nav-item[data-view=queue]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        await pg.mouse.click(b[0], b[1]); await pg.wait_for_timeout(900)
        check(await pg.evaluate("document.querySelector('.view.active')?.id") == 'view-queue', 'a real click works right after pulling a cover around')
    # files dragged over the window from Explorer: the overlay never outlives the drag, even if the leave is lost
    ENTER = "(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.flac')); document.querySelector('#view-' + (document.querySelector('.view.active').id.slice(5))).dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt })); return document.body.classList.contains('dragging'); })()"
    check(await pg.evaluate(ENTER), 'files over the window show the drop overlay')
    await pg.wait_for_timeout(2200)
    check(not await pg.evaluate("document.body.classList.contains('dragging')"), 'it goes away by itself when the drag stops coming (a lost dragleave)')
    await pg.evaluate(ENTER); await pg.mouse.move(700, 400); await pg.mouse.move(720, 420); await pg.wait_for_timeout(100)
    check(not await pg.evaluate("document.body.classList.contains('dragging')"), 'or as soon as the mouse moves normally again')
    # 2. random clicking (seeded, repeatable), with Escape now and then
    base_nodes = None
    for v in VIEWS: await nav(pg, v, 500)
    await nav(pg, 'now', 800)
    base_nodes = await pg.evaluate("document.getElementsByTagName('*').length")
    seed, done, log, reloads = int(os.environ.get("MONKEY_SEED", 20261020)), 0, [], []
    for i in range(int(os.environ.get("MONKEY_N", 320))):
        if i % 40 == 0:
            await nav(pg, VIEWS[(i // 40) % len(VIEWS)], 450)
        if i % 9 == 8:
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(60); continue
        try: p = await pg.evaluate(MONKEY_PICK + f"({seed + i}, {json.dumps(dict(Counter(log)))})")
        except Exception:   # a click reloaded the page (e.g. the language switch): fine, carry on
            reloads.append(log[-1] if log else '?'); await pg.wait_for_load_state(); await pg.wait_for_timeout(1500); continue
        if not p: continue
        log.append(p['what'])
        await pg.mouse.click(p['x'], p['y'], button='right' if i % 17 == 16 else 'left'); done += 1
        await pg.wait_for_timeout(70)
        if pg.url.split('?')[0].split('#')[0] != f'http://127.0.0.1:{port}/theme/index.html': break
    for _ in range(4): await pg.keyboard.press('Escape'); await pg.wait_for_timeout(120)
    check(done > int(os.environ.get("MONKEY_N", 320)) * 0.6, f'random clicking ran ({done} clicks)')
    bad_nav = []
    for v in VIEWS:
        await nav(pg, v, 600)
        if await pg.evaluate("document.querySelector('.view.active')?.id") != 'view-' + v: bad_nav.append(v)
        # nothing invisible sits over the screen and eats the clicks
        hit = await pg.evaluate("(() => { const a = document.querySelector('.view.active'); const r = a.getBoundingClientRect(); const pts = [[.5, .5], [.25, .3], [.75, .7]]; return pts.map(([fx, fy]) => { const e = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy); return !e || a.contains(e) || e.closest('#toasts, .toast') ? '' : (e.id || e.className || e.tagName); }).filter(Boolean); })()")
        if hit: bad_nav.append(f'{v}: covered by {hit}')
    check(not bad_nav, f'every screen still opens after random clicking {bad_nav} (last clicks: {log[-6:]})')
    # 3. track-change storm: the last track wins, nothing throws
    n = await pg.evaluate("window.fb2k.invoke('playlist.getActive').then((r) => r.trackCount)")
    for i in range(60):
        await pg.evaluate(f"window.__emit('playback:trackChanged', window.__track({i % n}))"); await pg.wait_for_timeout(15)
    await pg.wait_for_timeout(1500)
    want = await pg.evaluate(f"window.__track({59 % n}).title")
    check(await pg.inner_text('#pbTitle') == want, f'after 60 quick track changes the player bar shows the last one ({want})')
    # 4. leaks: walking every screen five more times does not keep growing the page
    await nav(pg, 'now', 800)
    a = await pg.evaluate("document.getElementsByTagName('*').length")
    for _ in range(5):
        for v in VIEWS: await nav(pg, v, 250)
    await nav(pg, 'now', 1200)
    b2 = await pg.evaluate("document.getElementsByTagName('*').length")
    check(b2 <= a * 1.15 + 200, f'DOM size stays flat over 40 screen changes ({base_nodes} → {a} → {b2})')
    rej = await pg.evaluate("window.__rej")
    check(not errs, f'no page errors {errs[:3]}')
    check(not rej, f'no unhandled promise rejections {rej[:3]}')
    check(not cons, f'no console errors {cons[:3]}')
    check(not missing, f'no missing files {sorted(set(missing))[:5]}')
    print('    reloads after:', reloads)
    print('    clicked:', Counter(log).most_common(12))
    await ctx.close()

async def test_layout(browser, port):
    print('· layout: nothing overlaps (every screen, large text, narrow and wide windows; mini player, Canvas window)')
    import time
    audit = (FIX / 'overlap-audit.js').read_text(encoding='utf-8').split('\n', 2)[2]
    found = {}
    async def run_audit(pg, where):
        # each look has its own time limit: a slow or stuck one is reported by place, the rest go on
        try:
            for x in await asyncio.wait_for(pg.evaluate(audit), 45): found.setdefault(x, where)
        except asyncio.TimeoutError: found.setdefault(f'the check itself took over 45 s', where)
    for lang in ('ru', 'en'):
        ctx, pg, errs = await page(browser, port, {'language': lang, 'baseSize': 20})
        for w in (820, 1280):
            t0 = time.time()
            await pg.set_viewport_size({'width': w, 'height': 860}); await pg.wait_for_timeout(300)
            for v in VIEWS + ['lyrics', 'smart']:
                if v == 'lyrics':
                    await nav(pg, 'now', 500); await pg.evaluate("document.querySelector('[data-tab=lyrics]')?.click()"); await pg.wait_for_timeout(700)
                elif v == 'smart':
                    await pg.evaluate("import('/theme/js/smartpl.js').then(m => m.open('ai-instrumental'))"); await pg.wait_for_timeout(700)
                else:
                    await nav(pg, v, 600)
                for step in range(6):
                    await run_audit(pg, f'{lang}/{w}/{v}')
                    more = await pg.evaluate("(() => { const a = document.querySelector('.view.active'); const sc = [a, ...a.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)); if (!sc || sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) return false; sc.scrollTop += sc.clientHeight * 0.8; return true; })()")
                    if not more or v == 'smart': break
                    await pg.wait_for_timeout(150)
                if v == 'smart': await pg.keyboard.press('Escape'); await pg.wait_for_timeout(250)
            print(f'    {lang} {w}px: {time.time() - t0:.0f} s, {len(found)} finding(s) so far', flush=True)
        check(not errs, f'{lang}: no page errors {errs[:2]}')
        await ctx.close()
    for pagefile, sizes in (('mini.html', [(240, 72), (320, 90), (400, 200)]), ('canvas.html', [(480, 300), (900, 560)])):
        for (w, h) in sizes:
            ctx = await browser.new_context(viewport={'width': w, 'height': h}); pg = await ctx.new_page()
            await pg.add_init_script("localStorage.setItem('aurora.settings.v1', JSON.stringify({language: 'ru', baseSize: 20}));" + MOCK)
            await pg.goto(f'http://127.0.0.1:{port}/theme/{pagefile}'); await pg.wait_for_timeout(1500)
            await pg.mouse.move(w / 2, h / 2); await pg.wait_for_timeout(200)
            await run_audit(pg, f'{pagefile} {w}×{h}')
            await ctx.close()
        print(f'    {pagefile}: done', flush=True)
    for k, v in found.items(): print(f'    {k}  @ {v}', flush=True)
    check(not found, f'no text or control overlaps another, sticks out of its box or is cut ({len(found)} finding(s), listed above)')

async def timed(name, coro, limit=int(os.environ.get('TEST_TIMEOUT', 480))):
    # a test that hangs fails by name instead of holding the whole run (page.evaluate has no timeout)
    import time
    t0 = time.time()
    try: await asyncio.wait_for(coro, limit)
    except asyncio.TimeoutError: check(False, f'{name}: still running after {limit} s — stopped')
    print(f'  ({time.time() - t0:.0f} s)', flush=True)

async def test_lyrics_sync(browser, port):
    print('· lyrics follow the fine position (timeHighRes), not the whole-second playback:time')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await nav(pg, 'now', 1200)
    await pg.evaluate("document.querySelector('[data-tab=lyrics]').click()"); await pg.wait_for_timeout(1500)
    cur = "[...document.querySelectorAll('#lyrBox .ln')].findIndex(n => n.classList.contains('cur'))"
    pos = "import('/theme/js/viz.js').then(V => V.getPosition())"
    async def emit(ev, d, wait=250):
        await pg.evaluate(f"window.__emit({json.dumps(ev)}, Object.assign({json.dumps(d)}, {{ hostTime: Date.now() - ({d.get('lagMs', 0)}) }}))"); await pg.wait_for_timeout(wait)
    await emit('playback:timeHighRes', {'position': 52.0})
    check(await pg.evaluate(cur) == 10, f'a fine sample at 52 s puts the 50 s line on (line {await pg.evaluate(cur)})')
    await emit('playback:time', {'position': 58})
    check(await pg.evaluate(cur) == 10, 'a whole-second playback:time does not move the lyrics while the fine stream is alive')
    await emit('playback:seeked', {'position': 120}, 50)
    await emit('playback:timeHighRes', {'position': 52.4})
    check(await pg.evaluate(cur) == 24, f'a sample still carrying the old position right after a seek is ignored (line {await pg.evaluate(cur)})')
    await pg.wait_for_timeout(700)
    await emit('playback:timeHighRes', {'position': 100.0, 'lagMs': 400}, 0)
    p = await pg.evaluate(pos)
    check(100.35 <= p < 100.8, f'hostTime: the delivery delay is added ({p:.2f})')
    await ctx.close()
    ctx, pg, errs2 = await page(browser, port, {'language': 'en'})
    await nav(pg, 'now', 1200)
    await pg.evaluate("document.querySelector('[data-tab=lyrics]').click()"); await pg.wait_for_timeout(1500)
    await pg.evaluate("window.__emit('playback:time', { position: 70 })"); await pg.wait_for_timeout(250)
    check(await pg.evaluate(cur) == 14, 'without timeHighRes (an older component) playback:time still drives the lyrics')
    check(not errs and not errs2, f'no page errors {(errs + errs2)[:2]}')
    await ctx.close()

async def test_level(browser, port):
    print('· volume levelling: foobar2000 settings, whole albums, tags written and read back')
    ctx, pg, errs = await page(browser, port, {'language': 'en'}, pre='window.__levelTest = true;')
    await nav(pg, 'settings', 900)
    await pg.evaluate("document.getElementById('st-level').scrollIntoView()")
    check(await pg.evaluate("!!document.querySelector('#st-level input[type=checkbox]')"), 'Settings has a «Volume levelling» switch')
    await pg.evaluate("document.querySelector('#st-level .toggle input').click()"); await pg.wait_for_timeout(800)
    calls = await pg.evaluate("window.__calls.filter(c => /^replaygain\\.set/.test(c[0])).map(c => c[0] + ' ' + c[1])")
    check(any('"sourceMode":"album"' in c and '"processingMode":"gain_and_peak"' in c for c in calls), f'turning it on sets album gain with clipping prevention {calls}')
    check(any('"withRg":0' in c and '"withoutRg":-9' in c for c in calls), f'preamp for −18 LUFS: 0 dB with tags, −9 dB without {calls}')
    check(await pg.evaluate("localStorage.getItem('gatefold.level.prev')") is not None, "foobar2000's own ReplayGain settings are saved first")
    for _ in range(90):
        await pg.wait_for_timeout(1000)
        ph = await pg.evaluate("import('/theme/js/loudness.js').then(L => L.state.phase)")
        if ph in ('waiting', 'done', 'error'): break
    st = await pg.evaluate("import('/theme/js/loudness.js').then(L => ({ ...L.state }))")
    check(st['phase'] == 'done', f"done ({st['phase']}, {st.get('error')})")
    T = await pg.evaluate("window.__level.tags")
    g = lambda p, f: float(T.get(p.lower(), {}).get(f, 'nan').split()[0]) if f in T.get(p.lower(), {}) else None
    nd = ['D:\\Music\\Night Drive\\CD1\\01.flac', 'D:\\Music\\Night Drive\\CD1\\02 Interlude.flac', 'D:\\Music\\Night Drive\\CD2\\01.flac']
    ag = [g(p, 'REPLAYGAIN_ALBUM_GAIN') for p in nd]
    check(None not in ag and len(set(ag)) == 1, f'one album over two disc folders: one album gain on every track {ag}')
    tg = g(nd[1], 'REPLAYGAIN_TRACK_GAIN')
    check(ag[0] is not None and -12.2 < ag[0] < -11.0, f'album gain from the whole album, the quiet interlude gated out like the standard says ({ag[0]})')
    check(tg is not None and 11.8 < tg < 13.0 and tg - ag[1] > 20, f'the interlude keeps its place: its own track gain would be {tg}, it gets the album gain {ag[1]}')
    mx = [g(f'D:\\Music\\Mixtape\\0{i}.flac', 'REPLAYGAIN_ALBUM_GAIN') for i in (1, 2, 3)]
    check(None not in mx and len(set(mx)) == 1, f'a compilation with an artist per track stays one album {mx}')
    la = g('D:\\Music\\Live\\Alpha 1.flac', 'REPLAYGAIN_ALBUM_GAIN'); lb = g('D:\\Music\\Live\\Beta 1.flac', 'REPLAYGAIN_ALBUM_GAIN')
    check(la is not None and lb is not None and abs(la - lb) > 10, f'one title by two album artists in one folder: two albums ({la} / {lb})')
    sg = (g('D:\\Music\\Singles\\One.flac', 'REPLAYGAIN_TRACK_GAIN'), g('D:\\Music\\Singles\\One.flac', 'REPLAYGAIN_ALBUM_GAIN'))
    check(sg[0] is not None and sg[0] == sg[1], f'a single: album gain = track gain {sg}')
    W = await pg.evaluate("window.__level.writes.map(w => w.path)")
    check(not any('Tagged' in w for w in W), 'tracks that already have every value are left alone')
    pa = [g(f'D:\\Music\\Partial\\{n}.flac', 'REPLAYGAIN_ALBUM_GAIN') for n in ('01', '02', '03 Bonus')]
    cl = await pg.evaluate("window.__level.cleared")
    check(None not in pa and len(set(pa)) == 1 and pa[0] != -3.0, f'a bonus track added to a scanned album: the whole album is measured again, one new album gain {pa}')
    check(len(cl) == 2 and all('Partial' in c for c in cl), f'old values are cleared before the new ones are written (no two album gains in a file) {cl}')
    pk = T.get(nd[0].lower(), {}).get('REPLAYGAIN_ALBUM_PEAK')
    check(pk is not None and 0.49 < float(pk) < 0.52, f'album peak = the loudest true peak of the album ({pk})')
    op = T.get('d:\\music\\opusalb\\01.opus', {})
    check(op.get('R128_ALBUM_GAIN') == str(round((float(op.get('REPLAYGAIN_ALBUM_GAIN', 'nan').split()[0]) - 5) * 256)), f'Opus also gets R128_ALBUM_GAIN (Q7.8, −23 LUFS reference) {op}')
    check(st['unwritable'] == 2, f"a format whose tags do not keep the values is counted, not retried ({st['unwritable']})")
    playing = await pg.evaluate("window.__level.playing")
    dec = await pg.evaluate("window.__level.decoded")
    check(dec and dec[0].lower() == playing.lower(), f'the playing track is measured first {dec[:2]}')
    check(any(w.lower() == playing.lower() for w in W), 'the playing album gets its values at once (its next tracks play levelled)')
    txt = await pg.inner_text('#lvlStatus')
    check('failed: 2' in txt, f'the status line counts what could not be written ({txt!r})')
    # off: foobar2000's settings come back
    await pg.evaluate("window.__calls.length = 0")
    await pg.evaluate("document.querySelector('#st-level .toggle input').click()"); await pg.wait_for_timeout(800)
    calls = await pg.evaluate("window.__calls.filter(c => /^replaygain\\.set/.test(c[0])).map(c => c[0] + ' ' + c[1])")
    check(any('"withoutRg":-6' in c for c in calls), f'turning it off puts back the previous preamp {calls}')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

async def test_album_details(browser, port):
    print('· album details: off by default, a button / the track count / I, facts and columns that fit')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    async def open_album(name):
        await nav(pg, 'library', 2200)
        await pg.evaluate(f"[...document.querySelectorAll('#libGrid .tile')].find(t => t.querySelector('.tt')?.textContent === {json.dumps(name)})?.click()")
        await pg.wait_for_timeout(1300)
    await open_album('Nightdrive')
    check(not await pg.evaluate("document.getElementById('view-album').classList.contains('details')") and await pg.evaluate("document.getElementById('albumFacts').children.length") == 0, 'off by default: no card, the usual columns')
    head0 = await pg.evaluate("[...document.querySelectorAll('#view-album .list-head > div')].map(d => d.textContent)")
    check('Artist' in head0 and 'LUFS' not in head0, f'usual columns {head0}')
    await pg.click('#alDetails'); await pg.wait_for_timeout(900)
    facts = await pg.evaluate("[...document.querySelectorAll('#albumFacts .f')].map(f => [f.querySelector('.k').textContent, f.querySelector('.v').textContent])")
    F = dict(facts)
    check(F.get('Format') == 'FLAC 24/96' and F.get('Loudness') == '−9.8 LUFS' and F.get('Dynamics') == 'DR10' and 'Folder' in F, f'the card: format, loudness (from ReplayGain, with a real minus), DR, folder {facts}')
    check(len(facts) <= 10, f'at most nine facts and the folder ({len(facts)})')
    head = await pg.evaluate("[...document.querySelectorAll('#view-album .list-head > div')].map(d => d.textContent)")
    check('LUFS' in head and 'DR' in head and 'Artist' not in head, f'detailed columns; no artist column when every track is by the album artist {head}')
    geo = await pg.evaluate("""(() => {
      const row = document.querySelector('#albumList .vrow'), cells = [...row.children].filter(c => c.tagName === 'DIV'), hd = [...document.querySelectorAll('#view-album .list-head > div')];
      const card = document.getElementById('albumFacts').getBoundingClientRect(), hero = document.getElementById('albumHero').getBoundingClientRect(), cover = document.querySelector('#view-album .album-cover').getBoundingClientRect();
      const overlap = cells.some((c, i) => i && cells[i - 1].getBoundingClientRect().right > c.getBoundingClientRect().left + .5);
      const aligned = hd.every((h, i) => Math.abs(h.getBoundingClientRect().left - cells[i].getBoundingClientRect().left) < 2 || Math.abs(h.getBoundingClientRect().right - cells[i].getBoundingClientRect().right) < 2);
      const inCard = [...document.querySelectorAll('#albumFacts .f')].every(f => { const r = f.getBoundingClientRect(); return r.bottom <= card.bottom + 1 && r.right <= card.right + 1; });
      const heart = row.querySelector('.row-like').getBoundingClientRect(), gap = row.querySelector('.c-gap').getBoundingClientRect(), prev = row.querySelector('.c-gap').previousElementSibling.getBoundingClientRect();
      return { cells: cells.length, heads: hd.length, overlap, aligned, inCard, cardInHero: card.right <= hero.right + 1 && card.bottom <= cover.bottom + 2, heartClear: heart.left >= prev.right };
    })()""")
    check(geo['cells'] == geo['heads'] and not geo['overlap'] and geo['aligned'], f'head and cells line up, no cell runs into the next {geo}')
    check(geo['inCard'] and geo['cardInHero'], f'every fact inside the card, the card inside the header and no taller than the cover {geo}')
    check(geo['heartClear'], 'the heart on hover does not cover the plays column')
    check(await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1')).albumDetails") is True, 'the choice is remembered')
    calls0 = len(await pg.evaluate("window.__calls"))
    await pg.evaluate("document.querySelector('#albumFacts [data-act=folder]').click()"); await pg.wait_for_timeout(300)
    check(any(c[0] == 'shell.showInExplorer' for c in (await pg.evaluate("window.__calls"))[calls0:]), 'the folder fact opens the folder')
    # a bare album: only what it has
    await open_album('Sand & Signal')
    facts = await pg.evaluate("[...document.querySelectorAll('#albumFacts .f .k')].map(k => k.textContent)")
    head = await pg.evaluate("[...document.querySelectorAll('#view-album .list-head > div')].map(d => d.textContent)")
    check('Loudness' not in facts and 'Plays' not in facts and 'LUFS' not in head and 'DR' not in head, f'an album without ReplayGain, DR or plays shows none of them {facts} {head}')
    # off again from the track count, and on with I
    await pg.click('#albumMore'); await pg.wait_for_timeout(400)
    check(not await pg.evaluate("document.getElementById('view-album').classList.contains('details')"), 'a click on the track count turns it off')
    await pg.keyboard.press('i'); await pg.wait_for_timeout(700)
    check(await pg.evaluate("document.getElementById('view-album').classList.contains('details')"), 'I turns it on')
    # mixed formats, two discs, a compilation
    mix = await pg.evaluate("""import('/theme/js/album-details.js').then(AD => {
      const T = (codec, sr, disc, artist, br, size) => ({ codec, sampleRate: sr, discNumber: disc, artist, bitrate: br, duration: 200, fileSize: size, channels: 2, title: 't' });
      const tracks = [T('FLAC', 44100, 1, 'A', 900, 3e7), T('MP3', 44100, 1, 'B', 320, 8e6), T('FLAC', 96000, 2, 'C', 2800, 7e7)];
      const ext = [{ lossless: true, bits: 16 }, { lossless: false, prof: 'CBR' }, { lossless: true, bits: 24 }].map((x) => ({ dr: null, adr: null, tg: null, ag: null, plays: null, genre: 'Rock; Pop', ...x }));
      const f = AD.facts({ name: 'X', albumArtist: 'Various', year: '2001', firstTrackAbsolutePath: 'D:\\\\Music\\\\X\\\\01.flac' }, tracks, ext);
      const c = AD.columns({ albumArtist: 'Various' }, tracks, ext);
      return { f: Object.fromEntries(f.map((x) => [x.k, x.v])), head: c.head, fmt: tracks.map((t, i) => AD.trackFormat(t, ext[i])) };
    })""")
    check(mix['f'].get('Format', '').startswith('FLAC, MP3') and mix['f'].get('Discs') == '2' and 'Artist' in mix['head'], f'mixed formats, two discs, a compilation keeps its artist column {mix}')
    check(mix['fmt'] == ['FLAC 16/44.1', 'MP3 CBR', 'FLAC 24/96'], f'per-track formats {mix["fmt"]}')
    check(not errs, f'no page errors {errs[:2]}')
    await ctx.close()

# every test, in the order a full run takes them
async def test_editions_artists(browser, port):
    print('· editions and artists: one title in two releases, «A; B» and multi-value tags, the separators preview')
    ctx, pg, errs = await page(browser, port, {'language': 'en'}, pre='window.__eds = true;')
    await nav(pg, 'library', 2600)
    async def lib_filter(q):
        await pg.fill('#libFilter', q); await pg.wait_for_timeout(600)
    await lib_filter('Everybody')
    tiles = await pg.evaluate("[...document.querySelectorAll('#libGrid .tile')].filter(t => t.querySelector('.tt')?.textContent === 'Everybody Wants').map(t => t.querySelector('.ta').textContent)")
    check(sorted(tiles) == ['The Struts · 2014', 'The Struts · 2016 · Deluxe'], f'two tiles, each named by its edition {tiles}')
    await lib_filter('Long Way')
    long = await pg.evaluate("[...document.querySelectorAll('#libGrid .tile .tt')].filter(t => t.textContent === 'Long Way').length")
    check(long == 1, f'CD1/CD2 folders of one release stay one album ({long})')
    await lib_filter('Everybody')
    await pg.evaluate("[...document.querySelectorAll('#libGrid .tile')].find(t => t.querySelector('.ta')?.textContent.includes('Deluxe')).click()")
    await pg.wait_for_timeout(1300)
    ed = await pg.evaluate("document.querySelector('#albumHero .al-ed')?.textContent")
    rows = await pg.evaluate("[...document.querySelectorAll('#albumList .vrow .c-t, #albumList .vrow')].length && [...document.querySelectorAll('#albumList .vrow')].map(r => r.textContent)")
    check(ed == '2016 · Deluxe', f'the album page names the edition ({ed})')
    check(len(rows) == 4 and any('Mary Go Round' in r for r in rows) and not any('Kiss This' in r for r in rows), f'only the songs of this edition {rows}')
    other = await pg.evaluate("[...document.querySelectorAll('#albumHero .al-eds [data-ed]')].map(b => b.textContent)")
    check(other == ['2014'], f'«Other editions» links the 2014 release {other}')
    await pg.click('#albumHero .al-eds [data-ed]'); await pg.wait_for_timeout(1300)
    rows = await pg.evaluate("[...document.querySelectorAll('#albumList .vrow')].map(r => r.textContent)")
    check(await pg.evaluate("document.querySelector('#albumHero .al-ed')?.textContent") == '2014' and any('Kiss This' in r for r in rows) and len(rows) == 4, f'the link opens the other edition {rows}')
    # an album by «Alpha; Beta» links both, and is listed under each
    await nav(pg, 'library', 900)
    await lib_filter('Duets')
    await pg.evaluate("[...document.querySelectorAll('#libGrid .tile')].find(t => t.querySelector('.tt')?.textContent === 'Duets').click()"); await pg.wait_for_timeout(1200)
    links = await pg.evaluate("[...document.querySelectorAll('#albumArtistLink [data-ar]')].map(l => l.textContent)")
    check(links == ['Alpha', 'Beta'], f'the album page links each artist {links}')
    await pg.evaluate("document.querySelectorAll('#albumArtistLink [data-ar]')[1].click()"); await pg.wait_for_timeout(1200)
    check(await pg.evaluate("document.querySelector('#artistHero h1')?.textContent") == 'Beta', 'the second name opens its own page')
    await nav(pg, 'artists', 1500)
    names = await pg.evaluate("import('./js/artists.js').then(m => m.artistsState.list.map(x => x.name))")
    check(all(n in names for n in ['Alpha', 'Beta', 'Gamma', 'Delta', 'Simon & Garfunkel']) and 'Alpha; Beta' not in names, f'«;» and multi-value tags make separate artists, «&» is left alone by default {sorted(set(names))[:20]}')
    # the separators: «&» on → the preview lists the names it would split; one is kept whole
    await nav(pg, 'settings', 900)
    await pg.evaluate("document.getElementById('st-library').scrollIntoView()"); await pg.wait_for_timeout(300)
    await pg.evaluate("[...document.querySelectorAll('#st-library .seg.multi button')].find(b => b.textContent === '&').click()"); await pg.wait_for_timeout(300)
    pv = await pg.evaluate("[...document.querySelectorAll('#st-library .sep-pv-i')].map(i => i.querySelector('.nm').textContent + ' → ' + i.querySelector('.parts').textContent)")
    check('Simon & Garfunkel → Simon · Garfunkel' in pv, f'the preview shows what «&» would split {pv}')
    if os.environ.get('SHOTS'): await pg.screenshot(path=os.environ['SHOTS'] + '/separators.png')
    await pg.evaluate("[...document.querySelectorAll('#st-library .sep-pv-i')].find(i => i.querySelector('.nm').textContent === 'Simon & Garfunkel').querySelector('input').click()"); await pg.wait_for_timeout(200)
    await pg.evaluate("document.querySelector('#st-library .st-acts .btn.primary').click()"); await pg.wait_for_timeout(2500)
    st = await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1'))")
    check(st.get('artistSplit') == [';', '&'] and st.get('artistKeep') == ['Simon & Garfunkel'], f'applied and remembered {st.get("artistSplit")} {st.get("artistKeep")}')
    await nav(pg, 'artists', 1500)
    names = await pg.evaluate("import('./js/artists.js').then(m => m.artistsState.list.map(x => x.name))")
    check('Simon & Garfunkel' in names and 'Garfunkel' not in names, 'a name marked «never split» stays whole')
    check(not errs, f'no page errors {errs}')
    await ctx.close()

async def test_colors(browser, port):
    print('· colours: an album of your colours (with the readability guard), «Своя тема», export and import')
    ctx, pg, errs = await page(browser, port, {'language': 'en'}, pre='window.__themeIo = true;')
    await nav(pg, 'library', 2200)
    await pg.fill('#libFilter', 'Nightdrive'); await pg.wait_for_timeout(500)
    await pg.evaluate("[...document.querySelectorAll('#libGrid .tile')].find(t => t.querySelector('.tt')?.textContent === 'Nightdrive').click()"); await pg.wait_for_timeout(1400)
    acc0 = await pg.evaluate("getComputedStyle(document.getElementById('view-album')).getPropertyValue('--a-accent')")
    await pg.click('#alColors'); await pg.wait_for_timeout(900)
    check(await pg.evaluate("!!document.querySelector('.ac-veil.on .ac-pv')"), 'the colours sheet opens with a preview')
    chips = await pg.evaluate("document.querySelectorAll('.ac-row[data-kind=accent] .ac-chip').length")
    check(chips >= 1, f'the cover offers its own colours ({chips})')
    async def pick(kind, hexv):
        await pg.evaluate(f"(() => {{ const i = document.querySelector('.ac-row[data-kind={kind}] input[type=color]'); i.value = '{hexv}'; i.dispatchEvent(new Event('input', {{ bubbles: true }})); }})()")
        await pg.wait_for_timeout(700)
    await pick('accent', '#2a0505')
    st = await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1')).albumColors")
    check(len(st or {}) == 1 and list(st.values())[0].get('accent') == '#2a0505', f'your accent is kept for this album {st}')
    note = await pg.evaluate("document.querySelector('.ac-note.warn')?.textContent || ''")
    check(bool(note), 'a near-black accent is moved to stay visible, and the sheet says so')
    acc1 = await pg.evaluate("getComputedStyle(document.getElementById('view-album')).getPropertyValue('--a-accent')")
    check(acc1 and acc1 != acc0, f'the album page takes the colour at once ({acc0} → {acc1})')
    check(await pg.evaluate("!!document.querySelector('.ac-row[data-kind=bg]')"), 'with your accent, the background can be tinted too')
    if os.environ.get('SHOTS'): await pg.screenshot(path=os.environ['SHOTS'] + '/album-colors.png')
    await pg.click('.ac-acts [data-act=reset]'); await pg.wait_for_timeout(700)
    check(not await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1')).albumColors?.[Object.keys(JSON.parse(localStorage.getItem('aurora.settings.v1')).albumColors || {})[0]]"), 'reset forgets them')
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(400)
    # «Своя тема»: starts from the colours on screen, a light background makes a light theme
    await nav(pg, 'settings', 900)
    await pg.evaluate("[...document.querySelectorAll('.src-card')].at(-1).click()"); await pg.wait_for_timeout(700)
    s = await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1'))")
    check(s.get('colorSource') == 'custom' and (s.get('customTheme') or {}).get('accent'), f'your theme, seeded from the current colours {s.get("customTheme")}')
    await pg.evaluate("(() => { const i = document.querySelectorAll('.ct-row input[type=color]')[0]; i.value = '#f4efe4'; i.dispatchEvent(new Event('input', { bubbles: true })); })()"); await pg.wait_for_timeout(600)
    sch = await pg.evaluate("document.documentElement.dataset.scheme")
    check(sch == 'light', f'a light background makes a light theme ({sch})')
    # the palette now in force (the page itself fades between palettes, so its variables may be mid-way)
    cr = await pg.evaluate("""import('./js/theme.js').then(({ current: { palette: p } }) => {
      const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => { let x = parseInt(hex.slice(i, i + 2), 16) / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
      const t = lum(p.text.hex), b = lum(p.bg.hex);
      return (Math.max(t, b) + .05) / (Math.min(t, b) + .05);
    })""")
    check(cr >= 7, f'text keeps its contrast on your background ({cr:.1f}:1)')
    await pg.evaluate("[...document.querySelectorAll('#st-look .st-acts .btn')][0].click()"); await pg.wait_for_timeout(500)
    saved = await pg.evaluate("Object.values(window.__themeFiles)[0] || ''")
    check('"gatefoldTheme": 1' in saved and '#f4efe4' in saved, f'export writes a theme file {saved[:80]!r}')
    await pg.evaluate("window.__themeFiles['D:\\\\Themes\\\\gatefold-theme.json'] = JSON.stringify({ gatefoldTheme: 1, bg: '#101418', accent: '#ff7a59' })")
    await pg.evaluate("[...document.querySelectorAll('#st-look .st-acts .btn')][1].click()"); await pg.wait_for_timeout(800)
    t = await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1')).customTheme")
    check(t.get('bg') == '#101418' and t.get('accent') == '#ff7a59' and await pg.evaluate("document.documentElement.dataset.scheme") == 'dark', f'import reads it back {t}')
    bad = await pg.evaluate("import('./js/panels.js').then(m => [m.parseTheme('{}'), m.parseTheme('nope'), m.parseTheme(JSON.stringify({ bg: 'red', accent: '#ffffff' }))])")
    check(bad == [None, None, None], f'what is not a theme is refused {bad}')
    check(not errs, f'no page errors {errs}')
    await ctx.close()

async def test_sound_panel(browser, port):
    print('· «Звук»: DSP presets from the player bar, the chain playing now, foobar2000\'s equalizer and DSP Manager')
    ctx, pg, errs = await page(browser, port, {'language': 'en'}, pre='window.__dsp = true;')
    check(not await pg.evaluate("document.getElementById('btnSound').classList.contains('on')"), 'not lit without a DSP chain')
    await pg.click('#btnSound'); await pg.wait_for_timeout(500)
    items = await pg.evaluate("[...document.querySelectorAll('.snd-pop .snd-p span:last-child')].map(b => b.textContent)")
    check(items == ['Headphones', 'Speakers', 'Night'], f'the presets {items}')
    geo = await pg.evaluate("(() => { const p = document.querySelector('.snd-pop').getBoundingClientRect(), b = document.getElementById('btnSound').getBoundingClientRect(); return { above: p.bottom <= b.top + 1, inside: p.left >= 0 && p.right <= innerWidth && p.top >= 0 }; })()")
    check(geo['above'] and geo['inside'], f'the panel opens above its button, inside the window {geo}')
    await pg.evaluate("document.querySelectorAll('.snd-pop .snd-p')[0].click()"); await pg.wait_for_timeout(600)
    check(['dsp.applyPreset', 0] in await pg.evaluate("window.__calls"), 'a click applies the preset')
    chain = await pg.evaluate("[...document.querySelectorAll('.snd-pop .snd-chain .chip')].map(c => c.textContent)")
    check(chain == ['Equalizer', 'Crossfeed'], f'the chain playing now {chain}')
    check(await pg.evaluate("document.querySelector('.snd-pop .snd-p.on span:last-child')?.textContent") == 'Headphones', 'the active preset is ticked')
    check(await pg.evaluate("document.getElementById('btnSound').classList.contains('on')"), 'the button is lit while a chain plays')
    if os.environ.get('SHOTS'): await pg.screenshot(path=os.environ['SHOTS'] + '/sound.png')
    await pg.evaluate("document.querySelector('.snd-pop [data-act=eq]').click()"); await pg.wait_for_timeout(400)
    check(['menu.runMainMenuCommand', '{G-EQ}'] in await pg.evaluate("window.__calls"), 'the equalizer button opens foobar2000\'s equalizer')
    check(not await pg.evaluate("!!document.querySelector('.snd-pop')"), 'and closes the panel')
    await pg.click('#btnSound'); await pg.wait_for_timeout(400)
    await pg.evaluate("document.querySelector('.snd-pop [data-act=dsp]').click()"); await pg.wait_for_timeout(400)
    check(['menu.runMainMenuCommand', '{G-DSPPREF}'] in await pg.evaluate("window.__calls"), 'DSP Manager opens foobar2000\'s DSP page')
    await pg.click('#btnSound'); await pg.wait_for_timeout(300)
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
    check(not await pg.evaluate("!!document.querySelector('.snd-pop')"), 'Escape closes it')
    check(not errs, f'no page errors {errs}')
    await ctx.close()

async def test_tracks(browser, port):
    print('· Library → Tracks: every song in one list — sort, filter, select, play the list from a song (a big one in parts), letters, menus')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await pg.evaluate("window.__inv = []; const o = window.fb2k.invoke.bind(window.fb2k); window.fb2k.invoke = (m, p) => { if (/^(playlist[.](clear|playTrack|insertTracks|addHandles)|library[.]addToPlaylist|queue[.]addPaths)$/.test(m)) window.__inv.push([m, p]); return o(m, p); }")
    await nav(pg, 'library', 1500)
    await pg.click('.lib-mode [data-m=tracks]'); await pg.wait_for_timeout(2200)
    n = await pg.evaluate("document.querySelectorAll('.tr-row').length")
    sub = await pg.evaluate("document.getElementById('libSub').textContent")
    check(n > 10 and re.match(r'^[\d,]+ tracks · ', sub), f'the list is drawn ({n} rows on screen, «{sub}»)')
    check(await pg.evaluate("document.querySelector('#view-library .view-head h2').textContent") == 'Tracks', 'the header says Tracks')
    check(await pg.evaluate("!!document.querySelector('.tr-row .c-cov') && !!document.querySelector('.tr-row .c-tt b')"), 'rows: cover, title, artist')
    total = int(re.match(r'^([\d,]+)', sub).group(1).replace(',', ''))
    # sorting: a column name, then again for the other way round; the menu on top follows
    titles = lambda: pg.evaluate("[...document.querySelectorAll('.tr-row')].sort((a, b) => a.dataset.r - b.dataset.r).map(r => r.querySelector('.c-tt b').textContent)")
    await pg.click('.tr-head [data-sort=title]'); await pg.wait_for_timeout(500)
    t1 = await titles()
    check(t1[:8] == sorted(t1[:8], key=lambda x: x.lower()), f'a click on «Title» sorts by title {t1[:4]}')
    check(await pg.evaluate("document.querySelector('.tr-sort').value") == 'title', 'the sort menu follows')
    check(await pg.evaluate("!document.querySelector('.tr-rail').hidden"), 'a letter index while sorted by a name')
    await pg.click('.tr-head [data-sort=title]'); await pg.wait_for_timeout(500)
    t2 = await titles()
    check(t2[:5] == sorted(t2[:5], key=lambda x: x.lower(), reverse=True), f'again: the other way round {t2[:3]}')
    await pg.click('.tr-head [data-sort=duration]'); await pg.wait_for_timeout(500)
    check(await pg.evaluate("document.querySelector('.tr-rail').hidden"), 'no letters for a sort by length')
    await choose(pg, '.tr-sort', 'artist'); await pg.wait_for_timeout(500)
    # the filter: every word in title / artist / album / genre / year, marked
    await pg.fill('#libFilter', 'nightdrive lumen 2021'); await pg.wait_for_timeout(600)
    sub2 = await pg.evaluate("document.getElementById('libSub').textContent")
    rows = await pg.evaluate("[...document.querySelectorAll('.tr-row')].map(r => r.textContent)")
    check(rows and all('Nightdrive' in r for r in rows) and f'of {total:,}' in sub2, f'the filter narrows the list ({sub2})')
    check(await pg.evaluate("!!document.querySelector('.tr-row mark')"), 'what matched is marked')
    await pg.fill('#libFilter', 'zzzz-nothing'); await pg.wait_for_timeout(500)
    check(await pg.evaluate("!!document.querySelector('.tr-empty')"), 'nothing found: said so')
    await pg.fill('#libFilter', ''); await pg.wait_for_timeout(500)
    # selection: Shift extends, the bar counts, Esc clears
    await pg.click('.tr-row[data-r="1"] .c-title'); await pg.click('.tr-row[data-r="4"] .c-title', modifiers=['Shift']); await pg.wait_for_timeout(300)
    check(await pg.evaluate("document.querySelectorAll('.tr-row.sel').length") == 4 and await pg.evaluate("document.querySelector('.tr-selbar .n').textContent") == 'Selected: 4', 'Shift selects a range; the bar counts it')
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
    check(await pg.evaluate("document.querySelectorAll('.tr-row.sel').length") == 0, 'Esc clears it')
    # a double click plays the list as shown, from that song — also on the album's link
    await pg.evaluate("window.__inv.length = 0")
    await pg.dblclick('.tr-row[data-r="3"] .c-album'); await pg.wait_for_timeout(1200)
    inv = await pg.evaluate("window.__inv")
    add = next((c for c in inv if c[0] == 'library.addToPlaylist'), None)
    play = next((c for c in inv if c[0] == 'playlist.playTrack'), None)
    check(add and len(add[1]['paths']) == total and play and play[1]['index'] == 3, f'a double click plays the whole list from that song ({len(add[1]["paths"]) if add else 0} of {total}, index {play and play[1]["index"]})')
    check(await pg.evaluate("document.getElementById('view-library').classList.contains('active') || !document.getElementById('view-album').classList.contains('active')"), 'the album link did not open the album')
    # a big list: the songs from the chosen one first, the rest around it in the background
    await pg.evaluate("import('./js/tracks.js').then(m => Object.assign(m.CFG, { chunk: 20, first: 8, step: 10 }))")
    await pg.evaluate("window.__inv.length = 0")
    await pg.dblclick('.tr-row[data-r="15"] .c-title'); await pg.wait_for_timeout(9000)
    inv = await pg.evaluate("window.__inv")
    adds = [c[1]['paths'] for c in inv if c[0] == 'library.addToPlaylist']
    ins = [c[1] for c in inv if c[0] == 'playlist.insertTracks']
    play = next((c for c in inv if c[0] == 'playlist.playTrack'), None)
    allp = await pg.evaluate("import('./js/trackstore.js').then(async (TS) => { const T = await TS.all(); return T.length; })")
    check(adds and len(adds[0]) == 8 and play and play[1]['index'] == 0, f'a big list starts at once with the chosen song ({len(adds[0]) if adds else 0} first, index {play and play[1]["index"]})')
    check(sum(len(a) for a in adds) == total - 15 and sum(len(i['handles']) for i in ins) == 15 and all(i['position'] == 0 for i in ins), f'the rest follows in parts, the beginning inserted before it ({sum(len(a) for a in adds)} + {sum(len(i["handles"]) for i in ins)} of {total})')
    await pg.evaluate("import('./js/tracks.js').then(m => Object.assign(m.CFG, { chunk: 3000, first: 1000, step: 2500 }))")
    # the context menu
    await pg.click('.tr-row[data-r="2"] .c-title', button='right'); await pg.wait_for_timeout(400)
    items = await pg.evaluate("[...document.querySelectorAll('#layer .menu .mi')].map(x => x.textContent.trim())")
    check(any('Open album' in x for x in items) and any('Show in folder' in x for x in items) and any('foobar2000' in x for x in items), f'the menu: album, folder, foobar2000 actions {items[:9]}')
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
    await pg.keyboard.press('Control+a'); await pg.wait_for_timeout(200)
    check(await pg.evaluate("document.querySelector('.tr-selbar .n').textContent") == f'Selected: {total:,}', 'Ctrl+A selects every song')
    await pg.keyboard.press('Escape')
    await pg.click('.lib-mode [data-m=albums]'); await pg.wait_for_timeout(600)
    check(re.match(r'^\d+ albums?$', await pg.evaluate("document.getElementById('libSub').textContent")), 'back in Albums: the line under the title counts albums again')
    await pg.click('.lib-mode [data-m=tracks]'); await pg.wait_for_timeout(800)
    # remembered: Library opens in Tracks next time
    await nav(pg, 'now', 600); await nav(pg, 'library', 1500)
    check(await pg.evaluate("document.getElementById('view-library').classList.contains('tracks')"), 'Library opens where you left it')
    eng = [x for x in await pg.evaluate(SCAN) if not any(d in x for d in DATA) and len(x) > 1]      # single letters: the index of Cyrillic names
    check(not eng, f'no Russian left in English {eng[:5]}')
    if os.environ.get('SHOTS'): await pg.screenshot(path=os.environ['SHOTS'] + '/tracks.png')
    check(not errs, f'no page errors {errs}')
    await ctx.close()

async def test_text_clipping(browser, port):
    print('· text is never cut: descenders and accents keep their room wherever a box clips its text')
    AUD = (FIX / 'clip-audit.js').read_text(encoding='utf-8')
    found = []
    for lang in ('en', 'ru'):
        ctx, pg, errs = await page(browser, port, {'language': lang})
        for w in (1600, 1100):
            await pg.set_viewport_size({'width': w, 'height': 900}); await pg.wait_for_timeout(500)
            for v in ['now', 'playlist', 'artists', 'library', 'queue', 'covers', 'settings']:
                await nav(pg, v, 900)
                if v == 'now': await pg.evaluate("document.querySelector('.np-title').textContent = 'We Disintegrate · Йоги, Ёлки и Ångström'"); await pg.wait_for_timeout(200)
                found += [f'{lang}/{w}/{v}: {f["where"]} «{f["text"]}» {f["px"]}px {f["side"]}' for f in await pg.evaluate(AUD) if 'lyr' not in f['clip']]
            await nav(pg, 'library', 800)
            await pg.click('.lib-mode [data-m=tracks]'); await pg.wait_for_timeout(1200)
            found += [f'{lang}/{w}/tracks: {f["where"]} «{f["text"]}» {f["px"]}px' for f in await pg.evaluate(AUD) if 'lyr' not in f['clip']]
            await pg.click('.lib-mode [data-m=albums]'); await pg.wait_for_timeout(600)
        await ctx.close()
    check(not found, f'no clipped letters {found[:6]}')

async def test_canvas_idle(browser, port):
    print('· Canvas by itself: only after minutes in foobar2000\'s own window — time in another program does not count')
    ctx, pg, errs = await page(browser, port, {'language': 'en', 'canvasIdleMin': 2}, pre="window.__dt = 0; { const n = Date.now; Date.now = () => n() + window.__dt; }")
    opened = "import('./js/canvas.js').then(m => m.opened())"
    await pg.evaluate("window.__emit('window:activated', { active: false })")
    await pg.evaluate("window.__dt = 10 * 60000"); await pg.wait_for_timeout(16000)
    check(not await pg.evaluate(opened), 'ten minutes in another program: no Canvas')
    await pg.evaluate("window.__emit('window:activated', { active: true })")
    await pg.evaluate("window.__dt += 60000"); await pg.wait_for_timeout(16000)
    check(not await pg.evaluate(opened), 'back for a minute: still no Canvas')
    await pg.evaluate("window.__dt += 2 * 60000"); await pg.wait_for_timeout(16000)
    check(await pg.evaluate(opened), 'three untouched minutes in its own window: the Canvas opens')
    check(not errs, f'no page errors {errs}')
    await ctx.close()

async def test_heavy_library(browser, port):
    print('· a big library: nothing makes foobar2000\'s UI thread wait (HTTP stays async, no file rewrites from the background, quiet during an import)')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await pg.goto(f'http://127.0.0.1:{port}/theme/index.html?flat=1'); await pg.wait_for_timeout(1800)
    # one request the host refuses must not turn every later download synchronous
    sent = await pg.evaluate("""(async () => { const orig = window.fb2k.invoke.bind(window.fb2k); const got = []; let n = 0;
      window.fb2k.invoke = (m, p) => { if (m === 'http.get') { got.push(p.async); if (n++ === 0) return Promise.resolve({ success: false, code: 'INVALID_PARAMS', error: 'Invalid URL' }); } return orig(m, p); };
      const B = await import('./js/bridge.js');
      const a = await B.httpGet({ url: 'https://example.com/a b' }); await B.httpGet({ url: 'https://example.com/b' }); await B.httpGet({ url: 'https://example.com/c' });
      window.fb2k.invoke = orig; return [a.code, got]; })()""")
    check(sent == ['INVALID_PARAMS', [True, True, True]], f'a refused request is just that one: the next ones stay asynchronous {sent}')
    # the background sweep finds a cover for an album in a folder shared with others: kept in Gatefold, no track rewritten
    await pg.evaluate("window.__calls.length = 0")
    res = await pg.evaluate("""(async () => {
      const CF = await import('./js/coverfetch.js'), B = await import('./js/bridge.js');
      const r = await window.fb2k.invoke('library.getAlbums', { offset: 0, limit: 1 }); const a = r.albums[0];
      const job = { key: B.albumKeyOf(a.albumArtist, a.name), album: a.name, artist: a.albumArtist, path: a.firstTrackAbsolutePath, fromSweep: true };
      try { await CF.applyCandidate(job, { url: 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/source/1200x1200bb.jpg', src: 'iTunes', score: 0.95 }); } catch (e) { return 'error: ' + e.message; }
      const Own = await import('./js/ownart.js'); return Own.all().map((x) => [x.album, x.where]); })()""")
    calls = await pg.evaluate("window.__calls")
    check(not any(c[0] in ('metadata.embedArtwork', 'shell.spawn') for c in calls), 'the sweep rewrites no track and starts no PowerShell for a shared folder')
    check(isinstance(res, list) and len(res) == 1 and res[0][1] == 'gatefold', f'the cover is kept in Gatefold instead {res}')
    # foobar2000 importing files: background calls wait until the library is quiet
    waited = await pg.evaluate("""(async () => { const S = await import('./js/sched.js');
      window.__emit('library:itemsAdded', { count: 500 }); const t0 = performance.now();
      setTimeout(() => window.__emit('library:itemsAdded', { count: 500 }), 3000);
      const busy = S.libraryBusy(); await S.bgCall('playback.getVolume', {}, 'normal'); return [busy, Math.round(performance.now() - t0)]; })()""")
    check(waited[0] and waited[1] >= 12500, f'background work waits for an import to settle ({waited[1]} ms)')
    check(not errs, f'no page errors {errs}')
    await ctx.close()

async def test_cover_pick(browser, port):
    print('· your cover: from the computer, kept only in Gatefold and locked; whole, with a blurred backdrop on square tiles')
    ctx, pg, errs = await page(browser, port, {'language': 'en'}, pre='window.__pick = true;')
    await nav(pg, 'library', 2200)
    await pg.fill('#libFilter', 'Sand & Signal'); await pg.wait_for_timeout(500)
    await pg.evaluate("[...document.querySelectorAll('#libGrid .tile')].find(t => t.querySelector('.tt')?.textContent === 'Sand & Signal').click()"); await pg.wait_for_timeout(1300)
    await pg.click('#alCover'); await pg.wait_for_timeout(900)
    check(await pg.evaluate("!!document.querySelector('.cp-veil.on .cp-sheet')"), 'the cover sheet opens')
    check(await pg.evaluate("document.querySelector('.cp-head h3')?.textContent") == 'Sand & Signal', 'named after the album')
    await pg.click('.cp-sheet [data-a=file]'); await pg.wait_for_timeout(1200)
    dim = await pg.evaluate("document.querySelector('.cp-dim')?.textContent || ''")
    check(dim.startswith('900×1200'), f'the picture from the computer, at its real size ({dim})')
    where = await pg.evaluate("[...document.querySelectorAll('input[name=cpw]')].map(r => r.value + (r.checked ? '*' : ''))")
    check(where == ['gatefold*', 'embedded', 'file'], f'where to save, «only in Gatefold» first {where}')
    await pg.click('.cp-sheet input[name=cpw][value=file]'); await pg.wait_for_timeout(200)
    check(await pg.evaluate("!document.querySelector('.cp-fname').hidden"), 'a file name is asked only for «as a file»')
    await pg.click('.cp-sheet input[name=cpw][value=gatefold]'); await pg.wait_for_timeout(200)
    if os.environ.get('SHOTS'): await pg.screenshot(path=os.environ['SHOTS'] + '/cover-pick.png')
    await pg.click('.cp-sheet [data-a=save]'); await pg.wait_for_timeout(1800)
    check(not await pg.evaluate("document.querySelector('.cp-veil')?.classList.contains('on')"), 'saved and closed')
    check(not any(c[0] in ('metadata.embedArtwork', 'file.write') for c in await pg.evaluate("window.__calls")), '«only in Gatefold» touches no file')
    own = await pg.evaluate("import('./js/ownart.js').then(m => m.all().map(x => [x.album, x.where, x.lock, x.w, x.h]))")
    check(own == [['Sand & Signal', 'gatefold', True, 900, 1200]], f'kept by Gatefold and locked {own}')
    cov = await pg.evaluate("(() => { const c = document.querySelector('#view-album .album-cover'), r = c.getBoundingClientRect(), i = c.querySelector('img'); return { src: i.src.slice(0, 5), ar: +(r.width / r.height).toFixed(2), cls: c.className }; })()")
    check(cov['src'] == 'blob:' and abs(cov['ar'] - 0.75) < 0.03, f'the album page shows it at once, at 3:4 {cov}')
    await nav(pg, 'library', 900)
    await pg.fill('#libFilter', 'Sand & Signal'); await pg.wait_for_timeout(900)
    tile = await pg.evaluate("(() => { const t = [...document.querySelectorAll('#libGrid .tile')].find(t => t.querySelector('.tt')?.textContent === 'Sand & Signal'); const c = t.querySelector('.cov'); return { nsq: c.classList.contains('nsq'), bg: !!c.querySelector('.nsq-bg'), src: t.querySelector('.cov img').src.slice(0, 5) }; })()")
    check(tile == {'nsq': True, 'bg': True, 'src': 'blob:'}, f'the square tile shows the whole picture over a blurred copy {tile}')
    check(not errs, f'no page errors {errs}')
    await ctx.close()

async def test_folders(browser, port):
    print('· Library → Folders: the tree from the library, tiles and tracks, the filter, back and up, play / queue / Explorer, show an album\'s folder, files not in the library')
    ctx, pg, errs = await page(browser, port, {'language': 'en'})
    await pg.evaluate("(() => { const b = window.fb2k.invoke.bind(window.fb2k); window.fb2k.invoke = (m, p) => { if (/^(library.addToPlaylist|playlist.addPathsSequential|playlist.playTrack|queue.addPaths|shell.showInExplorer)$/.test(m)) window.__calls.push([m, (p && p.paths || []).length]); return b(m, p); }; })()")
    await nav(pg, 'library', 1600)
    await pg.click('.lib-mode button[data-m=folders]'); await pg.wait_for_timeout(1400)
    tiles = lambda: pg.evaluate("[...document.querySelectorAll('#fdDirs .fd-tile .tt')].map(t => t.textContent)")
    crumbs = lambda: pg.evaluate("[...document.querySelectorAll('.fd-crumb')].map(c => c.textContent.trim())")
    top = await tiles()
    check('Lumen Arcade' in top and 'Blue Hours' in top and len(top) == 6, f'the artists\' folders of D:\\Music {top}')
    check(await crumbs() == ['D:\\Music'], f'the single root folder is where the tree starts {await crumbs()}')
    check(await pg.evaluate("document.querySelector('#view-library h2').textContent") == 'Folders', 'the header says Folders')
    check(await pg.evaluate("JSON.parse(localStorage.getItem('aurora.settings.v1')).libMode") == 'folders', 'the mode is remembered')
    await pg.evaluate("[...document.querySelectorAll('#fdDirs .fd-tile')].find(t => t.querySelector('.tt').textContent === 'Lumen Arcade').click()"); await pg.wait_for_timeout(900)
    check(await crumbs() == ['D:\\Music', 'Lumen Arcade'], f'a step into a folder {await crumbs()}')
    subs = await pg.evaluate("[...document.querySelectorAll('#fdDirs .fd-tile .ta')].map(t => t.textContent)")
    check(subs and all('Lumen Arcade' in x for x in subs), f'an album\'s folder is named by its tags {subs}')
    await pg.evaluate("document.querySelector('#fdDirs .fd-tile').click()"); await pg.wait_for_timeout(900)
    rows = await pg.evaluate("document.querySelectorAll('#fdList .vrow').length")
    check(rows > 0 and len(await crumbs()) == 3, f'a folder\'s own tracks ({rows})')
    check(await pg.evaluate("!!document.querySelector('#fdList .vrow .lnk[data-go=artist]') && !!document.querySelector('#fdList .vrow .row-like')"), 'rows link the artist and can be liked')
    await pg.keyboard.press('Backspace'); await pg.wait_for_timeout(700)
    check(await crumbs() == ['D:\\Music', 'Lumen Arcade'], f'Backspace goes back {await crumbs()}')
    await pg.keyboard.press('Alt+ArrowUp'); await pg.wait_for_timeout(700)
    check(await crumbs() == ['D:\\Music'], f'Alt+↑ goes up {await crumbs()}')
    # the filter searches everything below
    await pg.fill('#libFilter', 'Afterglow'); await pg.wait_for_timeout(700)
    found = await pg.evaluate("[...document.querySelectorAll('#fdList .vrow .c-title')].map(c => c.textContent)")
    check(found and all('Afterglow' in x for x in found), f'the filter finds tracks in every folder below ({len(found)})')
    await pg.fill('#libFilter', ''); await pg.wait_for_timeout(600)
    check(len(await tiles()) == 6, 'and gives the folder back when cleared')
    # play the whole folder; the queue from a tile's menu; Explorer from the bar
    n0 = len(await pg.evaluate("window.__calls"))
    await pg.click('.fd-acts [data-act=play]'); await pg.wait_for_timeout(900)
    adds = [c for c in (await pg.evaluate("window.__calls"))[n0:] if c[0] in ('library.addToPlaylist', 'playlist.addPathsSequential', 'playlist.playTrack')]
    check(adds, f'«Play» plays the folder and everything below it {adds[:2]}')
    tile = await pg.query_selector('#fdDirs .fd-tile')
    await tile.click(button='right'); await pg.wait_for_timeout(300)
    await pg.evaluate("[...document.querySelectorAll('#layer .menu .mi')].find(m => m.textContent.trim() === 'Queue').click()"); await pg.wait_for_timeout(500)
    check(any(c[0] == 'queue.addPaths' for c in await pg.evaluate("window.__calls")), 'a folder can be queued from its menu')
    await pg.click('.fd-acts [data-act=more]'); await pg.wait_for_timeout(300)
    menu = await pg.evaluate("[...document.querySelectorAll('#layer .menu .mi')].map(m => m.textContent)")
    check(any('Explorer' in m for m in menu) and any('not in the library' in m for m in menu), f'the folder menu {menu}')
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
    # an album's folder, from the album grid
    await pg.click('.lib-mode button[data-m=albums]'); await pg.wait_for_timeout(1200)
    check(await pg.evaluate("document.querySelectorAll('#libGrid .tile').length") > 0 and not await pg.evaluate("document.getElementById('view-library').classList.contains('folders')"), 'back to the albums')
    await pg.fill('#libFilter', 'Nightdrive'); await pg.wait_for_timeout(600)
    t = await pg.query_selector('#libGrid .tile')
    name = await pg.evaluate("document.querySelector('#libGrid .tile .tt').textContent")
    await pg.fill('#libFilter', '')
    await t.click(button='right'); await pg.wait_for_timeout(300)
    await pg.evaluate("[...document.querySelectorAll('#layer .menu .mi')].find(m => /folder in library/i.test(m.textContent)).click()"); await pg.wait_for_timeout(1200)
    sel = await pg.evaluate("[...document.querySelectorAll('#fdList .vrow.sel')].length")
    check(await pg.evaluate("document.getElementById('view-library').classList.contains('folders')") and sel == 1, f'«Show folder in library» opens the album\'s folder, its first track marked ({name}, {sel})')
    # files of the folder that the library does not have
    folder = await pg.evaluate("import('./js/settings.js').then(m => m.settings.libFolder)")
    await pg.evaluate(f"window.__fs[{json.dumps(folder + chr(92) + 'bonus track.flac')}] = 'AAAA'; window.__fs[{json.dumps(folder + chr(92) + 'cover.jpg')}] = 'AAAA'")
    await pg.click('.fd-acts [data-act=more]'); await pg.wait_for_timeout(300)
    await pg.evaluate("[...document.querySelectorAll('#layer .menu .mi')].find(m => m.textContent.includes('not in the library')).click()"); await pg.wait_for_timeout(1000)
    extra = await pg.evaluate("[...document.querySelectorAll('#fdList .vrow.extra .c-title')].map(c => c.textContent)")
    check(len(extra) == 1 and 'bonus track' in extra[0], f'audio files the library does not have are listed, marked; pictures are not {extra}')
    n0 = len(await pg.evaluate("window.__calls"))
    await pg.dblclick('#fdList .vrow.extra .c-title'); await pg.wait_for_timeout(900)
    check(any(c[0] in ('library.addToPlaylist', 'playlist.addPathsSequential') for c in (await pg.evaluate("window.__calls"))[n0:]), 'and can be played')
    if os.environ.get('SHOTS'): await pg.screenshot(path=os.environ['SHOTS'] + '/folders.png')
    check(not errs, f'no page errors {errs}')
    await ctx.close()

TESTS = [*((f'language_{l}', (lambda l: lambda b, p: test_language(b, p, l))(l)) for l in ('ru', 'en', 'de', 'es', 'zh')),
         ('playlists', test_playlists), ('youtube', test_youtube), ('youtube_captions', test_youtube_captions), ('columns', test_columns), ('settings', test_settings), ('updates', test_updates),
         ('tooltips', test_tooltips), ('canvas_volume', test_canvas_volume), ('fb2k_prefs', test_fb2k_prefs), ('welcome', test_welcome),
         ('playlist_editing', test_playlist_editing), ('windows', test_windows), ('vu', test_vu), ('smart_color_radio', test_smart_color_radio),
         ('lyrics_sync', test_lyrics_sync), ('album_details', test_album_details), ('level', test_level), ('sound_offer', test_sound_offer), ('similar_albums', test_similar_albums), ('editions_artists', test_editions_artists), ('colors', test_colors), ('sound_panel', test_sound_panel), ('cover_pick', test_cover_pick), ('heavy_library', test_heavy_library), ('tracks', test_tracks), ('text_clipping', test_text_clipping), ('canvas_idle', test_canvas_idle), ('folders', test_folders), ('sound_ai', test_sound_ai), ('layout', test_layout), ('stability', test_stability)]
# seconds each test takes on a CI runner (from the « (N s)» lines of a run); only used to share the tests
# out evenly between parallel parts — a test missing here counts as DEFAULT_S and still runs
DURATIONS = {'language_ru': 13, 'language_en': 18, 'language_de': 18, 'language_es': 18, 'language_zh': 18, 'playlists': 10, 'youtube': 14,
             'youtube_captions': 29, 'columns': 23, 'settings': 6, 'updates': 20, 'tooltips': 9, 'canvas_volume': 4, 'fb2k_prefs': 9, 'welcome': 24,
             'playlist_editing': 14, 'windows': 13, 'vu': 32, 'smart_color_radio': 27, 'lyrics_sync': 11, 'album_details': 20, 'level': 7,
             'sound_offer': 14, 'similar_albums': 3, 'editions_artists': 20, 'colors': 16, 'sound_panel': 8, 'cover_pick': 12, 'heavy_library': 22, 'tracks': 30, 'text_clipping': 60, 'canvas_idle': 52, 'folders': 16, 'sound_ai': 58, 'layout': 60, 'stability': 70}
DEFAULT_S = 20

def shards(n):
    """the tests split into n parts of about the same length (longest first, each to the shortest part)"""
    parts = [[] for _ in range(n)]; load = [0] * n
    for name, _ in sorted(TESTS, key=lambda t: -DURATIONS.get(t[0], DEFAULT_S)):
        i = load.index(min(load)); parts[i].append(name); load[i] += DURATIONS.get(name, DEFAULT_S)
    return parts, load

def selected():
    """ONLY=a,b (exact names; «language» means every language) and/or SHARD=i/n (part i of n)"""
    names = [n for n, _ in TESTS]
    only = [o for o in os.environ.get('ONLY', '').split(',') if o]
    if only:
        unknown = [o for o in only if o != 'language' and o not in names]
        if unknown: sys.exit(f'ONLY: no such test {unknown} (tests: {", ".join(names)})')
        names = [n for n in names if n in only or ('language' in only and n.startswith('language_'))]
    if os.environ.get('SHARD'):
        i, n = (int(x) for x in os.environ['SHARD'].split('/'))
        part = set(shards(n)[0][i - 1])
        names = [x for x in names if x in part]
    return names

async def main():
    from playwright.async_api import async_playwright        # here: E2E_PLAN works without Playwright installed
    names = selected()
    print(f'tests: {", ".join(names)}  (≈{sum(DURATIONS.get(n, DEFAULT_S) for n in names)} s)', flush=True)
    httpd = serve(); port = httpd.server_address[1]
    times = {}
    async with async_playwright() as p:
        kw = {'executable_path': os.environ['CHROMIUM']} if os.environ.get('CHROMIUM') else {}
        # nothing leaves the machine: in CI a click could otherwise download models, ask GitHub or
        # YouTube, and the run would differ from (and wait longer than) an offline one
        browser = await p.chromium.launch(args=['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'], **kw)
        fns = dict(TESTS)
        for name in names:
            import time
            t0 = time.time()
            await timed(name, fns[name](browser, port))
            times[name] = round(time.time() - t0)
        await browser.close()
    httpd.shutdown()
    print('\ntimes: ' + json.dumps(times), flush=True)
    print(f'\n{len(failures)} failure(s)')
    sys.exit(1 if failures else 0)

if os.environ.get('E2E_PLAN'):
    # the plan of a sharded run: which tests go where, and how long each part takes
    n = int(os.environ['E2E_PLAN'])
    for i, (part, s) in enumerate(zip(*shards(n)), 1): print(f'{i}/{n}  ≈{s:>3} s  {", ".join(part)}')
    sys.exit(0)

if not os.environ.get('E2E_IMPORT_ONLY'):
    asyncio.run(main())
