# Drawing Unit Converter

A browser tool for engineers: open an engineering drawing (**PDF, DXF or DWG**),
click a dimension to convert it to another unit, then download the result as
**DXF** or **PDF**. Everything runs in the browser, so drawings are never uploaded.

**Live app:** https://arnaved0.github.io/drawing-unit-converter/

## How to use

1. Click **Open drawing…** or drop a file on the page.
2. In the side panel, pick the **Original unit** (used for values written
   without a unit, detected from notes like "Length in mm") and the **New unit**
   (mm, cm, m, decimal inches, fractional inches, feet, feet-and-inches).
   Decimal places, fraction rounding, unit labels, Scan & OCR and highlighting
   are under **Settings**.
3. Click a highlighted dimension in the drawing (or in the list) to convert it.
   Click it again to undo. **Convert all** and **Reset all** work on every dimension.
4. Download:
   * **DXF**: for DXF/DWG input, this is the original file with only the converted
     texts and dimension overrides changed. For PDF input, it is a DXF R12 built
     from the recognised geometry.
   * **DXF R12** (DXF/DWG input): a simplified copy that opens in any CAD program.
   * **PDF**: for PDF input, the original page with the converted values written
     over the old ones. For DXF/DWG input, a vector plot on an A3 sheet.

   There is no DWG download: save the DXF as DWG in your CAD program.

## What it recognises

