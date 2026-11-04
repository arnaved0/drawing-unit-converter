// "Scan & OCR" before import: the page is rendered, its text is recognised
// and written back into the PDF as an invisible text layer (the method of
// PdfCraft's Scan & OCR). The converter then reads that PDF like any other:
// text drawn as outlines, or inside a scanned image, becomes real text.

import type { FoundLine } from './worker';
import { withTextLayers, type PlacedWord } from './textLayer';

/** The parts of a pdf.js page this module needs. */
interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number; transform: number[]; convertToPdfPoint(x: number, y: number): number[] };
  getTextContent(): Promise<{ items: any[] }>;
  render(o: unknown): { promise: Promise<void> };
}

export interface PreprocessResult {
  bytes: Uint8Array<ArrayBuffer>;
  /** Lines added to the text layer. */
  added: number;
  /** Lines left out because the page already had them as text. */
  alreadyText: number;
  /** Lines left out because the PDF font cannot hold their characters (CJK ...). */
  unsupported: number;
}

/** OCR box -> text placement. PP-OCR boxes are padded around the glyphs. */
const EM_PER_BOX = 0.66;
const WIDTH_PER_BOX = 0.94;
/** Pages are read at 300 dpi (PdfCraft's default), at most ~24 megapixels. */
const DPI = 200;
const MAX_PIXELS = 24e6;

/** Characters standard Helvetica (WinAnsi) has, after NFKC (full-width ":" -> ":"). */
const WIN_ANSI = /^[\x20-\x7e\u00a0-\u00ff\u20ac\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026\u2030\u2122]*$/;

export function normaliseOcrText(s: string): string | null {
  const t = s
    .normalize('NFKC')
    .replace(/[\u2300\u03a6\u03c6]/g, '\u00d8')
    // a label read together with the value below it: "C-Z11.2mm" -> "C-Z 11.2mm"
    // (not R25, D12, M6 or 100x50, where the letter belongs to the value)
    .replace(/(?<=[A-CE-LN-QS-WYZa-ce-ln-qs-wyz])(?=\d+(?:\.\d+)?\s?(?:mm|cm|in)\b)/g, ' ')
    .trim();
  return WIN_ANSI.test(t) ? t : null;
}

/** Fraction of box `a` (x0, y0, x1, y1) covered by the boxes in `list`. */
function covered(a: number[], list: number[][]): number {
  const area = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const total = area(a);
  if (!(total > 0)) return 0;
  let inside = 0;
  for (const b of list) inside += area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  return Math.min(1, inside / total);
}

/** Boxes of the page's own text, in viewport pixels. */
export async function existingTextBoxes(page: PdfPage, vp: { transform: number[] }): Promise<number[][]> {
  const tc = await page.getTextContent();
  const out: number[][] = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    // item.transform: (a, b) runs along the baseline, (c, d) is the em "up" vector, (e, f) the origin
    const [a, b, c, d, e, f] = it.transform as number[];
    const len = Math.hypot(a, b) || 1;
    const w = it.width ?? 0;
    const corners = [
      [0, -0.2],
      [1, -0.2],
      [1, 1],
      [0, 1],
    ].map(([fx, fy]) => {
      const x = e + (a / len) * w * fx + c * fy;
      const y = f + (b / len) * w * fx + d * fy;
      const m = vp.transform;
      return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    });
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return out;
}

export interface PreprocessOptions {
  /** Recognises text in an RGBA image (runs the OCR worker in the browser). */
  recognise: (img: { width: number; height: number; data: Uint8ClampedArray }, pxPerMm: number) => Promise<FoundLine[]>;
  /** Creates a 2D canvas (document canvas in the browser, @napi-rs/canvas in tests). */
  createCanvas: (w: number, h: number) => { getContext(t: '2d', o?: unknown): any; width: number; height: number };
  onProgress?: (fraction: number, label: string) => void;
}

export async function preprocessPage(bytes: Uint8Array, page: PdfPage, pageIndex: number, opts: PreprocessOptions): Promise<PreprocessResult> {
  const base = page.getViewport({ scale: 1 });
  let scale = DPI / 72;
  if (base.width * base.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (base.width * base.height));
  const vp = page.getViewport({ scale });
  opts.onProgress?.(0, 'Rendering the page');
  const canvas = opts.createCanvas(Math.round(vp.width), Math.round(vp.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pxPerMm = scale * (72 / 25.4);
  const existing = await existingTextBoxes(page, vp);

  const lines = await opts.recognise({ width: pixels.width, height: pixels.height, data: pixels.data }, pxPerMm);

  const words: PlacedWord[] = [];
  let alreadyText = 0;
  let unsupported = 0;
  const toUser = (x: number, y: number) => vp.convertToPdfPoint(x, y) as [number, number];
  for (const l of lines) {
    const text = normaliseOcrText(l.text);
    if (text === null) {
      unsupported++;
      continue;
    }
    // a lone letter or symbol is nearly always a piece of geometry read as text,
    // and a lone "1" usually a short vertical line
    if (text.length < 2 && (!/[0-9]/.test(text) || text === '1')) continue;
    const d = { x: -l.u.y, y: l.u.x }; // glyph "down" (image y is down)
    const hx = Math.abs(l.u.x) * l.len + Math.abs(d.x) * l.hgt;
    const hy = Math.abs(l.u.y) * l.len + Math.abs(d.y) * l.hgt;
    const box = [l.c.x - hx / 2, l.c.y - hy / 2, l.c.x + hx / 2, l.c.y + hy / 2];
    if (covered(box, existing) >= 0.5) {
      alreadyText++;
      continue;
    }
    const em = l.hgt * EM_PER_BOX;
    const width = l.len * WIDTH_PER_BOX;
    // baseline start and end, and the top of the em square, in image pixels
    const b0 = { x: l.c.x - l.u.x * (width / 2) + d.x * 0.36 * em, y: l.c.y - l.u.y * (width / 2) + d.y * 0.36 * em };
    const b1 = { x: b0.x + l.u.x * width, y: b0.y + l.u.y * width };
    const t0 = { x: b0.x - d.x * em, y: b0.y - d.y * em };
    const o = toUser(b0.x, b0.y);
    const a = toUser(b1.x, b1.y);
    const t = toUser(t0.x, t0.y);
    words.push({ text, origin: o, across: [a[0] - o[0], a[1] - o[1]], up: [t[0] - o[0], t[1] - o[1]], rgb: l.rgb });
  }
  opts.onProgress?.(1, 'Adding the text layer');
  const out = await withTextLayers(bytes, new Map([[pageIndex, words]]));
  return { bytes: new Uint8Array(out), added: words.length, alreadyText, unsupported };
}
