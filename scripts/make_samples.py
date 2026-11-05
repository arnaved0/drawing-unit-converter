"""Generate synthetic sample drawings for development and tests.

The PDFs imitate CAD-exported vector PDFs like the heater drawings the tool was
built for: stroked geometry, filled arrowheads, dash-dot centre lines, rotated
and coloured dimension text, CJK text, characters placed one at a time, an
embedded raster image and repeated bolt heads (for block detection).

Usage:  python scripts/make_samples.py  (needs reportlab and ezdxf)
"""
import io
import math
import os
import struct
import zlib

import ezdxf
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(__file__), "..", "samples")
os.makedirs(OUT, exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

BLACK = (0, 0, 0)
RED = (0.85, 0.1, 0.1)
BLUE = (0.12, 0.42, 0.68)


def arrow(c, x, y, ang, size=7, color=BLACK):
    """Filled triangular arrowhead with its tip at (x, y) pointing along ang."""
    c.setFillColorRGB(*color)
    p = c.beginPath()
    p.moveTo(x, y)
    for s in (1, -1):
        a = ang + math.pi + s * 0.18
        p.lineTo(x + size * math.cos(a), y + size * math.sin(a))
    p.close()
    c.drawPath(p, stroke=0, fill=1)


def dim_line(c, x1, y1, x2, y2, text, offset=10, color=BLACK, font="Helvetica", size=9):
    """Aligned dimension: extension lines, dimension line, two arrows, text."""
    ang = math.atan2(y2 - y1, x2 - x1)
    nx, ny = -math.sin(ang), math.cos(ang)
    a = (x1 + nx * offset, y1 + ny * offset)
    b = (x2 + nx * offset, y2 + ny * offset)
    c.setStrokeColorRGB(*color)
    c.setLineWidth(0.4)
    c.line(x1, y1, a[0] + nx * 3, a[1] + ny * 3)
    c.line(x2, y2, b[0] + nx * 3, b[1] + ny * 3)
    c.line(a[0], a[1], b[0], b[1])
    arrow(c, a[0], a[1], ang + math.pi, color=color)
    arrow(c, b[0], b[1], ang, color=color)
    c.saveState()
    c.setFillColorRGB(*color)
    c.translate((a[0] + b[0]) / 2 + nx * 2, (a[1] + b[1]) / 2 + ny * 2)
    c.rotate(math.degrees(ang))
    c.setFont(font, size)
    c.drawCentredString(0, 0, text)
    c.restoreState()


def label(c, x, y, text, size=9, color=BLACK, font="Helvetica", rot=0):
    c.saveState()
    c.setFillColorRGB(*color)
    c.translate(x, y)
    c.rotate(rot)
    c.setFont(font, size)
    c.drawString(0, 0, text)
    c.restoreState()


def label_per_char(c, x, y, text, size=9, color=BLACK):
    """Draw every character with its own text object, as some CAD PDF drivers do."""
    c.setFillColorRGB(*color)
    for ch in text:
        c.setFont("Helvetica", size)
        c.drawString(x, y, ch)
        x += pdfmetrics.stringWidth(ch, "Helvetica", size)


def leader(c, pts, color=BLACK):
    c.setStrokeColorRGB(*color)
    c.setLineWidth(0.4)
    p = c.beginPath()
    p.moveTo(*pts[0])
    for q in pts[1:]:
        p.lineTo(*q)
    c.drawPath(p, stroke=1, fill=0)
    (x0, y0), (x1, y1) = pts[0], pts[1]
    arrow(c, x0, y0, math.atan2(y0 - y1, x0 - x1), color=color)


def tube(c, x1, y1, x2, y2, w=8):
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(0.7)
    c.line(x1, y1 + w / 2, x2, y2 + w / 2)
    c.line(x1, y1 - w / 2, x2, y2 - w / 2)


def hex_bolt(c, cx, cy, r=7):
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(0.6)
    p = c.beginPath()
    for i in range(6):
        a = math.pi / 6 + i * math.pi / 3
        (p.moveTo if i == 0 else p.lineTo)(cx + r * math.cos(a), cy + r * math.sin(a))
    p.close()
    c.drawPath(p, stroke=1, fill=0)
    c.circle(cx, cy, r * 0.55, stroke=1, fill=0)


def tiny_png():
    """A 16x16 RGB gradient PNG, used as an embedded image (e.g. a logo)."""
    w = h = 16
    raw = b"".join(b"\x00" + bytes(v for x in range(w) for v in (x * 16, y * 16, 160)) for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(
        b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def sample_defrost_heater():
    c = canvas.Canvas(os.path.join(OUT, "defrost-heater.pdf"), pagesize=landscape(A3))
    # serpentine heater (plan view)
    for y in (380, 340, 300, 260):
        tube(c, 470, y, 700, y)
    c.setLineWidth(0.7)
    for (cy, side) in ((360, 1), (320, -1), (280, 1)):
        x = 700 if side > 0 else 470
        for r in (16, 24):
            p = c.beginPath()
            p.arc(x - r, cy - r, x + r, cy + r, startAng=-90 * side, extent=180 * side)
            c.drawPath(p, stroke=1, fill=0)
    # leads + boots
    for y in (330, 300):
        c.rect(300, y - 4, 30, 8)
        c.rect(330, y - 6, 80, 12)
        tube(c, 410, y, 450, y, 8)
        c.line(260, y - 2, 300, y - 2)
        c.line(260, y + 2, 300, y + 2)
    # centre line (dash-dot)
    c.setDash([12, 3, 2, 3])
    c.setStrokeColorRGB(0.4, 0.4, 0.4)
    c.line(460, 320, 720, 320)
    c.setDash()
    dim_line(c, 330, 380, 450, 380, "88.9", offset=20)
    dim_line(c, 730, 260, 730, 384, "88.9", offset=-15)
    dim_line(c, 470, 256, 700, 256, "127", offset=-40)
    dim_line(c, 420, 256, 700, 256, "152.4", offset=-60)
    dim_line(c, 250, 298, 250, 332, "38.1", offset=-12, color=RED)
    dim_line(c, 460, 376, 460, 384, "8", offset=-12)
    leader(c, [(340, 420), (370, 450), (480, 450)])
    label(c, 485, 447, "Silicone rubber boot")
    leader(c, [(280, 300), (310, 250), (330, 250)])
    label(c, 335, 247, "305mm Silicone wire leads")
    # notes
    for i, t in enumerate(["Defrost tubular heater", "120V,475W", "Sheath tube:  304SS 8mmDia", "Length in mm"]):
        label(c, 520, 150 - i * 13, t, size=10)
    c.drawImage(ImageReader(io.BytesIO(tiny_png())), 1000, 60, 60, 60)
    label(c, 1000, 50, "LOGO", size=7)
    c.save()


def sample_flange_heater():
    c = canvas.Canvas(os.path.join(OUT, "flange-heater.pdf"), pagesize=landscape(A3))
    for i, t in enumerate(["Flange immersion Heater", "480V 3PH 27KW", "(15 Elements)", "Flange mat: 304SS",
                           "Element sheath:316SS Dia:12mm", "Length in mm"]):
        label(c, 560, 780 - i * 12, t, size=10)
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(0.8)
    c.rect(440, 580, 24, 150)
    for y in (610, 630, 650, 670, 690):
        tube(c, 464, y, 1000, y, 8)
    dim_line(c, 440, 730, 464, 730, "23.9", offset=20)
    label(c, 468, 755, "1.6mm")
    dim_line(c, 464, 730, 1000, 730, "939.8mm", offset=40)
    dim_line(c, 464, 730, 580, 730, "152.4mm", offset=8)
    label(c, 500, 715, "C-Z", size=11)
    dim_line(c, 464, 580, 700, 580, "", offset=-25, color=RED)
    for i, t in enumerate(["Thermowell", "ID>=8mm", "(For Process Temp. control)", "381 mm"]):
        label(c, 520, 560 - i * 11, t, color=RED)
    label(c, 860, 560, "Spacer")
    label(c, 860, 548, "OD<=148mm")
    label(c, 980, 590, "U Shaped tubular heater", size=7)
    label(c, 980, 582, "316SS sheath Dia=12mm", size=7)
    label(c, 980, 574, "Qty 15", size=7)
    # terminal box view with bolt heads around a circle (repeated geometry -> block)
    c.circle(260, 300, 140)
    c.setDash([2, 2])
    c.circle(260, 300, 100)
    c.setDash()
    for k in range(8):
        a = k * math.pi / 4
        hex_bolt(c, 260 + 122 * math.cos(a), 300 + 122 * math.sin(a))
    label(c, 220, 470, "#6-150 Terminal box", size=6)
    label(c, 90, 420, '3/4"NPT Gland', color=BLUE, size=10)
    label(c, 360, 410, '1.5"NPT Gland', color=BLUE, size=8)
    dim_line(c, 120, 200, 380, 80, "219.1mm", offset=-10, color=BLUE)
    dim_line(c, 450, 420, 640, 420, "165.1mm", offset=15, color=BLUE)
    # flange view
    c.circle(900, 280, 120)
    c.circle(900, 280, 80)
    c.setDash([10, 3, 2, 3])
    c.circle(900, 280, 100)
    c.setDash()
    for k in range(8):
        a = math.pi / 8 + k * math.pi / 4
        c.circle(900 + 100 * math.cos(a), 280 + 100 * math.sin(a), 6)
    label(c, 860, 430, "304SS Flange", size=10)
    label(c, 830, 410, "Dia\uff1a", color=BLACK, font="STSong-Light")
    label(c, 830, 398, "215.9mm")
    label(c, 760, 380, "Dia\uff1a", font="STSong-Light")
    label_per_char(c, 760, 368, "241. 3mm")
    label(c, 730, 330, "Flange Dia\uff1a", font="STSong-Light")
    label(c, 730, 318, "279. 4mm")
    label(c, 840, 150, "Thr holes", color=BLUE, size=10)
    label(c, 840, 137, "Dia 22.3mm(X8)", color=BLUE, size=10)
    label(c, 1110, 230, "Dia 215.9 mm", color=BLUE, size=10, rot=90)
    c.save()


def sample_arc_element():
    c = canvas.Canvas(os.path.join(OUT, "arc-element.pdf"), pagesize=landscape(A3))
    c.setStrokeColorRGB(*BLUE)
    c.setLineWidth(0.5)
    c.line(595, 750, 200, 480)
    c.line(595, 750, 990, 480)
    p = c.beginPath()
    p.arc(595 - 420, 750 - 420, 595 + 420, 750 + 420, startAng=214, extent=112)
    c.drawPath(p, stroke=1, fill=0)
    c.setStrokeColorRGB(*BLACK)
    for r in (520, 530):
        p = c.beginPath()
        p.arc(595 - r, 900 - r, 595 + r, 900 + r, startAng=236, extent=68)
        c.drawPath(p, stroke=1, fill=0)
    label(c, 580, 560, "112\u00b0", color=BLUE)
    label(c, 545, 520, "HOT ZONE 104.0\u00b0", color=BLUE)
    label(c, 960, 440, "C-Z", color=BLUE)
    label(c, 955, 428, "86.0\u00b0", color=BLUE)
    label(c, 1030, 400, "C-Z", color=BLUE, size=7, rot=-35)
    label(c, 1035, 390, "11.2 mm", color=BLUE, size=7, rot=-35)
    label(c, 610, 420, "C-L", color=BLUE)
    label(c, 610, 408, "R 330.2mm", color=BLUE)
    label(c, 960, 330, "C-Z", color=BLUE)
    label(c, 960, 318, "R 25. 4mm", color=BLUE)
    dim_line(c, 160, 300, 1030, 300, "610.61 mm", offset=-20, color=BLUE)
    label(c, 700, 200, "Element Dia =10. 9mm", color=BLUE)
    label(c, 700, 188, "Sheath tube:Incoloy or 310SS upon quoted", color=BLUE)
    label(c, 560, 140, "480V 1700W")
    label(c, 100, 560, "\u7d27\u56fa\u4ef6", color=BLUE, font="STSong-Light")
    label(c, 100, 548, '5/8"-18UNF', color=BLUE)
    label(c, 100, 536, "(\u9700\u65b9\u63d0\u4f9b)", color=BLUE, font="STSong-Light")
    label(c, 40, 420, "Post terminal", color=BLUE)
    label(c, 40, 408, "#10-32", color=BLUE)
    c.save()


def sample_shaft():
    """A stepped shaft with diameter callouts written in the ways drawings do."""
    c = canvas.Canvas(os.path.join(OUT, "shaft-diameters.pdf"), pagesize=landscape(A3))
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(0.8)
    # stepped shaft: (x0, x1, half height)
    steps = [(200, 330, 30), (330, 560, 48), (560, 760, 38), (760, 900, 22)]
    cy = 450
    for x0, x1, h in steps:
        c.rect(x0, cy - h, x1 - x0, 2 * h, stroke=1, fill=0)
    c.setDash([12, 3, 2, 3])
    c.setLineWidth(0.3)
    c.line(180, cy, 920, cy)
    c.setDash([])
    # vertical diameter dimensions on each step (text along the dimension line)
    dim_line(c, 265, cy - 30, 265, cy + 30, "\u00d860", offset=0)
    dim_line(c, 445, cy - 48, 445, cy + 48, "\u00d8 96.5", offset=0)
    dim_line(c, 660, cy - 38, 660, cy + 38, "\u00d876.2mm", offset=0, color=RED)
    dim_line(c, 830, cy - 22, 830, cy + 22, "\u00d844", offset=0)
    # lengths
    dim_line(c, 200, cy - 48, 560, cy - 48, "360", offset=-40)
    dim_line(c, 200, cy - 48, 900, cy - 48, "700", offset=-70)
    # holes and notes
    for x in (380, 510):
        c.circle(x, cy + 20, 6, stroke=1, fill=0)
    leader(c, [(386, cy + 26), (420, cy + 110), (470, cy + 110)])
    label(c, 475, cy + 107, "2X \u00d812 THRU")
    leader(c, [(900, cy + 22), (940, cy + 90), (990, cy + 90)])
    label(c, 995, cy + 87, "\u00d80.75 THRU", size=9)
    label(c, 600, cy + 130, "\u00d830 H7", size=11, color=BLUE)
    label(c, 960, 300, "Bore \u00d822.3mm", rot=-30, color=BLUE)
    label(c, 200, 220, "Shaft \u00d860 to \u00d844 stepped")
    label(c, 200, 205, "Length in mm")
    c.save()


DIMOVR = {"dimtxt": 2.5, "dimasz": 2.5, "dimexe": 1.25, "dimexo": 0.625, "dimlfac": 1, "dimdec": 1}


def sample_dxf():
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4  # mm
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0, 0, 0, 0), (150, 0, 0, 0, 0.4), (150, 80), (0, 80)], format="xyseb", close=True)
    msp.add_circle((40, 40), 15)
    msp.add_arc((110, 40), 20, 0, 180)
    blk = doc.blocks.new("BOLT")
    blk.add_circle((0, 0), 4)
    blk.add_line((-5, 0), (5, 0))
    blk.add_line((0, -5), (0, 5))
    for x in (20, 60, 100, 130):
        msp.add_blockref("BOLT", (x, 70))
    msp.add_linear_dim(base=(0, -15), p1=(0, 0), p2=(150, 0), dimstyle="Standard", override=DIMOVR).render()
    msp.add_linear_dim(base=(-15, 0), p1=(0, 0), p2=(0, 80), angle=90, dimstyle="Standard", override=DIMOVR).render()
    msp.add_radius_dim(center=(110, 40), radius=20, angle=60, dimstyle="Standard", override=DIMOVR).render()
    msp.add_diameter_dim(center=(40, 40), radius=15, angle=45, dimstyle="Standard", override=DIMOVR).render()
    msp.add_angular_dim_cra(center=(110, 40), radius=30, start_angle=0, end_angle=60, distance=5,
                            dimstyle="Standard", override=DIMOVR).render()
    msp.add_text("Length in mm", height=3.5).set_placement((0, -35))
    msp.add_text("Plate 6mm thick, 304SS", height=3.5).set_placement((0, -42))
    msp.add_mtext("Thr holes\\PDia 8.5mm(X4)", dxfattribs={"char_height": 3.0}).set_location((160, 70))
    doc.saveas(os.path.join(OUT, "plate.dxf"))


if __name__ == "__main__":
    import sys

    # one sample by name (python scripts/make_samples.py shaft), or all of them
    only = sys.argv[1:]
    for name, fn in [("defrost", sample_defrost_heater), ("flange", sample_flange_heater), ("arc", sample_arc_element), ("shaft", sample_shaft), ("dxf", sample_dxf)]:
        if not only or name in only:
            fn()
    print("samples written to", os.path.abspath(OUT))
