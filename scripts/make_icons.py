from PIL import Image, ImageDraw, ImageFont, ImageFilter
import sys
OUT = sys.argv[1]
S = 1024  # draw large, downscale for smoothness

def gradient(size, c1, c2):
    img = Image.new('RGB', (size, size), c1)
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
    return img

def content(scale=1.0):
    """receipt + coin on transparent layer"""
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = S / 2, S / 2
    def P(x, y):  # coordinates designed for 1024 canvas, scaled around centre
        return (cx + (x - 512) * scale, cy + (y - 512) * scale)
    # receipt body with zigzag bottom
    left, right, top, bottom = 290, 690, 200, 780
    teeth = 8
    pts = [P(left, top), P(right, top), P(right, bottom)]
    w = (right - left) / teeth
    for i in range(teeth):
        x1 = right - w * (i + 0.5)
        x2 = right - w * (i + 1)
        pts.append(P(x1, bottom - 38))
        pts.append(P(x2, bottom))
    pts.append(P(left, top))
    # shadow
    sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x + 10 * scale, y + 16 * scale) for x, y in pts], fill=(0, 40, 35, 90))
    sh = sh.filter(ImageFilter.GaussianBlur(14 * scale))
    layer.alpha_composite(sh)
    d = ImageDraw.Draw(layer)
    d.polygon(pts, fill=(255, 255, 255, 255))
    # rounded top corners look: small circles
    line = (15, 118, 110, 255)
    soft = (153, 213, 205, 255)
    for (y, x2, col, wdt) in [(300, 610, line, 26), (380, 560, soft, 22), (450, 600, soft, 22), (520, 520, soft, 22)]:
        d.rounded_rectangle([P(370, y - wdt / 2), P(x2, y + wdt / 2)], radius=wdt / 2 * scale, fill=col)
    d.rounded_rectangle([P(370, 610 - 15), P(640, 610 + 15)], radius=15 * scale, fill=line)
    # coin
    r = 150
    ccx, ccy = 690, 700
    d.ellipse([P(ccx - r - 14, ccy - r - 14), P(ccx + r + 14, ccy + r + 14)], fill=(255, 255, 255, 255))
    d.ellipse([P(ccx - r, ccy - r), P(ccx + r, ccy + r)], fill=(245, 158, 11, 255))
    d.ellipse([P(ccx - r + 22, ccy - r + 22), P(ccx + r - 22, ccy + r - 22)], outline=(255, 214, 120, 255), width=int(10 * scale))
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', int(190 * scale))
    tx, ty = P(ccx, ccy + 6)
    d.text((tx, ty), '€', font=font, fill=(255, 255, 255, 255), anchor='mm')
    return layer

def make(maskable=False):
    bg = gradient(S, (20, 184, 166), (15, 118, 110)).convert('RGBA')
    if not maskable:
        mask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=230, fill=255)
        base = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        base.paste(bg, (0, 0), mask)
        bg = base
    layer = content(0.74 if maskable else 0.92)
    bg.alpha_composite(layer)
    return bg

any_icon = make(False)
mask_icon = make(True)
any_icon.resize((512, 512), Image.LANCZOS).save(f'{OUT}/icon-512.png', optimize=True)
any_icon.resize((192, 192), Image.LANCZOS).save(f'{OUT}/icon-192.png', optimize=True)
mask_icon.resize((512, 512), Image.LANCZOS).save(f'{OUT}/icon-maskable-512.png', optimize=True)
print('ok')
