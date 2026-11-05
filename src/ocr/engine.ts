// Text recognition with PaddleOCR PP-OCRv5 (mobile) on ONNX Runtime.
// Detection finds text as rotated boxes, so vertical and slanted dimension
// text is found. Each box is read in both directions and, for squarish
// boxes, also turned by 90°, keeping the most confident result.

import type * as Ort from 'onnxruntime-web';
import { cropRotated, minAreaRect, type P, type RGBAImage } from './image';

export interface OcrModels {
  ort: typeof Ort;
  det: Ort.InferenceSession;
  rec: Ort.InferenceSession;
  /** Index -> character for the recogniser output (index 0 = CTC blank). */
  chars: string[];
}

export interface OcrLine {
  text: string;
  confidence: number;
  /** Centre, reading direction (unit, image coords), length and height in image pixels. */
  c: P;
  u: P;
  len: number;
  hgt: number;
  /**
   * Readings of the same box in other directions. A Ø that the model cannot
   * read can make a line look better upside down ("Ø60" -> "090"); the font
   * matching checks these against the letter shapes.
   */
  alts?: { text: string; u: P; len: number; hgt: number }[];
}

export function buildCharset(dictText: string, numClasses: number): string[] {
  const lines = dictText.replace(/\r/g, '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  // PaddleOCR layout: [blank, ...dictionary, ' ']. Some exported dictionaries
  // already contain the blank placeholder as their first line.
  const chars = lines.length >= numClasses ? lines.slice(0, numClasses) : ['', ...lines, ' '];
  chars[0] = '';
  while (chars.length < numClasses) chars.push(' ');
  return chars.slice(0, numClasses);
}

// ------------------------------------------------------------------ detection

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

interface DetBox {
  rect: ReturnType<typeof minAreaRect>;
  score: number;
}

async function detectTile(m: OcrModels, img: RGBAImage, x0: number, y0: number, tw: number, th: number, scale: number): Promise<DetBox[]> {
  const dw = Math.max(32, Math.round((tw * scale) / 32) * 32);
  const dh = Math.max(32, Math.round((th * scale) / 32) * 32);
  const sx = tw / dw;
  const sy = th / dh;
  const input = new Float32Array(3 * dw * dh);
  const plane = dw * dh;
  const { width: W, data } = img;
  for (let y = 0; y < dh; y++) {
    const iy = Math.min(img.height - 1, Math.floor(y0 + (y + 0.5) * sy));
    for (let x = 0; x < dw; x++) {
      const ix = Math.min(W - 1, Math.floor(x0 + (x + 0.5) * sx));
      const o = (iy * W + ix) * 4;
      // PaddleOCR feeds BGR
      input[y * dw + x] = (data[o + 2] / 255 - DET_MEAN[0]) / DET_STD[0];
      input[plane + y * dw + x] = (data[o + 1] / 255 - DET_MEAN[1]) / DET_STD[1];
      input[2 * plane + y * dw + x] = (data[o] / 255 - DET_MEAN[2]) / DET_STD[2];
    }
  }
  const out = await m.det.run({ [m.det.inputNames[0]]: new m.ort.Tensor('float32', input, [1, 3, dh, dw]) });
  const prob = out[m.det.outputNames[0]].data as Float32Array;

  // DB post-processing: threshold, connected components, min-area rectangles, unclip
  const seen = new Uint8Array(plane);
  const boxes: DetBox[] = [];
  const stack: number[] = [];
  for (let i = 0; i < plane; i++) {
    if (seen[i] || prob[i] < 0.3) continue;
    const pts: P[] = [];
    let sum = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const kx = k % dw;
      const ky = (k - kx) / dw;
      pts.push({ x: kx + 0.5, y: ky + 0.5 });
      sum += prob[k];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = kx + dx;
          const ny = ky + dy;
          if (nx < 0 || ny < 0 || nx >= dw || ny >= dh) continue;
          const n = ny * dw + nx;
          if (!seen[n] && prob[n] >= 0.3) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    if (pts.length < 6) continue;
    const score = sum / pts.length;
    if (score < 0.5) continue;
    const r = minAreaRect(pts);
    if (r.short < 2) continue;
    // unclip (DB shrinks text regions during training)
    const area = r.long * r.short;
    const dist = (area * 1.6) / (2 * (r.long + r.short));
    const long = (r.long + 2 * dist) * sx;
    const short = (r.short + 2 * dist) * sy;
    const c = { x: x0 + r.c.x * sx, y: y0 + r.c.y * sy };
    // non-uniform tile scale: re-normalise direction
    const ux = r.u.x * sx;
    const uy = r.u.y * sy;
    const ul = Math.hypot(ux, uy);
    boxes.push({ rect: { c, u: { x: ux / ul, y: uy / ul }, long, short }, score });
  }
  return boxes;
}

/** Detect text in tiles so small drawing text keeps enough pixels. */
async function detect(m: OcrModels, img: RGBAImage, pxPerMm: number, onTile?: (i: number, n: number) => void): Promise<DetBox[]> {
  // ~8 px per mm keeps the gap between stacked lines of small drawing text
  // (text 2.5 mm high -> 20 px), so neighbouring lines are not merged.
  const scale = Math.min(1, 8 / pxPerMm);
  // Whole page in one pass when it fits; tiles only for very large scans.
  const maxSide = 4096 / scale;
  const tile = Math.max(img.width, img.height) <= maxSide ? Math.max(img.width, img.height) : Math.round(2048 / scale);
  const overlap = Math.round(tile * 0.25);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = 0; ; x += tile - overlap) {
    xs.push(Math.min(x, Math.max(0, img.width - tile)));
    if (x + tile >= img.width) break;
  }
  for (let y = 0; ; y += tile - overlap) {
    ys.push(Math.min(y, Math.max(0, img.height - tile)));
    if (y + tile >= img.height) break;
  }
  const all: DetBox[] = [];
  let k = 0;
  const n = xs.length * ys.length;
  for (const y of ys) {
    for (const x of xs) {
      onTile?.(k++, n);
      const tw = Math.min(tile, img.width - x);
      const th = Math.min(tile, img.height - y);
      const boxes = await detectTile(m, img, x, y, tw, th, scale);
      // drop boxes cut by an inner tile edge; the neighbouring tile sees them whole
      for (const b of boxes) {
        const half = Math.max(b.rect.long, b.rect.short) / 2;
        const m = b.rect.short; // a text line cut by the tile edge ends close to it
        const cut =
          (x > 0 && b.rect.c.x - half < x + m) ||
          (y > 0 && b.rect.c.y - half < y + m) ||
          (x + tw < img.width && b.rect.c.x + half > x + tw - m) ||
          (y + th < img.height && b.rect.c.y + half > y + th - m);
        if (!cut) all.push(b);
      }
    }
  }
  // de-duplicate boxes found in two overlapping tiles
  const out: DetBox[] = [];
  for (const b of all.sort((p, q) => q.score - p.score)) {
    if (out.some((o) => Math.hypot(o.rect.c.x - b.rect.c.x, o.rect.c.y - b.rect.c.y) < Math.min(o.rect.short, b.rect.short) * 0.8)) continue;
    out.push(b);
  }
  return out;
}

