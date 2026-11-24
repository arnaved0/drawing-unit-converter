# Drawing Unit Converter: quick guide

Open the tool at https://arnaved0.github.io/drawing-unit-converter/. Files stay in your browser and are never uploaded. (The one exception is **Translate** in a box: the text of that box is sent to Google Translate.)

## 1. Open a drawing
Click **Open drawing…** or drop a **PDF, DXF, DWG, PNG or JPEG** file on the page (WebP, BMP and GIF pictures work too).

- PDFs and pictures are scanned first (Scan & OCR), so text drawn as shapes, scanned, or in a picture is read the same way as real text. This takes a few seconds per page.
- PDFs and pictures are shown exactly as they are drawn, and stay sharp when you zoom in.
- Values inside text in another script (for example `长度 300mm`) are found too.
- A drawing that was converted before can be opened again: the old values under the white patches are left out.
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

- **+ Add box**: drag a rectangle around a value or a piece of text. For an angled or awkward spot, hold the **right** mouse button and trace any shape around it. The text inside is read for you (in any script, Chinese and Japanese included) and you can correct it; the **Ø** button inserts a diameter sign. Then:
  - **Convert values** converts the numbers in the box. A box takes precedence over the rules: every number in it is converted, and a unit written in it (for example `0.98in` on a mm drawing) is used instead of the **Original unit**. A unit the tool does not know is read as the Original unit. This button only shows when the box holds a number.
  - **Translate** translates the text into the language you pick (Google Translate, or your browser's own translator when offline). Edit it if you like, then **Write translation** writes it over the box. It is listed with the dimensions and can be moved, resized, turned or undone.
- **− Remove box**: click a box to delete it. The **×** in the list does the same.

## 5. Adjust one dimension
Click **⌄** on a row in the Dimensions list:

- **Converted text**: type exactly what it should say.
- **Text size**: use **−** and **+** to change the size.
- **Rotation**: **⟲ / ⟳** turn the converted text by 90°, **− / +** by 15°, or type an angle.
- **Decimal places** (or **Round to** for fractions): for this value only.
- **Diameter sign (Ø)**: add the sign or take it out.
- **Reset** undoes these changes.

To move converted text, hover near it and drag the round handle that appears. The original stays covered.

## 6. Download
At the top right:

- **PDF**: the original page with the new values.
- **PNG / JPEG**: for a picture, the picture with the new values, at its own size.
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
