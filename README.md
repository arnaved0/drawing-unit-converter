# Drawing Unit Converter

A browser tool for engineers: open an engineering drawing (**PDF, DXF or DWG**),
click a dimension to convert it to another unit, then download the result as
**DXF** or **PDF**. Everything runs in the browser, so drawings are never uploaded.

**Live app:** https://arnaved0.github.io/drawing-unit-converter/

## How to use

1. Click **Open drawing…** or drop a file on the page.
2. In the side panel, choose the target unit (mm, cm, m, decimal inches,
   fractional inches, feet, feet-and-inches), the precision and the label style.
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
* **Scanned PDFs** (images of drawings) need OCR, which is planned. Text that the
  PDF stores as outlines cannot be detected either.
* PDF geometry is exported at paper scale (1 mm on the sheet = 1 drawing unit),
  not at the real size of the part.
* In PDF output, the old value is covered with a white box and the new value is
  drawn on top in Helvetica. The old text is still in the file underneath, so
  copy/search can find it.
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
  render/svg.ts         Model -> SVG preview
  export/dxfPatch.ts    In-place edit of the original DXF
  export/dxfR12.ts      Model -> DXF R12
  export/pdf.ts         PDF overlay (PDF input) and vector plot (DXF/DWG input)
```

Pushing to `main` runs the tests and deploys to GitHub Pages
(`.github/workflows/deploy.yml`).

## License

GPL-3.0-or-later, because the DWG reader (LibreDWG) is GPL-3.0. See [LICENSE](LICENSE).
