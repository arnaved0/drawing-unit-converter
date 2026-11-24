import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { convertDimension, detectDimensions } from '../src/dimensions';
import { measureInk, measureTextInk, renderPageImage } from '../src/ink';
import { importPdf, type PdfJs } from '../src/importers/pdf';
import { apply, invert, pointInPoly } from '../src/geom';
import type { Pt, TextEntity } from '../src/model';
import { coverPolygons, ocrPatch } from '../src/render/svg';
import { DEFAULT_SETTINGS } from '../src/units';

const pdfjsDir = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));
const docParams = { cMapUrl: `${pdfjsDir}cmaps/`, cMapPacked: true, standardFontDataUrl: `${pdfjsDir}standard_fonts/`, useSystemFonts: false };
const IN = { ...DEFAULT_SETTINGS, target: 'in' as const, decimals: 2 };

/**
 * A vertical dimension whose text sits between the arrowheads, which touch
 * its ends (the drawing in the bug report). Returns the PDF and the arrowheads
 * in PDF user space.
 */
async function dimensionPdf(): Promise<{ bytes: Uint8Array; arrows: Pt[][] }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const blue = rgb(0.12, 0.42, 0.68);
  const x = 150;
  // extension lines
  page.drawLine({ start: { x: 100, y: 100 }, end: { x: 170, y: 100 }, thickness: 0.4, color: rgb(0.5, 0.5, 0.5) });
  page.drawLine({ start: { x: 100, y: 160 }, end: { x: 170, y: 160 }, thickness: 0.4, color: rgb(0.5, 0.5, 0.5) });
  // text "25 mm" written upwards, from y = 110 to about y = 150
  const size = 10;
  const w = font.widthOfTextAtSize('25 mm', size);
  page.drawText('25 mm', { x: x + 3.5, y: 130 - w / 2, size, font, color: blue, rotate: degrees(90) });
  // arrowheads: tips on the extension lines, bases touching the ends of the text
  const lo = 130 - w / 2;
  const hi = 130 + w / 2;
  const arrows = [
    [{ x, y: 100 }, { x: x - 3, y: lo + 1 }, { x: x + 3, y: lo + 1 }],
    [{ x, y: 160 }, { x: x - 3, y: hi - 1 }, { x: x + 3, y: hi - 1 }],
  ];
  for (const a of arrows) {
    page.drawSvgPath(`M${a[0].x} ${300 - a[0].y} L${a[1].x} ${300 - a[1].y} L${a[2].x} ${300 - a[2].y} Z`, { x: 0, y: 300, color: blue });
  }
  return { bytes: await doc.save(), arrows };
}

describe('arrowheads next to a converted value', () => {
  it.each([
    ['drawn as shapes', true],
    ['only in the pixels (a scan)', false],
  ])('are not whited out with the letters (%s)', async (_name, vector) => {
    const { bytes, arrows } = await dimensionPdf();
    const d = await importPdf(pdfjs as unknown as PdfJs, bytes, 'dim.pdf', { docParams });
    const pdfDoc = await pdfjs.getDocument({ data: bytes.slice(), ...docParams }).promise;
    const page = await pdfDoc.getPage(1);
    const img = await renderPageImage(page as never, d.pdf!.userToDrawing, (w, h) => createCanvas(w, h) as never);
    if (vector) measureInk(d, img);
    else for (const e of d.entities) if (e.kind === 'text') e.ink = measureTextInk(img, e);
    const dims = detectDimensions(d);
    expect(dims.map((x) => x.original)).toEqual(['25 mm']);
    const t = d.entities.find((e): e is TextEntity => e.kind === 'text' && e.id === dims[0].textId)!;
    convertDimension(dims[0], t.text, IN, 'mm');
    const masks = coverPolygons(t, ocrPatch(t, dims)!);
    const toDrawing = d.pdf!.userToDrawing;
    expect(invert(toDrawing)).toBeTruthy();
    for (const a of arrows) {
      // the middle of each arrowhead stays as drawn
      const tri = a.map((p) => apply(toDrawing, p));
      const mid = { x: (tri[0].x + tri[1].x + tri[2].x) / 3, y: (tri[0].y + tri[1].y + tri[2].y) / 3 };
      const tip = { x: tri[0].x * 0.7 + mid.x * 0.3, y: tri[0].y * 0.7 + mid.y * 0.3 };
      for (const p of [mid, tip]) expect(masks.some((m) => pointInPoly(p, m))).toBe(false);
    }
    // but the letters are covered
    expect(masks.length).toBeGreaterThanOrEqual(4);
  });
});
