# compose-hero.py <in.pdf> <image> <out.pdf> <crop_top_fraction> <caption> <fonts-dir>
# Replaces the hero band of Mohameden's poster PDF with a digital-twin still and redraws the title block on top.
#   python -I docs/poster/compose-hero.py docs/poster/27.EDGE.FlexiPath-A.pdf docs/poster/img/hero-title.jpg #       docs/poster/27.EDGE.FlexiPath.pdf 0.08 "3D DIGITAL TWIN|  ·  <caption>" docs/poster/fonts
# <fonts-dir> holds the static woff2 instances (Orbitron-900, Inter-500/600/800, JetBrainsMono-700); the TTFs PyMuPDF
# needs are built from them into a temp folder (fontTools + brotli). Needs pymupdf and pillow.
import sys, warnings; warnings.filterwarnings("ignore")
import pymupdf
from PIL import Image
MM = 2.834646
src, img_path, out, top_frac, caption = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), sys.argv[5]
FONTS_SRC = sys.argv[6]
import os, tempfile
from fontTools.ttLib import TTFont
FONTS = os.path.join(tempfile.gettempdir(), "poster-ttf"); os.makedirs(FONTS, exist_ok=True)
for name in ("Orbitron-900", "Inter-800", "Inter-600", "Inter-500", "JetBrainsMono-700"):
    ttf = os.path.join(FONTS, name + ".ttf")
    if not os.path.exists(ttf):
        f = TTFont(os.path.join(FONTS_SRC, name + ".woff2")); f.flavor = None; f.save(ttf)
def rgb(h): return tuple(int(h[i:i+2], 16) / 255 for i in (1, 3, 5))
def R(x0, y0, x1, y1): return pymupdf.Rect(x0 * MM, y0 * MM, x1 * MM, y1 * MM)
def P(x, y): return pymupdf.Point(x * MM, y * MM)

BAND = (0, 97.9, 1200, 568.5)           # hero band in mm (teal header line → problem-statement box)
doc = pymupdf.open(src); page = doc[0]

# 1) drop the old labels' text inside the band (the picture itself is covered below)
try:
    page.add_redact_annot(R(*BAND))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
    print("redacted band text")
except Exception as e:
    print("redaction skipped:", e)

# 1b) wrap the original page as a form XObject on a fresh page: a form restores the graphics state
#     when it finishes, so the blend mode / soft mask the original leaves open cannot tint what we draw on top
src_doc = doc
doc = pymupdf.open(); page = doc.new_page(width=src_doc[0].rect.width, height=src_doc[0].rect.height)
page.show_pdf_page(page.rect, src_doc, 0)
print("wrapped original page as form")

# 2) crop the still to the band's aspect ratio and place it
bw, bh = BAND[2] - BAND[0], BAND[3] - BAND[1]
im = Image.open(img_path).convert("RGB")
ch = int(round(im.width * bh / bw))
if ch > im.height: ch = im.height
y0 = int(round((im.height - ch) * top_frac))
crop = im.crop((0, y0, im.width, y0 + ch))
crop_path = out + ".hero.jpg"; crop.save(crop_path, quality=93, subsampling=0)
print("hero crop", crop.size, "->", f"{crop.width / (bw / 25.4):.0f} dpi at {bw:.0f} mm")
page.insert_image(R(*BAND), filename=crop_path, keep_proportion=True, overlay=True)

# 3) title panel (same place as the original, trimmed to the text width)
panel = R(40, 111.9, 600, 283.9)
try:
    page.draw_rect(panel, color=None, fill=rgb("#050b18"), fill_opacity=0.82, radius=(10 / 560, 10 / 172))
except TypeError:
    page.draw_rect(panel, color=None, fill=rgb("#050b18"), fill_opacity=0.82)

orb = f"{FONTS}/Orbitron-900.ttf"; int8 = f"{FONTS}/Inter-800.ttf"; int6 = f"{FONTS}/Inter-600.ttf"; int5 = f"{FONTS}/Inter-500.ttf"; jbm = f"{FONTS}/JetBrainsMono-700.ttf"
def width(path, text, size): return pymupdf.Font(fontfile=path).text_length(text, fontsize=size) / MM
def text(x, y, s, size, path, name, color, **kw):
    page.insert_text(P(x, y), s, fontsize=size, fontname=name, fontfile=path, color=rgb(color), **kw)
    return x + width(path, s, size)

# FLEXIPATH wordmark with a cyan glow behind PATH
x = 54.0; base = 184.7; size = 218
xp = x + width(orb, "FLEXI", size)
for bw_, op in ((26, 0.08), (16, 0.14), (9, 0.20), (4, 0.30)):
    page.insert_text(P(xp, base), "PATH", fontsize=size, fontname="F-orb", fontfile=orb, color=rgb("#46dcff"),
                     render_mode=2, border_width=bw_ / size, fill_opacity=op, stroke_opacity=op)  # stroke width scales with font size
text(x, base, "FLEXI", size, orb, "F-orb", "#ffffff")
text(xp, base, "PATH", size, orb, "F-orb", "#46dcff")
# tagline
x = 54.0; base = 224.1; size = 92
x = text(x, base, "Switch ", size, int8, "F-int8", "#eef4fa")
x = text(x, base, "before", size, int8, "F-int8", "#46dcff")
x = text(x, base, " the link fails.", size, int8, "F-int8", "#eef4fa")
text(54.0, 251.4, "Someone is waiting for this link.", 54, int6, "F-int6", "#ffe3b8")
text(54.0, 272.5, "The drone must not go silent.", 54, int6, "F-int6", "#ffe3b8")

# 4) caption chip at the bottom of the band
if caption:
    lab, _, rest = caption.partition("|")
    size = 30
    w = width(jbm, lab, size) + width(int5, rest, size) + 24
    chip = R(40, 526, 40 + w, 556)
    try: page.draw_rect(chip, color=None, fill=rgb("#050b18"), fill_opacity=0.78, radius=(6 / w, 6 / 30))
    except TypeError: page.draw_rect(chip, color=None, fill=rgb("#050b18"), fill_opacity=0.78)
    x = text(52, 546.5, lab, size, jbm, "F-jbm", "#46dcff")
    text(x, 546.5, rest, size, int5, "F-int5", "#eef4fa")

doc.save(out, garbage=3, deflate=True)
print("saved", out)
