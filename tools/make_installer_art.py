"""Draws the installer artwork (original design: an opened gatefold sleeve with a record).
Run: python tools/make_installer_art.py  → installer/assets/wizard-*.bmp/png (the large images; the icon is make_app_icon.py)"""
import math, os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), '..', 'installer', 'assets')
os.makedirs(OUT, exist_ok=True)
S = 4  # supersampling

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def backdrop(w, h):
    im = Image.new('RGB', (w, h))
    px = im.load()
    top, bot = (24, 18, 44), (10, 9, 20)
    for y in range(h):
        c = lerp(top, bot, y / max(1, h - 1))
        for x in range(w): px[x, y] = c
    glow = Image.new('RGB', (w, h), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    for cx, cy, r, col in [(0.15, 0.2, 0.65, (230, 70, 140)), (0.95, 0.55, 0.6, (90, 70, 230)), (0.4, 0.95, 0.55, (40, 160, 190))]:
        g.ellipse([(cx - r) * w, (cy - r) * h, (cx + r) * w, (cy + r) * h], fill=col)
    glow = glow.filter(ImageFilter.GaussianBlur(min(w, h) * 0.32))
    return Image.blend(im, glow, 0.55)

def sleeve(draw, x, y, s, open_=0.22):
    """an opened gatefold sleeve with a record sliding out of the right-hand panel"""
    o = s * open_
    # right panel, opened (a skewed quad), drawn first — the record slides out from behind it
    rp = [(x + s, y), (x + s * 1.82, y - o * 0.35), (x + s * 1.82, y + s + o * 0.35), (x + s, y + s)]
    draw.polygon(rp, fill=(236, 226, 220))
    # record: half out of the sleeve, centred on the panel's outer edge
    rx, ry, rr = x + s * 1.82, y + s * 0.5, s * 0.47
    draw.ellipse([rx - rr, ry - rr, rx + rr, ry + rr], fill=(16, 15, 22))
    for k in range(1, 9):
        q = rr * (0.36 + k * 0.075)
        draw.ellipse([rx - q, ry - q, rx + q, ry + q], outline=(40, 38, 52), width=max(1, int(s * 0.006)))
    lr = rr * 0.31
    draw.ellipse([rx - lr, ry - lr, rx + lr, ry + lr], fill=(236, 92, 150))
    draw.ellipse([rx - lr * 0.17, ry - lr * 0.17, rx + lr * 0.17, ry + lr * 0.17], fill=(16, 15, 22))
    # the inner edge of the right panel stays on top of the record's left half
    draw.polygon([(x + s, y), (x + s * 1.82, y - o * 0.35), (x + s * 1.82, ry - rr * 1.02), (x + s * 1.4, ry - rr * 0.9)], fill=(236, 226, 220))
    # left panel: the "artwork"
    draw.rounded_rectangle([x, y, x + s, y + s], radius=s * 0.05, fill=(250, 238, 230))
    for i, col in enumerate([(236, 92, 150), (120, 96, 240), (52, 170, 200)]):
        cy = y + s * (0.3 + i * 0.2)
        draw.rounded_rectangle([x + s * 0.12, cy, x + s * (0.88 - i * 0.18), cy + s * 0.1], radius=s * 0.05, fill=col)
    draw.line([(x + s, y), (x + s, y + s)], fill=(200, 186, 180), width=max(1, int(s * 0.012)))

def large(w, h, name):
    W, H = w * S, h * S
    im = backdrop(W, H)
    d = ImageDraw.Draw(im)
    s = W * 0.36
    sleeve(d, W * 0.06, H * 0.34, s)
    im = im.resize((w, h), Image.LANCZOS)
    im.save(os.path.join(OUT, name + '.bmp')); im.save(os.path.join(OUT, name + '.png'))

def small(w, h, name):
    W, H = w * S, h * S
    im = Image.new('RGB', (W, H), (255, 255, 255))
    d = ImageDraw.Draw(im)
    s = W * 0.4
    sleeve(d, W * 0.04, (H - s) / 2, s)
    im = im.resize((w, h), Image.LANCZOS)
    im.save(os.path.join(OUT, name + '.bmp')); im.save(os.path.join(OUT, name + '.png'))

for pct, (w, h) in {100: (164, 314), 125: (192, 386), 150: (246, 459), 175: (273, 556), 200: (328, 604)}.items(): large(w, h, f'wizard-{pct}')

# the icon (gatefold.ico, gatefold-256.png) and the small wizard images: tools/make_app_icon.py
print('ok', sorted(os.listdir(OUT)))
