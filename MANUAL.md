# Drawing Unit Converter: quick guide

Open the tool at https://arnaved0.github.io/drawing-unit-converter/. Files stay in your browser and are never uploaded.

## 1. Open a drawing
Click **Open drawing…** or drop a **PDF, DXF or DWG** file on the page.

- PDFs are scanned first (Scan & OCR), so text drawn as shapes or scanned images can be read. This takes a few seconds per page.
- For a PDF with several pages, use the **‹ ›** arrows at the bottom (or Page Up / Page Down). Each page keeps its own changes.

## 2. Choose the units
In the **Units** panel on the right:

- **Original unit**: the unit of values written without one. It is usually detected from notes like "Length in mm".
- **New unit**: mm, cm, m, decimal or fractional inches, feet, or feet-and-inches.
- **Custom…**: fill in `1 [original suffix] = [factor] [new suffix]`, for example `1 mm = 39.37 mil` or `1 V = 1/1000 kV`.
- **Settings** (gear button): decimal places, fraction rounding, unit label, inch sign, trailing zeros, Scan & OCR on or off, and highlighting.

## 3. Convert
- Click a highlighted dimension on the drawing, or in the **Dimensions** list, to convert it. Click it again to undo.
- **Convert all** and **Reset all** apply to every dimension.

Values like `Ø60`, `R 25.4`, `3 3/8"`, `5'-6"` and `2X Ø12 THRU` keep their prefixes and suffixes. Angles, thread sizes, voltages and material grades are left alone.

## 4. Fix what was missed or misread
Use the **Boxes** buttons:

- **+ Add box**: drag a rectangle around a value the tool missed. For an angled or awkward spot, hold the **right** mouse button and trace any shape around it. The text inside is read for you to check, and the **Ø** button inserts a diameter sign.
- **− Remove box**: click a box to delete it. The **×** in the list does the same.

## 5. Adjust one dimension
Click **⌄** on a row in the Dimensions list:

- **Converted text**: type exactly what it should say.
- **Text size**: use **−** and **+** to change the size.
- **Diameter sign (Ø)**: add the sign or take it out.
- **Reset** undoes these changes.

To move converted text, hover near it and drag the round handle that appears. The original stays covered.

## 6. Download
At the top right:

- **PDF**: the original page with the new values.
- **DXF**: a CAD file. For DXF/DWG input, **DXF R12** gives a simple copy that opens in any CAD program.

There is no DWG download: save the DXF as DWG in your CAD program.

## Handy keys and mouse
| Action | How |
| --- | --- |
| Undo | Ctrl+Z (Cmd+Z), or **Undo** in the pop-up |
| Back to Convert mode | Esc |
| Zoom | Mouse wheel, or the **+ − ⤢** buttons |
| Pan | Right-drag (middle-drag in Add box mode) |

**Tip:** OCR can misread characters. Check converted values against the drawing before you rely on them.
