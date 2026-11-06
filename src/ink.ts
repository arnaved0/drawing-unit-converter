// Where the letters of a text are on the page, to white out only them.
//
// The page is rendered once. For each text, the ink in a band around it is
// cut into pieces: long straight strokes (dimension and extension lines) are
// taken out, and what stays is split into connected pieces, one per letter or
// part of a letter. A conversion then whites out the outline of each letter it
// replaces, so lines under the text and words beside it stay untouched.

import { apply, invert, mul, type Mat } from './geom';
import type { Drawing, InkPiece, Pt, TextEntity } from './model';
import { advance, getFace } from './fonts/faces';

export interface PageImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Drawing coordinates (mm) -> image pixels. */
  toImage: Mat;
}

/** The parts of a pdf.js page this module needs. */
interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number; transform: number[] };
  render(o: unknown): { promise: Promise<void> };
}

type CreateCanvas = (w: number, h: number) => { getContext(t: '2d', o?: unknown): any; width: number; height: number };

/** Pixels per mm the page is measured at (about 200 dpi, like the OCR pass). */
export const INK_PX_PER_MM = 8;
const MAX_PIXELS = 24e6;

/** Renders a PDF page for measuring (white background). */
export async function renderPageImage(page: PdfPage, userToDrawing: Mat, createCanvas: CreateCanvas, pxPerMm = INK_PX_PER_MM): Promise<PageImage> {
  const base = page.getViewport({ scale: 1 });
  let scale = (pxPerMm * 25.4) / 72;
  if (base.width * base.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (base.width * base.height));
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: img.data, toImage: pageToImage(vp.transform as Mat, userToDrawing) };
}

/** Drawing -> image pixels, from a pdf.js viewport transform (PDF user space -> pixels). */
export function pageToImage(viewportTransform: Mat, userToDrawing: Mat): Mat {
  return mul(viewportTransform, invert(userToDrawing));
}

/** Measures the letters of every text on the page. */
export function measureInk(d: Drawing, img: PageImage): void {
  for (const e of d.entities) if (e.kind === 'text' && !e.cover) e.ink = measureTextInk(img, e);
}

/** Darkness at which a pixel counts as ink (min channel below this): faint anti-aliased edges included. */
const INK_BELOW = 205;

/**
 * The letters of one text: pieces of ink in its band, without the long
 * straight strokes that run through or under it. `u` is measured along the
 * text from its position (as in textCorners).
 */
