# Drawing Unit Converter

Converts the dimensions on engineering drawings to other units (for example millimetres to inches) and gives you back the drawing with the new values written in.

**Use it here: https://arnaved0.github.io/drawing-unit-converter/**

It works with **PDF, DWG, DXF, PNG and JPEG** files, runs in your browser, and does not upload your files.

## Quick start
1. Click **Open drawing…** and choose your file.
2. Check the **Original unit** and pick a **New unit** on the right.
3. Click the highlighted dimensions you want to convert, or press **Convert all**.
4. Missed one? Click **+ Add box** and drag around it. You can also translate text this way.
5. Download the result as **PDF**, **DXF** or a picture.

For more detail, see the **[full guide](MANUAL.md)**.

## For developers
```
npm install
npm run dev     # local version at http://localhost:5173
npm test        # run the tests
npm run build   # build the site into dist/
```
Pushing to `main` tests the code and publishes the site to GitHub Pages.
