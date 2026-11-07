# Synthetic German supermarket receipt (fictional shop) for testing the photo path.
import random, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

lines = [
    ("SUPERMARKT MUSTERMANN", "c"),
    ("Musterstrasse 1", "c"),
    ("50226 Frechen", "c"),
    ("Tel. 02234 000000", "c"),
    ("-" * 34, "l"),
    ("                              EUR", "l"),
    ("Vollmilch 3,5% 1L", "l"),
    ("   2 x 1,19               2,38 A", "l"),
    ("Bauernbrot 750g           2,49 A", "l"),
    ("Haehnchenbrust 600g       6,99 A", "l"),
    ("Tomaten lose", "l"),
    ("   0,812 kg x 2,99 EUR/kg 2,43 A", "l"),
    ("Coca-Cola 1,5L            1,79 B", "l"),
    ("Pfand                     0,25 B", "l"),
    ("Spuelmittel Zitrone       1,29 B", "l"),
    ("Marlboro Gold 20 St.     10,00 B", "l"),
    ("Preisvorteil Haehnchen   -1,00 A", "l"),
    ("-" * 34, "l"),
    ("SUMME EUR                26,62", "l"),
    ("=" * 34, "l"),
    ("Geg. EC-Karte            26,62", "l"),
    ("", "l"),
    ("MwSt    Netto   Steuer   Brutto", "l"),
    ("A  7%   12,42     0,87    13,29", "l"),
    ("B 19%   11,20     2,13    13,33", "l"),
    ("-" * 34, "l"),
    ("07.11.2026  08:15  Bon 1234 Kasse 2", "l"),
    ("", "l"),
    ("Vielen Dank fuer Ihren Einkauf!", "c"),
]

font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 26)
bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 30)
W, lh, pad = 640, 38, 40
H = pad * 2 + lh * len(lines) + 20
img = Image.new("RGB", (W, H), (250, 248, 242))
d = ImageDraw.Draw(img)
y = pad
for i, (t, a) in enumerate(lines):
    f = bold if i == 0 or t.startswith("SUMME") else font
    tw = d.textlength(t, font=f)
    x = (W - tw) / 2 if a == "c" else 30
    d.text((x, y), t, font=f, fill=(25, 25, 25))
    y += lh
# make it look a bit like a phone photo: put on a darker table, slight rotation, blur, noise
canvas = Image.new("RGB", (W + 160, H + 160), (120, 105, 90))
img = img.rotate(-1.5, expand=True, fillcolor=(120, 105, 90))
canvas.paste(img, (60, 50))
canvas = canvas.filter(ImageFilter.GaussianBlur(0.6))
random.seed(1)
px = canvas.load()
for _ in range(25000):
    x, yy = random.randrange(canvas.width), random.randrange(canvas.height)
    r, g, b = px[x, yy]
    n = random.randint(-18, 18)
    px[x, yy] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
out = sys.argv[1]
canvas.save(out, "JPEG", quality=85)
print(out, canvas.size)
