"""Turn the vector sample PDFs into scan-like, image-only PDFs.

Each page is rasterised, slightly rotated, blurred, given noise and JPEG
compression, and placed as the only content of a new PDF page of the same
size, which is what a scanner or "print to image" produces.

Usage: python scripts/make_scans.py   (needs pymupdf and pillow)
"""
import io
import os
import random

import pymupdf
from PIL import Image, ImageFilter

HERE = os.path.dirname(__file__)
SAMPLES = os.path.join(HERE, "..", "samples")
OUT = os.path.join(SAMPLES, "scanned")
os.makedirs(OUT, exist_ok=True)


def shade(img: Image.Image) -> Image.Image:
    """Grey, unevenly lit paper like a phone photo or an old photocopy."""
    w, h = img.size
    big = int((w * w + h * h) ** 0.5) + 2
    grad = Image.linear_gradient("L").resize((big, big)).rotate(30, expand=False)
    grad = grad.crop(((big - w) // 2, (big - h) // 2, (big - w) // 2 + w, (big - h) // 2 + h))
    paper = Image.merge("RGB", [grad.point(lambda v, o=o: 150 + o + v * 70 // 255) for o in (12, 8, 0)])
    from PIL import ImageChops
    return ImageChops.multiply(img, paper)


def scan(name: str, dpi: int, skew: float, noise: int, seed: int, out_name: str = "", shaded: bool = False) -> None:
    random.seed(seed)
    src = pymupdf.open(os.path.join(SAMPLES, name + ".pdf"))
    page = src[0]
    pix = page.get_pixmap(dpi=dpi)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    img = img.rotate(skew, resample=Image.BICUBIC, expand=False, fillcolor=(255, 255, 255))
    if shaded:
        img = shade(img)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    px = img.load()
    w, h = img.size
    for _ in range(w * h // 400):  # speckles
        x, y = random.randrange(w), random.randrange(h)
        v = random.randrange(150, 230)
        px[x, y] = (v, v, v)
    if noise:
        noise_img = Image.effect_noise((w, h), noise).convert("RGB")
        img = Image.blend(img, noise_img, 0.06)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=70)
    out = pymupdf.open()
    p = out.new_page(width=page.rect.width, height=page.rect.height)
    p.insert_image(p.rect, stream=buf.getvalue())
    out.save(os.path.join(OUT, (out_name or name + "-scan") + ".pdf"), deflate=True)
    print(out_name or name, f"{w}x{h}px", f"{len(buf.getvalue()) // 1024} KB")


if __name__ == "__main__":
    scan("defrost-heater", 200, 0.4, 20, 1)
    scan("flange-heater", 200, -0.3, 25, 2)
    scan("arc-element", 150, 0.0, 20, 3)
    # harder: low resolution, tilted, grey unevenly lit paper
    scan("flange-heater", 150, 1.2, 30, 4, out_name="flange-heater-photocopy", shaded=True)