// ------------------------------------------------------------------ recognition

const REC_H = 48;

async function recognise(m: OcrModels, strip: RGBAImage): Promise<{ text: string; confidence: number }> {
  const { width: w, height: h, data } = strip;
  const input = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    input[i] = data[i * 4 + 2] / 127.5 - 1;
    input[plane + i] = data[i * 4 + 1] / 127.5 - 1;
    input[2 * plane + i] = data[i * 4] / 127.5 - 1;
  }
  const out = await m.rec.run({ [m.rec.inputNames[0]]: new m.ort.Tensor('float32', input, [1, 3, h, w]) });
  const t = out[m.rec.outputNames[0]];
  const [, steps, classes] = t.dims as number[];
  const p = t.data as Float32Array;
  let text = '';
  let conf = 0;
  let count = 0;
  let last = 0;
  for (let s = 0; s < steps; s++) {
    let best = 0;
    let bv = -Infinity;
    const off = s * classes;
    for (let c = 0; c < classes; c++) {
      if (p[off + c] > bv) {
        bv = p[off + c];
        best = c;
      }
    }
    if (best !== 0 && best !== last) {
      text += m.chars[best] ?? '';
      conf += bv;
      count++;
    }
    last = best;
  }
  return { text, confidence: count ? conf / count : 0 };
}

