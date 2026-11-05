"""Build the fonts the converter writes converted values in.

A converted value should look like the text it replaces, so the app carries
a few open fonts that look like the common drawing fonts:

    sans     Arimo          (same shapes and widths as Arial / Helvetica)
    serif    Tinos          (Times New Roman)
    mono     Cousine        (Courier New)
    dejavu   DejaVu Sans    (Bitstream Vera, Verdana-like)
    iso      osifont        (ISO 3098 CAD lettering, like ISOCPEUR / romans)

Each is cut down to Latin-1 plus the symbols drawings use (about 20-60 KB),
written to public/fonts/, and its metrics go to src/fonts/metrics.ts so text
widths are known without loading a font.

Usage: python scripts/make_fonts.py   (needs fonttools; downloads the sources once)
"""
import json
import os
import shutil
import tarfile
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
CACHE = os.path.join(ROOT, "scratch", "font-sources")
OUT = os.path.join(ROOT, "public", "fonts")
METRICS = os.path.join(ROOT, "src", "fonts", "metrics.ts")

GF = "https://raw.githubusercontent.com/google/fonts/main/ofl"
SOURCES = {
    "Arimo[wght].ttf": f"{GF}/arimo/Arimo%5Bwght%5D.ttf",
    "Arimo-OFL.txt": f"{GF}/arimo/OFL.txt",
    "Tinos-Regular.ttf": f"{GF}/tinos/Tinos-Regular.ttf",
    "Tinos-Bold.ttf": f"{GF}/tinos/Tinos-Bold.ttf",
    "Cousine-Regular.ttf": f"{GF}/cousine/Cousine-Regular.ttf",
    "Cousine-Bold.ttf": f"{GF}/cousine/Cousine-Bold.ttf",
    "Cousine-OFL.txt": f"{GF}/cousine/OFL.txt",
    "dejavu.tar.bz2": "https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2",
    "osifont-lgpl3fe.ttf": "https://raw.githubusercontent.com/hikikomori82/osifont/master/osifont-lgpl3fe.ttf",
}

# id, source file, variable-font weight (None for static fonts)
FACES = [
    ("sans", "Arimo[wght].ttf", 400),
    ("sans-bold", "Arimo[wght].ttf", 700),
    ("serif", "Tinos-Regular.ttf", None),
    ("serif-bold", "Tinos-Bold.ttf", None),
    ("mono", "Cousine-Regular.ttf", None),
    ("mono-bold", "Cousine-Bold.ttf", None),
    ("dejavu", "DejaVuSans.ttf", None),
    ("dejavu-bold", "DejaVuSans-Bold.ttf", None),
    ("iso", "osifont-lgpl3fe.ttf", None),
]

# Latin-1, typographic punctuation, and drawing symbols (Ø ⌀ ° ± × ′ ″ ≤ ≥ − Φ φ)
UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x100))
    + [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2032, 0x2033, 0x2212, 0x2264, 0x2265, 0x2300, 0x03A6, 0x03C6]
)


def fetch() -> None:
    os.makedirs(CACHE, exist_ok=True)
    for name, url in SOURCES.items():
        path = os.path.join(CACHE, name)
        if not os.path.exists(path):
            print("downloading", url)
            urllib.request.urlretrieve(url, path)
    if not os.path.exists(os.path.join(CACHE, "DejaVuSans.ttf")):
        with tarfile.open(os.path.join(CACHE, "dejavu.tar.bz2")) as tar:
            for m in tar.getmembers():
                base = os.path.basename(m.name)
                if base in ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "LICENSE"):
                    with tar.extractfile(m) as src, open(os.path.join(CACHE, "DejaVu-" + base if base == "LICENSE" else base), "wb") as dst:
                        shutil.copyfileobj(src, dst)


