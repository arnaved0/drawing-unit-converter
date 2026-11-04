// Writes recognised text into a PDF page as an invisible text layer, so the
// page gets real, selectable text while it looks exactly as before. This is
// the method of PdfCraft's Scan & OCR ("Searchable Image (Exact)",
// crates/ocr/src/lib.rs, Apache-2.0): text rendering mode 3 (invisible) in
// standard Helvetica, the text matrix stretched so each line covers the
// recognised words, inside marked content /OCR and a q ... Q pair so the
// invisible mode does not leak into content drawn later.

import {
  beginMarkedContent,
  beginText,
  endMarkedContent,
  endText,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  StandardFonts,
  TextRenderingMode,
} from 'pdf-lib';

/** Recognised text placed on the page, in PDF user space. */
export interface PlacedWord {
  text: string;
  /** Start of the baseline. */
  origin: [number, number];
  /** Baseline vector to the end of the text, in reading direction. */
  across: [number, number];
  /** Em vector: from the baseline up by one font size. */
  up: [number, number];
  /** Ink colour, 0..1. Stored with the text so readers know its colour. */
  rgb: [number, number, number];
}

export function addTextLayer(page: PDFPage, font: PDFFont, words: PlacedWord[]): void {
  const name = page.node.newFontDictionary('OCRHelv', font.ref);
  const ops = [beginMarkedContent('OCR'), pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible), setFontAndSize(name, 1)];
  for (const w of words) {
    const width = font.widthOfTextAtSize(w.text, 1);
    if (!(width > 0) || !(Math.hypot(w.up[0], w.up[1]) > 0)) continue;
    // text space x is stretched so the string spans `across`; y is the em vector
    ops.push(
      setFillingRgbColor(...w.rgb),
      setTextMatrix(w.across[0] / width, w.across[1] / width, w.up[0], w.up[1], w.origin[0], w.origin[1]),
      showText(font.encodeText(w.text)),
    );
  }
  ops.push(endText(), popGraphicsState(), endMarkedContent());
  page.pushOperators(...ops);
}

/** Returns a copy of the PDF with an invisible text layer on each given page. */
export async function withTextLayers(bytes: Uint8Array, pages: Map<number, PlacedWord[]>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [index, words] of pages) {
    if (words.length) addTextLayer(doc.getPage(index), font, words);
  }
  return doc.save({ useObjectStreams: false });
}
