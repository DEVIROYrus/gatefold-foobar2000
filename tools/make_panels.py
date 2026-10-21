"""
Gatefold · make_panels.py — the panel templates for Default UI / Columns UI layouts:

    python tools/make_panels.py <out dir>   →  <out>/gatefold-seekbar/, <out>/gatefold-covers/

Each is a full copy of theme/ with its own index.html (the same rule as theme/js/panel-templates.js,
which the in-app updater uses): the seekbar page, or the interface in «covers» panel mode.
"""
import shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THEME = ROOT / 'theme'
OUT = Path(sys.argv[1]).resolve()
TAG = '<script src="js/panel-boot.js"></script>'
index = (THEME / 'index.html').read_text(encoding='utf-8')
assert TAG in index, 'index.html no longer loads js/panel-boot.js'
PAGES = {
    'gatefold-seekbar': (THEME / 'seekbar.html').read_text(encoding='utf-8'),
    'gatefold-covers': index.replace(TAG, '<script src="js/panel-boot.js" data-panel="covers"></script>'),
}
for name, page in PAGES.items():
    d = OUT / name
    if d.exists(): shutil.rmtree(d)
    shutil.copytree(THEME, d)
    (d / 'index.html').write_text(page, encoding='utf-8', newline='\n')
    print(d, sum(1 for _ in d.rglob('*') if _.is_file()), 'files')