def build(face_id: str, src: str, wght) -> dict:
    font = TTFont(os.path.join(CACHE, src))
    if wght is not None:
        font = instancer.instantiateVariableFont(font, {"wght": wght})
    opts = subset.Options()
    opts.layout_features = ["kern"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.hinting = False
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=UNICODES)
    sub.subset(font)
    # A cut-down copy gets its own name, so it is never taken for the full
    # font (by a browser, a PDF reader or a system font fallback).
    family = {"sans": "DUC Sans", "serif": "DUC Serif", "mono": "DUC Mono", "dejavu": "DUC Wide", "iso": "DUC ISO"}[face_id.replace("-bold", "")]
    style = "Bold" if face_id.endswith("-bold") else "Regular"
    name = font["name"]
    for rec in list(name.names):
        if rec.nameID in (1, 4, 6, 16, 17, 21, 22):
            name.removeNames(nameID=rec.nameID)
    name.setName(family, 1, 3, 1, 0x409)
    name.setName(style, 2, 3, 1, 0x409)
    name.setName(f"{family} {style}", 4, 3, 1, 0x409)
    name.setName(f"{family.replace(' ', '')}-{style}", 6, 3, 1, 0x409)
    out = os.path.join(OUT, face_id + ".ttf")
    font.save(out)

    upem = font["head"].unitsPerEm
    os2 = font["OS/2"]
    hhea = font["hhea"]
    cmap = font.getBestCmap()
    hmtx = font["hmtx"].metrics
    glyf = font["glyf"] if "glyf" in font else None

    def ink_top(ch: str) -> int:
        g = glyf[cmap[ord(ch)]]
        return getattr(g, "yMax", 0) or 0

    cap = getattr(os2, "sCapHeight", 0) or ink_top("H")
    xh = getattr(os2, "sxHeight", 0) or ink_top("x")
    adv = {chr(u): hmtx[g][0] for u, g in sorted(cmap.items()) if u in UNICODES}
    return {
        "upem": upem,
        "ascent": hhea.ascent,
        "descent": hhea.descent,
        "cap": cap,
        "xHeight": xh,
        "size": os.path.getsize(out),
        # advances as one string of numbers in the order of `chars`
        "chars": "".join(adv.keys()),
        "adv": list(adv.values()),
    }


def main() -> None:
    fetch()
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.dirname(METRICS), exist_ok=True)
    metrics = {}
    for face_id, src, wght in FACES:
        metrics[face_id] = build(face_id, src, wght)
        print(f"{face_id:12s} {metrics[face_id]['size'] / 1024:6.1f} KB")
    for name, target in [("Arimo-OFL.txt", "OFL-Arimo-Tinos-Cousine.txt"), ("DejaVu-LICENSE", "LICENSE-DejaVu.txt")]:
        shutil.copy(os.path.join(CACHE, name), os.path.join(OUT, target))
    with open(os.path.join(OUT, "README.md"), "w") as f:
        f.write(
            "# Fonts for converted values\n\n"
            "Made by `scripts/make_fonts.py` (subsets of the original fonts).\n\n"
            "| File | Font | License |\n| --- | --- | --- |\n"
            "| sans*.ttf | Arimo (Google) | SIL Open Font License 1.1 (OFL-Arimo-Tinos-Cousine.txt) |\n"
            "| serif*.ttf | Tinos (Google) | SIL Open Font License 1.1 |\n"
            "| mono*.ttf | Cousine (Google) | SIL Open Font License 1.1 |\n"
            "| dejavu*.ttf | DejaVu Sans | Bitstream Vera / DejaVu license (LICENSE-DejaVu.txt) |\n"
            "| iso.ttf | osifont (https://github.com/hikikomori82/osifont) | GNU LGPL 3 with font exception |\n"
        )
    lines = [
        "// Generated by scripts/make_fonts.py. Do not edit.",
        "// Metrics of the fonts in public/fonts, in font units.",
        "",
        "export interface FaceMetrics {",
        "  upem: number;",
        "  ascent: number;",
        "  descent: number;",
        "  cap: number;",
        "  xHeight: number;",
        "  /** Characters the font has, in the order of `adv`. */",
        "  chars: string;",
        "  adv: number[];",
        "}",
        "",
        "export const METRICS: Record<string, FaceMetrics> = {",
    ]
    for face_id, m in metrics.items():
        m = {k: v for k, v in m.items() if k != "size"}
        lines.append(f"  {json.dumps(face_id)}: {json.dumps(m, ensure_ascii=False)},")
    lines += ["};", ""]
    with open(METRICS, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("wrote", METRICS)


if __name__ == "__main__":
    main()
