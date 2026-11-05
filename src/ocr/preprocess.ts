// "Scan & OCR" before import: the page is rendered, its text is recognised
// and written back into the PDF as an invisible text layer (the method of
// PdfCraft's Scan & OCR). The converter then reads that PDF like any other:
// text drawn as outlines, or inside a scanned image, becomes real text.

import type { FoundLine } from './worker';
import { withTextLayers, type PlacedWord } from './textLayer';
import { fixDiameters } from './diameter';
import { chooseFits, measureLine, plausible, scoreFaces, snappedBox, type Fit, type LineBox, type Measured, type RenderText, type RGBA } from '../fonts/match';
import type { TextStyleHint } from '../importers/pdf';
import type { Face } from '../fonts/faces';

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
  /** The face each added line was matched to (for importPdf's textStyles). */
  styles: TextStyleHint[];
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
    // diameter sign look-alikes; a lower-case ø only in front of a number
    .replace(/[\u2300\u2205\u03a6\u03c6]/g, '\u00d8')
    .replace(/\u00f8(?=\s?\d)/g, '\u00d8')
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

/**
 * Where the text of an OCR line goes: start of the baseline, the baseline
 * vector to its end and the em ("up") vector, mapped through `map` from image
 * pixels to the target coordinates.
 */
export function placeLine(
  l: { c: { x: number; y: number }; u: { x: number; y: number }; len: number; hgt: number },
  map: (x: number, y: number) => [number, number],
): { origin: [number, number]; across: [number, number]; up: [number, number] } {
  const d = { x: -l.u.y, y: l.u.x }; // glyph "down" (image y is down)
  const em = l.hgt * EM_PER_BOX;
  const width = l.len * WIDTH_PER_BOX;
  const b0 = { x: l.c.x - l.u.x * (width / 2) + d.x * 0.36 * em, y: l.c.y - l.u.y * (width / 2) + d.y * 0.36 * em };
  const o = map(b0.x, b0.y);
  const a = map(b0.x + l.u.x * width, b0.y + l.u.y * width);
  const t = map(b0.x - d.x * em, b0.y - d.y * em);
  return { origin: o, across: [a[0] - o[0], a[1] - o[1]], up: [t[0] - o[0], t[1] - o[1]] };
}

export interface PreprocessOptions {
  /** Recognises text in an RGBA image (runs the OCR worker in the browser). */
  recognise: (img: { width: number; height: number; data: Uint8ClampedArray }, pxPerMm: number) => Promise<FoundLine[]>;
  /** Creates a 2D canvas (document canvas in the browser, @napi-rs/canvas in tests). */
  createCanvas: (w: number, h: number) => { getContext(t: '2d', o?: unknown): any; width: number; height: number };
  /** Draws text in the bundled faces; when set, each line's font is matched (see fonts/match.ts). */
  render?: RenderText;
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

  // the worker takes the pixels over; font matching needs them afterwards
  const lines = await opts.recognise({ width: pixels.width, height: pixels.height, data: opts.render ? pixels.data.slice() : pixels.data }, pxPerMm);

  const words: PlacedWord[] = [];
  let alreadyText = 0;
  let unsupported = 0;
  const toUser = (x: number, y: number) => vp.convertToPdfPoint(x, y) as [number, number];
  const kept: { l: FoundLine; text: string }[] = [];
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
    kept.push({ l, text });
  }

  // the font of each line, so converted values can be written to look the same
  opts.onProgress?.(0.98, 'Matching the fonts');
  const matched = opts.render ? matchFontsFamily(pixels, kept, opts.render) : { fits: kept.map(() => null), family: null };
  const fits = matched.fits;
  // the recogniser has no Ø: put back the ones the letter shapes show
  if (opts.render) {
    kept.forEach((k, i) => {
      const fix = fixDiameters(pixels, k, fits[i], matched.family, opts.render!);
      if (!fix) return;
      k.text = fix.text;
      k.l = { ...k.l, u: fix.box.u, len: fix.box.len, hgt: fix.box.hgt };
      fits[i] = fix.fit && plausible(fix.fit, fix.box) ? fix.fit : null;
    });
  }
  const styles: TextStyleHint[] = [];
  kept.forEach(({ l, text }, k) => {
    const fit = fits[k];
    const place = fit ? placeFit(fit, toUser) : placeLine(l, toUser);
    words.push({ text, ...place, rgb: l.rgb });
    if (fit) styles.push({ text, origin: place.origin, face: fit.face, hscale: fit.hscale, slant: fit.slant });
  });
  opts.onProgress?.(1, 'Adding the text layer');
  const out = await withTextLayers(bytes, new Map([[pageIndex, words]]));
  return { bytes: new Uint8Array(out), added: words.length, alreadyText, unsupported, styles };
}

/** Face fits for OCR lines (null where the letters could not be measured). */
export function matchFonts(img: RGBA, lines: { l: LineBox; text: string }[], render: RenderText, prefer?: Face['family']): (Fit | null)[] {
  return matchFontsFamily(img, lines, render, prefer).fits;
}

/** matchFonts, and the font family chosen for the page. */
export function matchFontsFamily(img: RGBA, lines: { l: LineBox; text: string }[], render: RenderText, prefer?: Face['family']): { fits: (Fit | null)[]; family: Face['family'] | null } {
  const measured = lines.map(({ l, text }) => {
    let best: { text: string; m: Measured; box: LineBox; fits: Fit[] } | null = null;
    // a box a few degrees off an axis is also tried on the axis; the better one counts
    for (const box of [l, snappedBox(l)]) {
      if (!box) continue;
      const m = measureLine(img, box, text);
      if (!m) continue;
      const fits = scoreFaces(m, text, render);
      const top = Math.max(-1, ...fits.map((f) => f.score));
      if (!best || top > Math.max(-1, ...best.fits.map((f) => f.score))) best = { text, m, box, fits };
    }
    return best;
  });
  const ok = measured.filter((x): x is NonNullable<typeof x> => !!x);
  const res = chooseFits(ok, render, prefer);
  const out: (Fit | null)[] = [];
  let k = 0;
  for (const x of measured) out.push(x ? res.fits[k++] : null);
  return { fits: out, family: res.family };
}

/** Text placement of a face fit: baseline start, advance vector and em vector, mapped through `map`. */
export function placeFit(f: Fit, map: (x: number, y: number) => [number, number]): { origin: [number, number]; across: [number, number]; up: [number, number] } {
  const o = map(f.origin.x, f.origin.y);
  const a = map(f.origin.x + f.u.x * f.advancePx, f.origin.y + f.u.y * f.advancePx);
  const t = map(f.origin.x - f.d.x * f.emPx, f.origin.y - f.d.y * f.emPx);
  return { origin: o, across: [a[0] - o[0], a[1] - o[1]], up: [t[0] - o[0], t[1] - o[1]] };
}