| Input | How it is read |
| --- | --- |
| PDF (vector, e.g. exported from CAD) | [pdf.js](https://mozilla.github.io/pdf.js/) reads the page content. Bezier curves that are circular arcs become ARC/CIRCLE entities, lines and rectangles become LINE/POLYLINE, filled triangles (arrowheads) become SOLID. Text keeps its position, rotation, size and colour; text written one character at a time is merged back into words. Embedded images are kept. Groups of geometry that repeat (for example bolt heads) become blocks with one INSERT per copy. |
| DXF | [dxf-parser](https://github.com/gdsestimating/dxf-parser). DIMENSION entities, TEXT, MTEXT, blocks, polylines with arcs, splines and ellipses. |
| DWG | [LibreDWG](https://www.gnu.org/software/libredwg/) compiled to WebAssembly ([libredwg-web](https://github.com/mlightcad/libredwg-web)) converts DWG to DXF in the browser; the DXF path then reads it. The reader (about 11 MB) is only downloaded when a DWG is opened. |

### Scan & OCR before import (PDF)

Many CAD programs export text as drawn letter shapes instead of real text,
and scanned drawings have no text at all. So every PDF first goes through a
Scan & OCR step, then into the converter:

1. The page is rendered at 200 dpi and its text is recognised in a Web Worker
   with [PaddleOCR PP-OCRv5](https://github.com/PaddlePaddle/PaddleOCR) (mobile
   models, about 21 MB, downloaded once and cached) on
   [ONNX Runtime Web](https://onnxruntime.ai/). Text at any angle is found,
   including vertical and slanted dimensions.
2. The recognised text is written back into the PDF as an **invisible text
   layer**, the way [PdfCraft](https://github.com/storytold/pdfcraft)'s Scan &
   OCR does it (text rendering mode 3, standard Helvetica stretched over each
   line, inside an `/OCR` marked-content block). The page looks exactly as
   before but now has real, searchable text.
3. The converter reads that PDF. Words that the page already had as real text
   are not added again, so normal PDFs come through unchanged.

The letter shapes under OCR text are kept in the preview and the PDF, so the
drawing looks like the original. A converted value is drawn on a white patch
over the original, from the value to the end of its line. In the DXF, the
letter shapes are replaced by TEXT entities. The downloaded PDF keeps the
searchable text layer.

The step can be switched off under **Settings** (**Read text with Scan & OCR
first**). Characters the standard PDF font cannot hold (Chinese, for example)
are not added to the text layer; they stay as drawn.

OCR can misread characters, so check converted values against the drawing.

### Adding and removing boxes

The **Boxes** controls in the side panel choose what a click on the drawing does:

* **Convert** (default): click a box to convert its value.
* **+ Add box**: drag a box around a dimension that was missed. On a PDF, the
  text inside it is read with OCR and shown for you to check or correct
  before it is added; on DXF/DWG you type it. Every number in a box counts as
  a length (angles excepted). A box drawn over a wrongly read value replaces it.
* **− Remove box**: click a box to remove it. The **×** in the dimension list
  does the same in any mode.

When a boxed value is converted, exactly the region you drew is whited out,
and nothing outside it: no part of the old text inside the box shows through,
and lines and text next to the box stay as they are (in the preview and the
downloaded PDF). The value is then written again in the box.

Every add and remove can be undone with the **Undo** button in the message
that appears, or with Ctrl+Z (Cmd+Z). Esc returns to Convert. Right-drag pans
the drawing in every mode.

### Custom unit

Choose **Custom…** as the new unit and fill in one line:

`1 [original suffix] = [factor] [new suffix]`

for example `1 mm = 39.37 mil`, or `1 u = 2.5 pt` for a unit of your own. The
factor can be a number or a fraction (`1/25.4`). Every converted value is
multiplied by it and gets the new suffix; decimal places, trailing zeros and
"Add unit label" from Settings still apply.

* Values without a unit, and values written with the original suffix
  (`12 u`, `12u`), are in the original unit. A suffix of your own makes those
  values clickable as soon as you leave the field. It works for any unit,
  not only lengths: `1 V = 1/1000 kV` or `1 ° = 0.0174533 rad` make `480V`
  and `45°` convertible, in the scan and in boxes you draw. A prefixed form
  (`3.5 kV` when the original suffix is `V`) is a different unit and is left alone.
* If the original suffix is a standard unit (`mm`, `in` …), values in other
  standard units are converted to it first (`5 in` with `1 mm = 2 mm` gives
  `254.00 mm`). Otherwise they are left as they are, with a message.

### Editing one dimension

Each row in the **Dimensions** list has a **⌄** button that opens a small
panel for that dimension:

* **Converted text**: type exactly what the new value should read
  (for example `6 IN. TYP`). Applied when you press Enter or leave the field.
* **Text size**: **−** and **+** make the converted text smaller or larger
  in 10% steps (50% to 300%). It stays centred on the original line, and the
  PDF and DXF R12 downloads use the same size. The size belongs to the whole
  line of text the value is in.
* **Diameter sign (Ø)**: add a Ø in front of the converted value, or take
  out the drawing's own.
* **Reset** clears these overrides. **Move text back** undoes a move (see below).

Changing any of these converts the dimension. Edited rows are marked with *.

### Moving converted text

A round handle appears just before a converted value when the pointer is on
or near it (on a touch screen, tap near the value). Drag the handle to move
the new text. The white patch stays over the original value, so the old text
stays hidden. Moves can be undone like any other change.

### Font and size of converted values

A converted value is written in the same size and style as the text it
replaces. The app carries open fonts that look like the usual drawing fonts:

| Looks like | Font used |
| --- | --- |
| Arial, Helvetica | Arimo (regular, bold) |
| Times New Roman | Tinos (regular, bold) |
| Courier New | Cousine (regular, bold) |
| Verdana, DejaVu, Bitstream Vera | DejaVu Sans (regular, bold) |
| ISOCPEUR, romans, simplex and other CAD lettering | osifont (ISO 3098) |

* **Real PDF text:** the font is chosen from the font name in the PDF, and
  stretched to the original's exact width.
* **Text read by Scan & OCR** (letter shapes or scans): the letters of each
  line are compared with every font, drawn over them. The best match gives
  the font, bold or regular, sloped or upright, the size and the width factor
  (for example 80% wide CAD lettering). A page gets one font family, so short
  values like "8" follow the rest of the drawing. On the test drawings most
  sizes come out within 2% of the original; a short value squeezed between
  arrowheads can be off by up to about 15%.
* **Boxes** use the font of the letters in the box, or the page's font when
  nothing could be read.

The preview and the PDF download use these fonts, which are embedded in the
PDF. The DXF R12 download sets a matching text style (`arial.ttf`,
`isocpeur.ttf` ...), the cap height, width factor and oblique angle. For
DXF/DWG input, a converted value keeps its own TEXT/MTEXT entity, so CAD
shows it in the drawing's own text style.

### Multi-page PDFs

Use the arrows at the bottom of the drawing (or Page Up / Page Down) to move
between pages; the page number is shown between them. Each page keeps its own
boxes, conversions, edits and zoom when you switch pages, and is only scanned the first time you open it. The PDF download
includes the changes from every page you worked on.

### Diameter sign (Ø)

Values with a diameter sign keep it when converted: `Ø60` becomes `Ø2.36 in`,
`2X Ø12 THRU` becomes `2X Ø0.47 in THRU`. Every way drawings write the sign is
read: `Ø`, `⌀`, `∅`, `φ`, `Φ`, `ø` and AutoCAD's `%%c`, as well as fit classes
after it (`Ø30 H7`). The PDF writes it as Ø in the matching font, and the DXF
R12 as `%%c`.

The OCR model has no Ø in its alphabet. It reads the sign as a `0`
(`Ø60` → `060`), an `O` or a `D`, leaves it out (`Ø30 H7` → `30 H7`), or
reads the whole value upside down (`Ø60` → `090`). So after Scan & OCR, each
line that holds a number is checked against the letter shapes on the page:
texts with a Ø in each possible place are drawn in the line's font and
compared with the letters (see *Font and size of converted values*). A Ø is
put in only where it matches clearly better than what was read, and better
than a plain `O` in the same place, and only in front of a length (never in
`304SS` or `120V`). On the test drawings (Arial-like, ISO and serif lettering)
every Ø was found, with its spacing (`Ø 96.5` stays spaced), and none was
added to drawings without one. Boxes you draw are read the same way, and the
box dialog has a **Ø** button for typing it.

### Which values count as dimensions

* A number with a length unit anywhere in a text: `305mm Silicone wire leads`,
  `Dia 22.3mm(X8)`, `OD<=148mm`, `381 mm`, `279. 4mm`.
* A bare number when the text is only a dimension: `88.9`, `R 25.4`, `Ø12`,
  `2X R5`, `Ø30 H7`, `2X Ø12 THRU`.
* Every number in a real DXF/DWG DIMENSION entity, except angular dimensions.

Prefixes and suffixes are kept: `R 330.2mm` becomes `R 13.00in`, and
`Dia 22.3mm(X8)` becomes `Dia 0.88in(X8)`. These are left alone: angles (`112°`),
thread and pipe sizes (`3/4"NPT`, `5/8"-18UNF`, `#10-32`), counts (`(X8)`,
`Qty 15`), electrical ratings (`480V`, `27KW`) and material grades (`304SS`).
Values without a unit are read in the drawing unit. It is detected from notes
like "Length in mm" or the DXF `$INSUNITS` setting, and can be changed in the panel.

## Limitations

* **No DWG download.** No open-source library can write DWG reliably in a
  browser. Download the DXF and save it as DWG in your CAD program.
* **Scanned PDFs:** text in a scan is read by the Scan & OCR step, but the scan's
  lines stay an image. They are not traced into DXF geometry.
* PDF geometry is exported at paper scale (1 mm on the sheet = 1 drawing unit),
  not at the real size of the part.
* In PDF output, the old value is covered with a white box and the new value is
  drawn on top in the matching font. The old text is still in the file
  underneath, so copy/search can find it.
* The fonts are lookalikes, not the drawing's own font files. A font that looks
  like none of them (a script or decorative font) gets the closest one.
* The DXF/DWG preview draws text in Arial (dxf-parser does not read text styles);
  the DXF download is not affected.
* For PDF input, the DXF download contains only the page on screen.
* If converted text has been moved or resized in a DXF/DWG drawing, **DXF** downloads the
  simplified R12 copy, since the original file has no place for the white patch.
* Your work is kept while the page is open, not after a reload.
* DXF entities that dxf-parser does not support (HATCH, MLEADER, tables …) are
  not shown in the preview, but the DXF download keeps them, because it patches
  the original file.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit and round-trip tests (vitest)
npm run build      # production build in dist/
```

`scripts/make_samples.py` regenerates the sample drawings in `samples/`
(needs `pip install reportlab ezdxf`). They imitate the PDFs the tool was
designed for: CAD-exported heater drawings with coloured, rotated and per-character
text, CJK labels, dash-dot centre lines and repeated bolt heads.
`scripts/make_outlined.py` (needs `pymupdf fonttools`) makes copies in
`samples/outlined/` with every letter drawn as a filled outline and no real
text, like PDFs exported with "text as geometry". `samples/outlined/fonts/`
holds the same drawing lettered in other fonts (DejaVu, Tinos, Tinos Bold,
osifont, osifont at 80% width) and `samples/shaft-diameters.pdf` (diameter
callouts) in three letterings, for testing the font matching and the Ø reading.
`scripts/make_fonts.py` (needs `fonttools`) downloads the fonts, cuts them
down to Latin-1 and drawing symbols, and writes `public/fonts/` and
`src/fonts/metrics.ts`.

### Layout

```
src/
  main.ts               UI: file loading, side panel, pan/zoom, click-to-convert, downloads
  model.ts              Drawing model (DXF-style entities)
  dimensions.ts         Finding lengths in text, conversion, display text
  units.ts              Unit maths and number formatting (decimal, fractions, ft-in)
  importers/pdf.ts      PDF -> model (pdf.js operator list + text content)
  importers/dxf.ts      DXF -> model (dxf-parser)
  importers/dwg.ts      DWG -> DXF (LibreDWG WebAssembly) -> model
  analysis/shapes.ts    Bezier/path -> line, arc, circle, polyline, solid
  analysis/blocks.ts    Repeated geometry -> blocks
  boxes.ts              Dimension boxes added or removed by hand
  ocr/preprocess.ts     Scan & OCR: render page, recognise text, add the text layer
  ocr/textLayer.ts      Invisible text layer (PdfCraft's method) written with pdf-lib
  ocr/engine.ts         PP-OCRv5 text detection + recognition (rotated text, stacked lines)
  ocr/worker.ts         Web Worker that runs text recognition off the main thread
  ocr/diameter.ts       Puts back the Ø that OCR cannot read, by comparing letter shapes
  fonts/faces.ts        The bundled fonts: names, widths, font-name lookup, loading
  fonts/match.ts        Matching OCR letters to a font, size and width factor
  fonts/metrics.ts      Font widths (generated by scripts/make_fonts.py)
  render/svg.ts         Model -> SVG preview
  export/dxfPatch.ts    In-place edit of the original DXF
  export/dxfR12.ts      Model -> DXF R12
  export/pdf.ts         PDF overlay (PDF input) and vector plot (DXF/DWG input)
```

Pushing to `main` runs the tests and deploys to GitHub Pages
(`.github/workflows/deploy.yml`).

## License

GPL-3.0-or-later, because the DWG reader (LibreDWG) is GPL-3.0. See [LICENSE](LICENSE).
The OCR models in `public/models/ppocrv5/` are Apache-2.0 (see the README there).
The text-layer method follows PdfCraft (Apache-2.0). The fonts in
`public/fonts/` keep their own licences: Arimo, Tinos and Cousine are SIL OFL
1.1, DejaVu Sans has the Bitstream Vera licence, osifont is LGPL-3 with font
exception (see `public/fonts/README.md`). They are renamed "DUC ..." because
they are cut-down copies.