export function measureTextInk(img: PageImage, t: TextEntity): InkPiece[] {
  const em = t.fontSize;
  const pxPerMm = Math.sqrt(Math.abs(img.toImage[0] * img.toImage[3] - img.toImage[1] * img.toImage[2]));
  if (!(em * pxPerMm >= 4)) return [];
  const step = 1 / pxPerMm;
  const shift = t.align === 'center' ? -t.width / 2 : t.align === 'right' ? -t.width : 0;
  // wide along the text: the OCR estimate of its length is sometimes a letter short
  const uA = shift - 1.6 * em;
  const uB = shift + t.width + 1.6 * em;
  const vA = -0.55 * em;
  const vB = 1.3 * em;
  const W = Math.ceil((uB - uA) / step);
  const H = Math.ceil((vB - vA) / step);
  if (W * H > 4e6 || W < 2 || H < 2) return [];
  const dx = Math.cos(t.rotation);
  const dy = Math.sin(t.rotation);
  // local (u, v) -> drawing; row 0 is the top (largest v)
  const at = (u: number, v: number): Pt => ({ x: t.pos.x + dx * u - dy * v, y: t.pos.y + dy * u + dx * v });
  const uOf = (i: number) => uA + (i + 0.5) * step;
  const vOf = (j: number) => vB - (j + 0.5) * step;
  const ink = new Uint8Array(W * H);
  const m = img.toImage;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = at(uOf(i), vOf(j));
      const x = Math.floor(m[0] * p.x + m[2] * p.y + m[4]);
      const y = Math.floor(m[1] * p.x + m[3] * p.y + m[5]);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const k = (y * img.width + x) * 4;
      if (Math.min(img.data[k], img.data[k + 1], img.data[k + 2]) < INK_BELOW) ink[j * W + i] = 1;
    }
  }
  // long straight strokes along and across the text are lines, not letters
  const line = new Uint8Array(W * H);
  const maxAlong = (0.95 * em) / step;
  const maxAcross = (1.2 * em) / step;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; ) {
      if (!ink[j * W + i]) {
        i++;
        continue;
      }
      let e = i;
      while (e < W && ink[j * W + e]) e++;
      if (e - i > maxAlong) for (let k = i; k < e; k++) line[j * W + k] = 1;
      i = e;
    }
  }
  for (let i = 0; i < W; i++) {
    for (let j = 0; j < H; ) {
      if (!ink[j * W + i]) {
        j++;
        continue;
      }
      let e = j;
      while (e < H && ink[e * W + i]) e++;
      if (e - j > maxAcross) for (let k = j; k < e; k++) line[k * W + i] = 1;
      j = e;
    }
  }
  for (let k = 0; k < ink.length; k++) if (line[k]) ink[k] = 0;
  // the band of the letters themselves: a piece that reaches past it (a leader,
  // text on the next line) keeps only what lies inside it
  const core = (i: number, j: number) => {
    const u = uOf(i);
    const v = vOf(j);
    return u >= shift - 1.4 * em && u <= shift + t.width + 1.4 * em && v >= -0.32 * em && v <= 1.02 * em;
  };
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  const out: InkPiece[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!ink[s] || seen[s]) continue;
    const comp: number[] = [];
    let edge = false;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      const x = k % W;
      const y = (k - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (ink[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    const kept = edge ? comp.filter((k) => core(k % W, Math.floor(k / W))) : comp;
    if (kept.length < 2) continue;
    // a piece mostly above or below the letters belongs to another line of text
    let vs = 0;
    for (const k of kept) vs += vOf(Math.floor(k / W));
    const vc = vs / kept.length;
    if (vc < -0.3 * em || vc > 1.0 * em) continue;
    out.push(piece(kept, W, uOf, vOf, step, at));
  }
  return out;
}

/** Outline of a piece of ink: the hull of its pixels, grown a little for anti-aliasing. */
function piece(comp: number[], W: number, uOf: (i: number) => number, vOf: (j: number) => number, step: number, at: (u: number, v: number) => Pt): InkPiece {
  const rows = new Map<number, [number, number]>();
  for (const k of comp) {
    const i = k % W;
    const j = (k - i) / W;
    const r = rows.get(j);
    if (!r) rows.set(j, [i, i]);
    else {
      if (i < r[0]) r[0] = i;
      if (i > r[1]) r[1] = i;
    }
  }
  const g = 0.5 + 1.2; // half a pixel to its edge, and about 1.2 pixels of anti-aliasing
  const pts: { u: number; v: number }[] = [];
  let u0 = Infinity;
  let u1 = -Infinity;
  for (const [j, [a, b]] of rows) {
    const vt = vOf(j) + g * step;
    const vb = vOf(j) - g * step;
    const ua = uOf(a) - g * step;
    const ub = uOf(b) + g * step;
    pts.push({ u: ua, v: vt }, { u: ua, v: vb }, { u: ub, v: vt }, { u: ub, v: vb });
    u0 = Math.min(u0, uOf(a));
    u1 = Math.max(u1, uOf(b));
  }
  const hull = convexHull(pts).map((p) => at(p.u, p.v));
  return { u0, u1, hull };
}

function convexHull(pts: { u: number; v: number }[]): { u: number; v: number }[] {
  const p = [...pts].sort((a, b) => a.u - b.u || a.v - b.v);
  if (p.length < 3) return p;
  const cross = (o: { u: number; v: number }, a: { u: number; v: number }, b: { u: number; v: number }) => (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);
  const lower: typeof p = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: typeof p = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Where character `n` of `t` starts, along the text (as in textCorners), from its font. */
function cellEdge(t: TextEntity, n: number): number {
  const shift = t.align === 'center' ? -t.width / 2 : t.align === 'right' ? -t.width : 0;
  const chars = [...t.text];
  const w = t.face ? advance(getFace(t.face), chars.slice(0, n).join('')) * t.fontSize * (t.hscale ?? 1) : (t.width * n) / Math.max(1, chars.length);
  return shift + Math.min(t.width, w);
}

/**
 * Outlines of the letters of `t` that are written again: characters
 * `chars[0]` up to `chars[1]` of its text. Where each character lies comes
 * from its font, fitted to where the ink of the text starts and ends on the
 * page; each boundary is then moved to the nearest gap between letters, so a
 * letter is wholly in or out ("Dia:" keeps its colon). Without `chars`, the
 * letters whose middle lies between `uFrom` and `uTo`. Null when no letters
 * were measured there.
 */
export function inkBetween(t: TextEntity, uFrom: number, uTo: number, chars?: [number, number]): Pt[][] | null {
  if (!t.ink?.length) return null;
  const em = t.fontSize;
  const mid = (p: InkPiece) => (p.u0 + p.u1) / 2;
  let a = uFrom;
  let b = uTo;
  if (chars) {
    const all = [...t.text];
    const first = all.findIndex((c) => /\S/.test(c));
    let last = all.length - 1;
    while (last > 0 && !/\S/.test(all[last])) last--;
    const E0 = cellEdge(t, Math.max(0, first));
    const E1 = cellEdge(t, last + 1);
    // The ink of the text itself: the letters inside its estimated extent,
    // and the chain of letters next to them (the estimate is often a little
    // short or long), but not a mark further away.
    const sorted0 = [...t.ink].sort((x, y) => x.u0 - y.u0);
    const inside = sorted0.filter((p) => mid(p) >= E0 && mid(p) <= E1);
    let M0 = Math.min(...inside.map((p) => p.u0));
    let M1 = Math.max(...inside.map((p) => p.u1));
    const step = 0.55 * em;
    for (let grew = true; grew && inside.length; ) {
      grew = false;
      for (const p of sorted0) {
        if (p.u1 >= M0 - step && p.u0 < M0 && mid(p) < M0 + 0.1 * em) {
          M0 = p.u0;
          grew = true;
        }
        if (p.u0 <= M1 + step && p.u1 > M1 && mid(p) > M1 - 0.1 * em) {
          M1 = p.u1;
          grew = true;
        }
      }
    }
    const core = sorted0.filter((p) => p.u1 >= M0 && p.u0 <= M1);
    const k = (M1 - M0) / Math.max(1e-9, E1 - E0);
    const fit = core.length && k > 0.8 && k < 1.25;
    const map = (e: number) => (fit ? M0 + (e - E0) * k : e);
    // gaps between letters (pieces that overlap along the text are one letter)
    const sorted = [...t.ink].sort((x, y) => x.u0 - y.u0);
    const gaps: number[] = [];
    let end = -Infinity;
    for (const p of sorted) {
      if (p.u0 > end) gaps.push((end + p.u0) / 2);
      end = Math.max(end, p.u1);
    }
    const snap = (u: number) => {
      let best = u;
      let d = 0.3 * em;
      for (const g of gaps) if (Number.isFinite(g) && Math.abs(g - u) < d) [best, d] = [g, Math.abs(g - u)];
      return best;
    };
    a = chars[0] <= Math.max(0, first) ? -Infinity : snap(map(cellEdge(t, chars[0])));
    b = chars[1] > last ? Infinity : snap(map(cellEdge(t, chars[1])));
    const hit = core.filter((p) => mid(p) > a && mid(p) < b);
    return hit.length ? hit.map((p) => p.hull) : null;
  }
  const slack = 0.06 * em;
  const hit = t.ink.filter((p) => mid(p) >= a - slack && mid(p) <= b + slack);
  return hit.length ? hit.map((p) => p.hull) : null;
}

/** The pixel at a drawing point is ink (for tests). */
export function isInk(img: PageImage, p: Pt): boolean {
  const q = apply(img.toImage, p);
  const x = Math.floor(q.x);
  const y = Math.floor(q.y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return false;
  const k = (y * img.width + x) * 4;
  return Math.min(img.data[k], img.data[k + 1], img.data[k + 2]) < INK_BELOW;
}
