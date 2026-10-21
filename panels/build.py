"""
Gatefold panels — build the add-on templates for Default UI / Columns UI layouts:

    python panels/build.py <out dir> [version]
      → <out>/gatefold-seekbar/, <out>/gatefold-covers/  and  gatefold-seekbar-<v>.zip, gatefold-covers-<v>.zip

Each panel is its own folder (panels/<name>/). What it imports from Gatefold (./gf/…) is copied
from theme/ unchanged, following the imports, so the panels never change the interface itself.
"""
import re, shutil, sys, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
THEME = ROOT / 'theme'
OUT = Path(sys.argv[1]).resolve()
VERSION = sys.argv[2] if len(sys.argv) > 2 else (HERE / 'VERSION').read_text().strip()
PANELS = {'seekbar': {'extra': ['js/palette-core.js', 'fonts/inter-latin-opsz-normal.woff2', 'fonts/inter-cyrillic-opsz-normal.woff2']},
          'covers': {'extra': ['css/app.css', 'fonts/inter-latin-opsz-normal.woff2', 'fonts/inter-cyrillic-opsz-normal.woff2', 'fonts/inter-latin-ext-opsz-normal.woff2', 'fonts/inter-cyrillic-ext-opsz-normal.woff2']}}
IMPORT = re.compile(r"""(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}/[^'"]+)['"]|import\s*['"](\.{1,2}/[^'"]+)['"]|new URL\(\s*['"](\.{1,2}/[^'"]+)['"]\s*,\s*import\.meta\.url|import\(\s*['"](\.{1,2}/locales/[^'"]+)['"]\s*\)""")

def deps(js: Path, seen: set):
    """Gatefold modules a file needs (relative imports and module workers), recursively"""
    for m in IMPORT.finditer(js.read_text(encoding='utf-8')):
        rel = next(g for g in m.groups() if g)
        p = (js.parent / rel).resolve()
        if p in seen or not p.exists(): continue
        seen.add(p); deps(p, seen)

OUT.mkdir(parents=True, exist_ok=True)
for name, cfg in PANELS.items():
    src, dst = HERE / name, OUT / f'gatefold-{name}'
    if dst.exists(): shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns('README.md'))   # the page on GitHub, not part of the panel
    # the Gatefold modules this panel imports through ./gf/
    need = set()
    for js in src.glob('*.js'):
        for m in IMPORT.finditer(js.read_text(encoding='utf-8')):
            rel = next(g for g in m.groups() if g)
            if rel.startswith('./gf/'):
                p = (THEME / 'js' / rel[len('./gf/'):]).resolve(); need.add(p); deps(p, need)
    for p in sorted(need):
        rel = p.relative_to(THEME / 'js')
        (dst / 'gf' / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dst / 'gf' / rel)
    for e in cfg['extra']:
        target = dst / 'gf' / (Path(e).name if e.startswith('js/') else e)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(THEME / e, target)
    for f in ('LICENSE', 'THIRD_PARTY_NOTICES.md'): shutil.copy2(THEME / f, dst / f)
    (dst / 'VERSION').write_text(VERSION + '\n')
    z = OUT / f'gatefold-{name}-{VERSION}.zip'
    with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(dst.rglob('*')):
            if f.is_file(): zf.write(f, f.relative_to(OUT).as_posix())
    print(f'{dst.name}: {sum(1 for f in dst.rglob("*") if f.is_file())} files, {z.name} {z.stat().st_size // 1024} KB')
