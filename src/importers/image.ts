// PNG / JPEG (and other picture) drawings.
//
// A picture is put on a PDF page of its own size, so it goes through exactly
// the same steps as a scanned PDF: Scan & OCR reads its text, values are
// converted on white patches, and the result is downloaded as a PDF or as a
// picture again. The user sees no difference between the kinds of input.

import { PDFDocument } from 'pdf-lib';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

/** Resolution assumed when the file does not say (a typical drawing scan). */
export const DEFAULT_DPI = 200;
/** Pictures larger than this are scaled down (memory and reading time). */
const MAX_PIXELS = 40e6;

/** Dots per inch stored in a PNG (pHYs) or JPEG (JFIF / EXIF) file, or null. */
export function imageDpi(bytes: Uint8Array): number | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: 8-byte signature, then chunks
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    let o = 8;
    while (o + 12 <= bytes.length) {
      const len = dv.getUint32(o);
      const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
      if (type === 'pHYs' && len >= 9) {
        const ppx = dv.getUint32(o + 8);
        const unit = bytes[o + 16];
        if (unit === 1 && ppx > 0) return plausibleDpi(ppx * 0.0254);
        return null;
      }
      if (type === 'IDAT' || type === 'IEND') return null;
      o += 12 + len;
    }
    return null;
  }
  // JPEG: markers
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 4 <= bytes.length) {
      if (bytes[o] !== 0xff) return null;
      const marker = bytes[o + 1];
      if (marker === 0xda || marker === 0xd9) return null; // image data starts
      const len = dv.getUint16(o + 2);
      const seg = o + 4;
      if (marker === 0xe0 && len >= 14 && String.fromCharCode(...bytes.subarray(seg, seg + 4)) === 'JFIF') {
        const unit = bytes[seg + 7];
        const x = dv.getUint16(seg + 8);
        if (x > 0 && unit === 1) return plausibleDpi(x);
        if (x > 0 && unit === 2) return plausibleDpi(x * 2.54);
      }
      o = seg + len - 2;
    }
  }
  return null;
}

/** Screen-style values (72, 96) are what programs write when they do not know: ignored. */
function plausibleDpi(v: number): number | null {
  const r = Math.round(v);
  return r >= 100 && r <= 2400 ? r : null;
}

export interface ImagePdf {
  /** A one-page PDF holding the picture at its size on paper. */
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  dpi: number;
  /** The dpi was assumed, not read from the file. */
  assumedDpi: boolean;
  mime: string;
}

/**
 * Puts a picture on a PDF page (browser only: decodes with the browser, which
 * also turns photos the right way up from their EXIF orientation).
 */
export async function imageToPdf(file: Blob, bytes: Uint8Array): Promise<ImagePdf> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  let w = bitmap.width;
  let h = bitmap.height;
  if (!w || !h) throw new Error('The picture is empty.');
  const read = imageDpi(bytes);
  let dpi = read ?? DEFAULT_DPI;
  if (w * h > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.round(w * k);
    h = Math.round(h * k);
    dpi *= k;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  // transparent pictures go on white paper
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const jpeg = file.type === 'image/jpeg';
  const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be encoded.'))), jpeg ? 'image/jpeg' : 'image/png', 0.95));
  const enc = new Uint8Array(await blob.arrayBuffer());
  const doc = await PDFDocument.create();
  const img = jpeg ? await doc.embedJpg(enc) : await doc.embedPng(enc);
  const pw = (w / dpi) * 72;
  const ph = (h / dpi) * 72;
  const page = doc.addPage([pw, ph]);
  page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
  doc.setProducer('Drawing Unit Converter');
  const out = await doc.save({ useObjectStreams: false });
  return { bytes: new Uint8Array(out), width: w, height: h, dpi, assumedDpi: read === null, mime: jpeg ? 'image/jpeg' : 'image/png' };
}

/** Renders page 1 of a PDF made by imageToPdf back to a picture of the original's pixel size. */
export async function pdfToImage(
  page: { getViewport(o: { scale: number }): { width: number; height: number }; render(o: unknown): { promise: Promise<void> } },
  width: number,
  mime: string,
): Promise<Blob> {
  const one = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / one.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be written.'))), mime, 0.95));
}
