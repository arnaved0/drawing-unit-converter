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
   * **DWG**: not available yet (see *Limitations*).

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

When a boxed value is converted, the whole region you drew is covered, so no
part of the old text shows through (in the preview and the downloaded PDF).

Every add and remove can be undone with the **Undo** button in the message
that appears, or with Ctrl+Z (Cmd+Z). Esc returns to Convert. Right-drag pans
the drawing in every mode.

### Editing one dimension

Each row in the **Dimensions** list has a **⌄** button that opens a small
panel for that dimension:

* **Converted text**: type exactly what the new value should read
  (for example `6 IN. TYP`). Applied when you press Enter or leave the field.
* **Decimals** and **Suffix**: override the Settings for this dimension only
  (for example 0 decimals and `"` gives `6"`; **None** drops the unit label).
* **Reset** clears these overrides. **Move text back** undoes a move (see below).

Changing any of these converts the dimension. Edited rows are marked with *.

### Moving converted text

Each converted value has a round handle just before it. Drag the handle to
move the new text. The white patch stays over the original value, so the old
text stays hidden. Moves can be undone like any other change.

### Multi-page PDFs

Each page keeps its own boxes, conversions, edits and zoom when you switch
pages, and is only scanned the first time you open it. The PDF download
includes the changes from every page you worked on.

### Which values count as dimensions

* A number with a length unit anywhere in a text: `305mm Silicone wire leads`,
  `Dia 22.3mm(X8)`, `OD<=148mm`, `381 mm`, `279. 4mm`.
* A bare number when the text is only a dimension: `88.9`, `R 25.4`, `Ø12`, `2X R5`.
* Every number in a real DXF/DWG DIMENSION entity, except angular dimensions.

Prefixes and suffixes are kept: `R 330.2mm` becomes `R 13.00in`, and
`Dia 22.3mm(X8)` becomes `Dia 0.88in(X8)`. These are left alone: angles (`112°`),
thread and pipe sizes (`3/4"NPT`, `5/8"-18UNF`, `#10-32`), counts (`(X8)`,
`Qty 15`), electrical ratings (`480V`, `27KW`) and material grades (`304SS`).
Values without a unit are read in the drawing unit. It is detected from notes
like "Length in mm" or the DXF `$INSUNITS` setting, and can be changed in the panel.

## Limitations

* **DWG export** is not built yet. No open-source library can write DWG reliably
  in a browser. The plan is a small conversion server. Until then, download the
  DXF and save it as DWG in your CAD program.
* **Scanned PDFs:** text in a scan is read by the Scan & OCR step, but the scan's
  lines stay an image. They are not traced into DXF geometry.
* PDF geometry is exported at paper scale (1 mm on the sheet = 1 drawing unit),
  not at the real size of the part.
* In PDF output, the old value is covered with a white box and the new value is
  drawn on top in Helvetica. The old text is still in the file underneath, so
  copy/search can find it.
* For PDF input, the DXF download contains only the page on screen.
* If converted text has been moved in a DXF/DWG drawing, **DXF** downloads the
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
text, like PDFs exported with "text as geometry".

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
The text-layer method follows PdfCraft (Apache-2.0).
