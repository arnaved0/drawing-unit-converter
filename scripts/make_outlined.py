"""Make copies of the sample PDFs whose text is drawn as filled glyph outlines.

Many CAD programs export text this way ("text as geometry"): the PDF has no
text at all, only the letter shapes, so nothing can be read without OCR. Each
character is replaced by its outline from Bitstream Vera Sans (bundled with
reportlab), at the same position, size, angle and colour. Characters the font
lacks (CJK) stay as real text.

Usage: python scripts/make_outlined.py   (needs pymupdf, fonttools, reportlab)
"""
import math
import os

import pymupdf
import reportlab
from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(__file__)
SAMPLES = os.path.join(HERE, "..", "samples")
OUT = os.path.join(SAMPLES, "outlined")
FONT = os.path.join(os.path.dirname(reportlab.__file__), "fonts", "Vera.ttf")


class ShapePen(BasePen):
    """Draws glyph contours into a PyMuPDF shape through an affine map."""

    def __init__(self, glyphset, shape, xf):
        super().__init__(glyphset)
        self.shape = shape
        self.xf = xf
        self.cur = None

    def p(self, pt):
        return pymupdf.Point(*self.xf(pt))

    def _moveTo(self, pt):
        self.cur = pt

    def _lineTo(self, pt):
        self.shape.draw_line(self.p(self.cur), self.p(pt))
        self.cur = pt

    def _curveToOne(self, p1, p2, p3):
        self.shape.draw_bezier(self.p(self.cur), self.p(p1), self.p(p2), self.p(p3))
        self.cur = p3

    def _closePath(self):
        pass


def outline(name: str, font_path: str = FONT, out_name: str = "", own_spacing: bool = False, width_factor: float = 1.0) -> None:
    """Outline the text of a sample.

    By default each letter goes where the original (Helvetica) letter was.
    With own_spacing, each span is laid out with the font's own advance widths
    (times width_factor), the way a CAD program exports text in that font.
    """
    font = TTFont(font_path)
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    upem = font["head"].unitsPerEm
    hmtx = font["hmtx"].metrics
    doc = pymupdf.open(os.path.join(SAMPLES, name + ".pdf"))
    for page in doc:
        chars = []
        for block in page.get_text("rawdict")["blocks"]:
            for line in block.get("lines", []):
                dx, dy = line["dir"]
                for span in line["spans"]:
                    color = span["color"]
                    rgb = ((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255
                    pen = None
                    for ch in span["chars"]:
                        if pen is None:
                            pen = ch["origin"]
                        origin = pen if own_spacing else ch["origin"]
                        if ord(ch["c"]) in cmap and ch["c"].strip():
                            chars.append((ch["c"], origin, span["size"], (dx, dy), rgb, ch["bbox"]))
                        if ord(ch["c"]) in cmap:
                            a = hmtx[cmap[ord(ch["c"])]][0] * span["size"] / upem * width_factor
                            pen = (pen[0] + a * dx, pen[1] + a * dy)
        # remove the text that gets outlined; keep drawings and images
        for c in chars:
            page.add_redact_annot(pymupdf.Rect(c[5]), fill=False)
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
        for c, (ox, oy), size, (dx, dy), rgb, _ in chars:
            glyph = cmap[ord(c)]
            k = size / upem
            # PyMuPDF page coordinates are y-down; dir is the baseline direction in them
            def xf(pt, ox=ox, oy=oy, k=k, dx=dx, dy=dy):
                u, v = pt[0] * k * width_factor, pt[1] * k
                return ox + u * dx + v * dy, oy + u * dy - v * dx
            shape = page.new_shape()
            gs[glyph].draw(ShapePen(gs, shape, xf))
            shape.finish(color=None, fill=rgb, closePath=True, even_odd=False)
            shape.commit()
    out = os.path.join(OUT, out_name or name + "-outlined.pdf")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    doc.save(out, garbage=3, deflate=True)
    print(os.path.relpath(out, SAMPLES), "outlined")


# Test drawings with a known font: text laid out in that font, as a CAD export would.
# Sources are the downloads of scripts/make_fonts.py (scratch/font-sources).
FONT_SOURCES = os.path.join(HERE, "..", "scratch", "font-sources")
FONT_SAMPLES = [
    ("vera", FONT, 1.0),
    ("tinos", os.path.join(FONT_SOURCES, "Tinos-Regular.ttf"), 1.0),
    ("osifont", os.path.join(FONT_SOURCES, "osifont-lgpl3fe.ttf"), 1.0),
    ("osifont-narrow", os.path.join(FONT_SOURCES, "osifont-lgpl3fe.ttf"), 0.8),
    ("tinos-bold", os.path.join(FONT_SOURCES, "Tinos-Bold.ttf"), 1.0),
]


if __name__ == "__main__":
    for n in ("defrost-heater", "flange-heater", "arc-element"):
        outline(n)
    for tag, path, wf in FONT_SAMPLES:
        outline("defrost-heater", path, os.path.join("fonts", f"defrost-{tag}.pdf"), own_spacing=True, width_factor=wf)
    _ = math