/** Typical OCR confusions in numbers on drawings. */
export function cleanOcrText(s: string): string {
  let t = s.replace(/\s+/g, ' ').trim();
  t = t.replace(/(?<=\d)[oO](?=[\d.])|(?<=\d\.)[oO]|(?<=[\s(]|^)[oO](?=\.\d)/g, '0');
  t = t.replace(/(?<=\d\.?)[lI|](?=\d|$|\s|mm)|(?<=^|\s)[lI|](?=\d)/g, '1');
  t = t.replace(/(?<=\d)\s?[,，](?=\d{1,2}(?:\s?mm|$))/g, '.');
  t = t.replace(/(?<=\d)\.\s+(?=\d)/g, '. ');
  // "86:0°", "10:9mm": a colon inside a number is a misread decimal point
  t = t.replace(/(?<=\d)[:;](?=\d+\s?(?:°|mm|cm|in\b|"))/g, '.');
  // the diameter sign has several look-alikes (the model has no Ø of its own)
  t = t.replace(/[Φφ⌀∅]/g, '\u00d8').replace(/ø(?=\s?\d)/g, '\u00d8');
  return t;
}

export interface OcrOptions {
  pxPerMm: number;
  onProgress?: (fraction: number, label: string) => void;
}

/**
 * Drafting convention: text reads from the bottom or from the right side of
 * the sheet, so a reading direction pointing down-the-page is unlikely.
 */
export function readable(u: P): boolean {
  // reading angle in normal (y-up) terms: horizontal = 0°, bottom-to-top = 90°
  const deg = (Math.atan2(-u.y, u.x) * 180) / Math.PI;
  return deg > -75 && deg <= 105;
}

/**
 * Splits a box that holds stacked lines (small notes close together are often
 * detected as one region): an almost blank band across the box separates them.
 */
/** Dark-pixel counts per row and per column of a rotated frame (1 px sampling). */
function inkCounts(img: RGBAImage, c: P, u: P, len: number, hgt: number): { rows: Uint32Array; cols: Uint32Array; mask: Uint8Array } {
  const R = Math.max(8, Math.round(hgt));
  const C = Math.max(8, Math.round(len));
  const v = { x: -u.y, y: u.x };
  const strip = cropRotated(img, c, u, v, len, hgt, C, R);
  const rows = new Uint32Array(R);
  const cols = new Uint32Array(C);
  const mask = new Uint8Array(R * C);
  // darkness relative to the darkest ink in the frame (faint, blurred or coloured text)
  const dark = new Float32Array(R * C);
  let max = 0;
  for (let k = 0; k < R * C; k++) {
    const r = strip.data[k * 4];
    const g = strip.data[k * 4 + 1];
    const b = strip.data[k * 4 + 2];
    const lum = (r * 77 + g * 150 + b * 29) / 256;
    const d = 255 - lum + 0.5 * (Math.max(r, g, b) - Math.min(r, g, b));
    dark[k] = d;
    if (d > max) max = d;
  }
  const thr = Math.max(40, max * 0.45);
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < C; i++) {
      if (dark[j * C + i] > thr) {
        rows[j]++;
        cols[i]++;
        mask[j * C + i] = 1;
      }
    }
  }
  return { rows, cols, mask };
}

/**
 * Splits a box that holds stacked lines (small notes close together are often
 * detected as one region). The detector may tilt such a box, so nearby
 * angles are tried; the one whose row profile has the cleanest empty band
 * between two inked bands wins. Each part is trimmed to its own ink.
 */
function splitStacked(img: RGBAImage, rect: DetBox['rect'], lineHeight: number): DetBox['rect'][] {
  if (rect.short < 16 || rect.short < lineHeight * 1.5) return [rect];
  let best: { u: P; rows: Uint32Array; mask: Uint8Array; cols: number; gapFrom: number; gapTo: number; score: number } | null = null;
  for (let deg = -24; deg <= 24; deg += 2) {
    const a = (deg * Math.PI) / 180;
    const u = { x: rect.u.x * Math.cos(a) - rect.u.y * Math.sin(a), y: rect.u.x * Math.sin(a) + rect.u.y * Math.cos(a) };
    // frame turned with u that still covers the detected box
    const ca = Math.abs(Math.cos(a));
    const sa = Math.abs(Math.sin(a));
    const { rows, cols, mask } = inkCounts(img, rect.c, u, rect.long * ca + rect.short * sa, rect.long * sa + rect.short * ca);
    const peak = Math.max(...rows);
    if (!peak) continue;
    const on = Array.from(rows, (n) => n > peak * 0.06);
    // inked bands
    const bands: [number, number][] = [];
    for (let j = 0; j < on.length; j++) {
      if (on[j] && (j === 0 || !on[j - 1])) bands.push([j, j]);
      if (on[j]) bands[bands.length - 1][1] = j;
    }
    const tall = bands.filter((b) => b[1] - b[0] + 1 >= lineHeight * 0.45);
    if (tall.length < 2) continue;
    // the two tallest bands, ordered
    const two = [...tall].sort((p, q) => q[1] - q[0] - (p[1] - p[0])).slice(0, 2).sort((p, q) => p[0] - q[0]);
    const gap = two[1][0] - two[0][1] - 1;
    if (gap < 2) continue;
    // sharper bands (text lines seen straight on) score higher
    const score = (two[0][1] - two[0][0] + two[1][1] - two[1][0] > 0 ? 1 : 0) * (gap / ((two[0][1] - two[0][0]) + (two[1][1] - two[1][0]) + 2));
    if (!best || score > best.score) best = { u, rows, mask, cols: cols.length, gapFrom: two[0][1] + 1, gapTo: two[1][0] - 1, score };
  }
  if (!best) return [rect];
  const { u, rows, mask, cols: C } = best;
  const v = { x: -u.y, y: u.x };
  const R = rows.length;
  const part = (r0: number, r1: number): DetBox['rect'] | null => {
    // trim rows and columns to the ink of this part
    let top = -1;
    let bot = -1;
    let left = C;
    let right = -1;
    for (let j = r0; j <= r1; j++) {
      for (let i = 0; i < C; i++) {
        if (!mask[j * C + i]) continue;
        if (top < 0) top = j;
        bot = j;
        if (i < left) left = i;
        if (i > right) right = i;
      }
    }
    if (top < 0 || right < left) return null;
    const pad = Math.max(3, (bot - top + 1) * 0.3);
    const cy = (top + bot + 1) / 2 - R / 2;
    const cx = (left + right + 1) / 2 - C / 2;
    return {
      c: { x: rect.c.x + u.x * cx + v.x * cy, y: rect.c.y + u.y * cx + v.y * cy },
      u,
      long: right - left + 1 + 2 * pad,
      short: bot - top + 1 + 2 * pad,
    };
  };
  const a = part(0, best.gapFrom - 1);
  const b = part(best.gapTo + 1, R - 1);
  return a && b ? [a, b] : [rect];
}

export async function runOcr(m: OcrModels, img: RGBAImage, opts: OcrOptions): Promise<OcrLine[]> {
  const found = await detect(m, img, opts.pxPerMm, (i, n) => opts.onProgress?.((i / n) * 0.4, `Finding text (${i + 1}/${n})`));
  const heights = found.map((b) => b.rect.short).sort((a, b) => a - b);
  const lineHeight = heights[Math.floor(heights.length / 2)] ?? 30;
  const lines: OcrLine[] = [];
  for (let bi = 0; bi < found.length; bi++) {
    opts.onProgress?.(0.4 + (bi / found.length) * 0.6, `Reading text (${bi + 1}/${found.length})`);
    lines.push(...(await readDetected(m, img, found[bi].rect, lineHeight)));
  }
  return lines.filter((l) => l.text.length > 0);
}

/** Reads a detected box; a tall box may hold two stacked lines, kept split only if both parts read better. */
async function readDetected(m: OcrModels, img: RGBAImage, rect: DetBox['rect'], lineHeight: number): Promise<OcrLine[]> {
  const best = await readBox(m, img, rect);
  // slanted text sits along inclined dimension lines, often as two stacked lines
  const ang = Math.abs(Math.atan2(rect.u.y, rect.u.x)) % (Math.PI / 2);
  const slanted = ang > 0.17 && ang < Math.PI / 2 - 0.17;
  if (rect.short >= lineHeight * 1.15 && (!best || best.confidence < 0.9 || slanted || rect.short >= lineHeight * 1.6)) {
    const parts = splitStacked(img, rect, lineHeight * 0.75);
    if (parts.length > 1) {
      const reads = await Promise.all(parts.map((p) => readBox(m, img, p)));
      const ok = reads.every((r) => r && r.confidence >= 0.85);
      const mean = reads.reduce((s, r) => s + (r?.confidence ?? 0), 0) / reads.length;
      if (ok && (!best || mean > best.confidence + 0.03)) return reads.filter((r): r is OcrLine => !!r);
    }
  }
  return best ? [best] : [];
}

/**
 * Reads the text in an image of a box the user drew (with a margin of `pad`
 * pixels around it). Text is detected inside the image, so slanted text gets
 * its own rotated box; if nothing is detected, the whole box is read, along
 * its longer side.
 */
export async function readRegion(m: OcrModels, img: RGBAImage, pad: number, pxPerMm: number): Promise<OcrLine[]> {
  const w = img.width - 2 * pad;
  const h = img.height - 2 * pad;
  // same detector scale as the page pass, so the text boxes match what it finds there
  const scale = Math.min(1, 8 / pxPerMm);
  const boxes = (await detectTile(m, img, 0, 0, img.width, img.height, scale)).filter(
    (b) => b.rect.c.x >= pad - 2 && b.rect.c.x <= pad + w + 2 && b.rect.c.y >= pad - 2 && b.rect.c.y <= pad + h + 2,
  );
  // The user pointed here, so try harder than on a whole page: every detected
  // box, its two halves when it may hold stacked lines, and the whole box.
  const out: OcrLine[] = [];
  for (const b of boxes) {
    const r = await readBox(m, img, b.rect);
    if (r) out.push(r);
    const parts = splitStacked(img, b.rect, b.rect.short * 0.45);
    if (parts.length > 1) for (const p of parts) {
      const pr = await readBox(m, img, p);
      if (pr) out.push(pr);
    }
  }
  // Characters lie wholly inside the box; dimension and extension lines run
  // out of it. Read the ink that does not touch the edge of the image, too.
  const tight = innerInk(img);
  const rects: DetBox['rect'][] = [];
  if (tight) {
    const tw = tight.maxX - tight.minX;
    const th = tight.maxY - tight.minY;
    const m2 = Math.max(3, Math.min(tw, th) * 0.25);
    const c = { x: (tight.minX + tight.maxX) / 2, y: (tight.minY + tight.maxY) / 2 };
    rects.push(tw >= th ? { c, u: { x: 1, y: 0 }, long: tw + 2 * m2, short: th + 2 * m2 } : { c, u: { x: 0, y: -1 }, long: th + 2 * m2, short: tw + 2 * m2 });
  }
  const c = { x: img.width / 2, y: img.height / 2 };
  rects.push(w >= h ? { c, u: { x: 1, y: 0 }, long: w, short: h } : { c, u: { x: 0, y: -1 }, long: h, short: w });
  // readBox tries all four directions here, so sideways text is read too
  for (const rect of rects) {
    const r = await readBox(m, img, rect, true);
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/** Bounding box of the dark ink in connected pieces that do not touch the image edge. */
function innerInk(img: RGBAImage): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const { width: w, height: h, data } = img;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const lum = (r * 77 + g * 150 + b * 29) >> 8;
    if (lum < 160 || (Math.max(r, g, b) - Math.min(r, g, b) > 70 && lum < 220)) ink[i] = 1;
  }
  const seen = new Uint8Array(w * h);
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!ink[i] || seen[i]) continue;
    const comp: number[] = [];
    let edge = false;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      const x = k % w;
      const y = (k - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (ink[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    if (edge || comp.length < 6) continue;
    for (const k of comp) {
      const x = k % w;
      const y = (k - x) / w;
      if (x < box.minX) box.minX = x;
      if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      if (y > box.maxY) box.maxY = y;
    }
  }
  return Number.isFinite(box.minX) ? { minX: box.minX, minY: box.minY, maxX: box.maxX + 1, maxY: box.maxY + 1 } : null;
}

/** Reads one box in each plausible direction and keeps the most confident reading. */
async function readBox(m: OcrModels, img: RGBAImage, rect: DetBox['rect'], allDirections = false): Promise<OcrLine | null> {
  const { c, u, long, short } = rect;
  const v = { x: -u.y, y: u.x };
  const candidates: { u: P; len: number; hgt: number }[] = [
    { u, len: long, hgt: short },
    { u: { x: -u.x, y: -u.y }, len: long, hgt: short },
  ];
  if (allDirections || long < short * 1.6) candidates.push({ u: v, len: short, hgt: long }, { u: { x: -v.x, y: -v.y }, len: short, hgt: long });
  // conventional reading directions first; stop early on a confident read
  candidates.sort((a, b) => Number(readable(b.u)) - Number(readable(a.u)));
  let best: OcrLine | null = null;
  const seen: { text: string; u: P; len: number; hgt: number; confidence: number }[] = [];
  for (const cand of candidates) {
    const d = { x: -cand.u.y, y: cand.u.x }; // glyph "down" for reading direction u (y-down image)
    const outW = Math.max(16, Math.min(1600, Math.round((REC_H * cand.len) / cand.hgt)));
    const strip = cropRotated(img, c, cand.u, d, cand.len, cand.hgt, outW, REC_H);
    const r = await recognise(m, strip);
    const score = r.confidence + (readable(cand.u) ? 0.08 : 0);
    if (r.text.trim()) seen.push({ text: r.text, u: cand.u, len: cand.len, hgt: cand.hgt, confidence: r.confidence });
    if (r.text.trim() && (!best || score > best.confidence)) {
      best = { text: r.text, confidence: score, c, u: cand.u, len: cand.len, hgt: cand.hgt };
    }
    if (best && readable(best.u) && r.confidence > 0.93) break;
  }
  if (!best) return null;
  // Short numbers (a lone "8") get lower confidence than words, but they are what
  // matters on a drawing: keep them; the list marks them for checking.
  const numeric = /^[\d.,\s]+$/.test(best.text.trim());
  const raw = best.confidence - (readable(best.u) ? 0.08 : 0);
  if (raw <= (numeric ? 0.5 : 0.55)) return null;
  const alts = seen.filter((x) => x.u !== best!.u && x.confidence > 0.3).map(({ text, u, len, hgt }) => ({ text: cleanOcrText(text), u, len, hgt }));
  return { ...best, confidence: Math.min(1, raw), text: cleanOcrText(best.text), ...(alts.length ? { alts } : {}) };
}
