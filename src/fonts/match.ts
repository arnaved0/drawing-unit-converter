// Finds the font, size and width of text that is only an image or letter
// shapes (OCR text), so a converted value can be written to look the same.
//
// The letters of a line are cut out of the page image in the line's own
// frame. The recognised text is drawn in each bundled face, stretched to the
// same ink box, and compared pixel by pixel. The face that overlaps best
// wins; its ink box gives the em size, the width factor and the baseline.

import { advance, FACES, familyFace, getFace, type Face, type FaceId } from './faces';

interface P {
  x: number;
  y: number;
}

export interface RGBA {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** An OCR line in image pixels: centre, reading direction (unit), length and height of its box. */
export interface LineBox {
  c: P;
  u: P;
  len: number;
  hgt: number;
}

/** Text drawn by a face: ink coverage per pixel (0..255) and where the pen started. */
export interface Rendered {
  width: number;
  height: number;
  alpha: Uint8ClampedArray;
  /** Baseline row and pen start column. */
  baseline: number;
  originX: number;
}

/** Draws `text` in a face at em size `emPx` pixels (slanted by `slant`, tan of the angle). */
export type RenderText = (face: Face, text: string, emPx: number, slant: number) => Rendered;

/** Slant tried for sloped lettering (ISO 3098 type B leans 15°). */
export const SLANT = Math.tan((15 * Math.PI) / 180);

/** The letters of a line, in the line frame (x along the text, y down). */
export interface Measured {
  /** Ink coverage 0..1 inside the ink box, row by row. */
  ink: Float32Array;
  w: number;
  h: number;
  /** Ink box corner in the line frame. */
  x0: number;
  y0: number;
  /** Line frame -> image: origin and axes. */
  o: P;
  u: P;
  d: P;
  /** Pixels per frame unit (1 unless the line was resampled). */
  step: number;
}

export interface Fit {
  face: FaceId;
  slant: number;
  score: number;
  /** Em size in image pixels. */
  emPx: number;
  /** Width factor (1 = the face's own widths). */
  hscale: number;
  /** Baseline start in image pixels. */
  origin: P;
  u: P;
  /** Glyph "down" direction in the image. */
  d: P;
  /** Advance width of the text in image pixels. */
  advancePx: number;
}

const inkAt = (img: RGBA, x: number, y: number): number => {
  // bilinear: ink = how far the darkest channel is from white
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let s = 0;
  for (const [dx, dy, w] of [
    [0, 0, (1 - fx) * (1 - fy)],
    [1, 0, fx * (1 - fy)],
    [0, 1, (1 - fx) * fy],
    [1, 1, fx * fy],
  ]) {
    if (w === 0) continue;
    const px = x0 + dx;
    const py = y0 + dy;
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
    const i = (py * img.width + px) * 4;
    const d = img.data;
    s += w * (255 - Math.min(d[i], d[i + 1], d[i + 2]));
  }
  return s / 255;
};

/**
 * Cuts out the letters of a line. Left out, as they are not part of the
 * text: long straight strokes (a dimension line under the text, an extension
 * line through it), shapes that run into the edge of the cut, and, when the
 * recognised `text` is given, thin strokes across the line and specks at its
 * ends that the text does not account for.
 */
export function measureLine(img: RGBA, l: LineBox, text?: string): Measured | null {
  if (!(l.hgt > 4) || !(l.len > 2)) return null;
  const u = { x: l.u.x, y: l.u.y };
  const d = { x: -u.y, y: u.x };
  const pad = 0.15 * l.hgt;
  // at most ~96 px high: finer adds nothing for comparing shapes
  const step = Math.max(1, (l.hgt + 2 * pad) / 96);
  const W = Math.ceil((l.len + 2 * pad) / step);
  const H = Math.ceil((l.hgt + 2 * pad) / step);
  if (W * H > 4e6) return null;
  const o = { x: l.c.x - u.x * (l.len / 2 + pad) - d.x * (l.hgt / 2 + pad), y: l.c.y - u.y * (l.len / 2 + pad) - d.y * (l.hgt / 2 + pad) };
  const v = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const a = (i + 0.5) * step;
      const b = (j + 0.5) * step;
      v[j * W + i] = inkAt(img, o.x + u.x * a + d.x * b, o.y + u.y * a + d.y * b);
    }
  }
  const keep = new Uint8Array(W * H);
  for (let k = 0; k < keep.length; k++) keep[k] = v[k] > 0.4 ? 1 : 0;
  // thin lines are faint in places at this resolution: look for them in the faint ink too
  const on = new Uint8Array(W * H);
  for (let k = 0; k < on.length; k++) on[k] = v[k] > 0.15 ? 1 : 0;
  const cut = new Uint8Array(W * H);
  // straight strokes longer than any letter stroke
  const maxRun = (0.85 * l.hgt) / step;
  for (let j = 0; j < H; j++) {
    let i = 0;
    while (i < W) {
      if (!on[j * W + i]) {
        i++;
        continue;
      }
      let e = i;
      while (e < W && on[j * W + e]) e++;
      if (e - i > maxRun) for (let k = i; k < e; k++) cut[j * W + k] = 1;
      i = e;
    }
  }
  const maxCol = 0.92 * H;
  for (let i = 0; i < W; i++) {
    let j = 0;
    while (j < H) {
      if (!on[j * W + i]) {
        j++;
        continue;
      }
      let e = j;
      while (e < H && on[e * W + i]) e++;
      if (e - j > maxCol) for (let k = j; k < e; k++) cut[k * W + i] = 1;
      j = e;
    }
  }
  // Connected shapes that touch the edge of the cut come from outside the text.
  // They are traced through faint ink too, since thin lines fade in places;
  // the long straight runs found above are already cut out.
  for (let k = 0; k < on.length; k++) if (cut[k]) on[k] = keep[k] = 0;
  const label = new Int32Array(W * H).fill(-1);
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!on[s] || label[s] >= 0) continue;
    const members: number[] = [];
    let edge = false;
    label[s] = s;
    stack.push(s);
    while (stack.length) {
      const k = stack.pop()!;
      members.push(k);
      const x = k % W;
      const y = (k - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (on[n] && label[n] < 0) {
            label[n] = s;
            stack.push(n);
          }
        }
      }
    }
    if (edge) for (const k of members) keep[k] = 0;
  }
  // Thin strokes across the text direction (extension lines, arrow tails)
  // cannot be letters unless the text has letters made of one stroke.
  if (text !== undefined && !/[lI|!\[\]]/.test(text)) {
    const thin = Math.max(2.5, (0.09 * l.hgt) / step);
    const tall = (0.45 * l.hgt) / step;
    const seen = new Uint8Array(W * H);
    for (let s = 0; s < W * H; s++) {
      if (!keep[s] || seen[s]) continue;
      const members: number[] = [];
      let bx0 = W;
      let bx1 = -1;
      let by0 = H;
      let by1 = -1;
      seen[s] = 1;
      stack.push(s);
      while (stack.length) {
        const k = stack.pop()!;
        members.push(k);
        const x = k % W;
        const y = (k - x) / W;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const n = ny * W + nx;
            if (keep[n] && !seen[n]) {
              seen[n] = 1;
              stack.push(n);
            }
          }
        }
      }
      if (bx1 - bx0 + 1 <= thin && by1 - by0 + 1 >= tall) for (const k of members) keep[k] = 0;
    }
  }
  if (text !== undefined) dropEndSpecks(keep, W, H, text);
  let x0 = W;
  let x1 = -1;
  let y0 = H;
  let y1 = -1;
  let count = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (!keep[j * W + i]) continue;
      count++;
      if (i < x0) x0 = i;
      if (i > x1) x1 = i;
      if (j < y0) y0 = j;
      if (j > y1) y1 = j;
    }
  }
  if (count < 6 || x1 - x0 < 1 || y1 - y0 < 2) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  // soft ink of the kept shapes (and their anti-aliased rims)
  const ink = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = (j + y0) * W + (i + x0);
      let near = keep[k];
      if (!near && v[k] > 0.05) {
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) {
          const nx = i + x0 + dx;
          const ny = j + y0 + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && keep[ny * W + nx]) near = 1;
        }
      }
      ink[j * w + i] = near ? Math.min(1, v[k]) : 0;
    }
  }
  return { ink, w, h, x0, y0, o, u, d, step };
}

/** Punctuation small enough to look like a speck. */
const SMALL = /[.,:;'"`\-°*~^]/;

/**
 * Removes specks at the ends of a line (pieces of arrowheads, ticks) that
 * the text does not account for: a tiny shape before the first letter is
 * dropped unless the text starts with punctuation, and the same at the end.
 */
function dropEndSpecks(keep: Uint8Array, W: number, H: number, text: string): void {
  const comps: { members: number[]; x0: number; x1: number }[] = [];
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!keep[s] || seen[s]) continue;
    const c = { members: [] as number[], x0: W, x1: -1 };
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const k = stack.pop()!;
      c.members.push(k);
      const x = k % W;
      const y = (k - x) / W;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (keep[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    comps.push(c);
  }
  if (comps.length < 3) return;
  const areas = comps.map((c) => c.members.length).sort((a, b) => a - b);
  const big = areas[Math.floor(areas.length * 0.75)];
  const t = text.trim();
  const drop = (c: (typeof comps)[number]) => {
    for (const k of c.members) keep[k] = 0;
    comps.splice(comps.indexOf(c), 1);
  };
  for (let n = 0; n < 2 && comps.length > 2; n++) {
    const first = comps.reduce((a, b) => (b.x0 < a.x0 ? b : a));
    if (!SMALL.test(t[0]) && first.members.length < 0.35 * big) drop(first);
    else break;
  }
  for (let n = 0; n < 2 && comps.length > 2; n++) {
    const last = comps.reduce((a, b) => (b.x1 > a.x1 ? b : a));
    if (!SMALL.test(t[t.length - 1]) && last.members.length < 0.35 * big) drop(last);
    else break;
  }
}

/** Centre and spread (standard deviation) of the ink, in pixels (pixel centres at +0.5). */
function moments(a: ArrayLike<number>, w: number, h: number, full: number): { cx: number; cy: number; sx: number; sy: number } | null {
  let s = 0;
  let x1 = 0;
  let y1 = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = a[j * w + i] / full;
      if (v <= 0) continue;
      s += v;
      x1 += v * (i + 0.5);
      y1 += v * (j + 0.5);
    }
  }
  if (!(s > 0)) return null;
  const cx = x1 / s;
  const cy = y1 / s;
  let x2 = 0;
  let y2 = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = a[j * w + i] / full;
      if (v <= 0) continue;
      x2 += v * (i + 0.5 - cx) ** 2;
      y2 += v * (j + 0.5 - cy) ** 2;
    }
  }
  const sx = Math.sqrt(x2 / s);
  const sy = Math.sqrt(y2 / s);
  return sx > 0 && sy > 0 ? { cx, cy, sx, sy } : null;
}

/** Light 3x3 blur, so a pixel of misalignment does not count as a miss. */
function blur(a: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(a.length);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const y = j + dy;
        if (y < 0 || y >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = i + dx;
          if (x < 0 || x >= w) continue;
          const k = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
          s += a[y * w + x] * k;
          n += k;
        }
      }
      out[j * w + i] = s / n;
    }
  }
  return out;
}

/**
 * Draws large and shrinks: at small sizes font hinting snaps heights to whole
 * pixels, which would throw the size off by several percent.
 */
function renderFine(render: RenderText, face: Face, text: string, emPx: number, slant: number): Rendered {
  const k = Math.max(1, Math.min(6, Math.ceil(72 / emPx)));
  if (k === 1) return render(face, text, emPx, slant);
  const big = render(face, text, emPx * k, slant);
  const w = Math.floor(big.width / k);
  const h = Math.floor(big.height / k);
  const alpha = new Uint8ClampedArray(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0;
      for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) s += big.alpha[(j * k + y) * big.width + i * k + x];
      alpha[j * w + i] = s / (k * k);
    }
  }
  return { width: w, height: h, alpha, baseline: big.baseline / k, originX: big.originX / k };
}

/** How well a face drawing `text` matches the measured letters, and where it would sit. */
export function fitFace(m: Measured, text: string, face: Face, slant: number, render: RenderText): Fit | null {
  if (!text.trim()) return null;
  // Draw at the measured size, so strokes are as thick (in pixels) as the
  // original's: a first drawing gives the size, a second one is compared.
  // Sizes come from the spread of the ink (second moments), not from the ink
  // box: anti-aliasing makes a box a pixel larger or smaller, which on small
  // text is several percent.
  const mm = moments(m.ink, m.w, m.h, 1);
  if (!mm) return null;
  let emGuess = Math.min(160, Math.max(12, m.h / 0.72));
  let r: Rendered | null = null;
  let tm: ReturnType<typeof moments> = null;
  for (let pass = 0; ; pass++) {
    r = renderFine(render, face, text, emGuess, slant);
    tm = moments(r.alpha, r.width, r.height, 255);
    if (!tm) return null;
    if (pass === 2) break;
    const next = Math.min(160, Math.max(12, (emGuess * mm.sy) / tm.sy));
    if (Math.abs(next - emGuess) < 0.25) break;
    emGuess = next;
  }
  if (!r || !tm) return null;
  // template px -> measured px
  const SX = mm.sx / tm.sx;
  const SY = mm.sy / tm.sy;
  // template laid onto the measured letters, centre on centre
  const t = new Float32Array(m.w * m.h);
  const A = r.alpha;
  const W = r.width;
  for (let j = 0; j < m.h; j++) {
    const sy = tm.cy + (j + 0.5 - mm.cy) / SY - 0.5;
    for (let i = 0; i < m.w; i++) {
      const sx = tm.cx + (i + 0.5 - mm.cx) / SX - 0.5;
      if (sx < 0 || sy < 0 || sx > r.width - 1 || sy > r.height - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(r.width - 1, x0 + 1);
      const y1 = Math.min(r.height - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      t[j * m.w + i] =
        (A[y0 * W + x0] * (1 - fx) * (1 - fy) + A[y0 * W + x1] * fx * (1 - fy) + A[y1 * W + x0] * (1 - fx) * fy + A[y1 * W + x1] * fx * fy) / 255;
    }
  }
  const a = blur(m.ink, m.w, m.h);
  const c = blur(t, m.w, m.h);
  let inter = 0;
  let union = 0;
  for (let k = 0; k < a.length; k++) {
    inter += Math.min(a[k], c[k]);
    union += Math.max(a[k], c[k]);
  }
  if (!(union > 0)) return null;
  // in image pixels
  const sY = SY * m.step;
  const sX = SX * m.step;
  const emPx = emGuess * sY;
  const hscale = sX / sY;
  // a face far from its own widths is a poorer match, even if the shapes overlap
  const score = inter / union - 0.12 * Math.abs(Math.log(hscale));
  // pen start and baseline, in the line frame (image px), then in the image
  const fx = (m.x0 + mm.cx) * m.step + (r.originX - tm.cx) * sX;
  const fy = (m.y0 + mm.cy) * m.step + (r.baseline - tm.cy) * sY;
  const origin = { x: m.o.x + m.u.x * fx + m.d.x * fy, y: m.o.y + m.u.y * fx + m.d.y * fy };
  return { face: face.id, slant, score, emPx, hscale, origin, u: m.u, d: m.d, advancePx: advance(face, text) * emPx * hscale };
}

/** Scores of every face (upright) for one line. */
export function scoreFaces(m: Measured, text: string, render: RenderText, faces: Face[] = FACES): Fit[] {
  return faces.map((f) => fitFace(m, text, f, 0, render)).filter((x): x is Fit => !!x);
}

const chars = (s: string) => s.replace(/\s/g, '').length;

/** A fit that gives a sensible text: size near the OCR box height, width factor not extreme. */
export function plausible(f: Fit, l: LineBox): boolean {
  return f.hscale > 0.55 && f.hscale < 1.8 && f.emPx > 0.35 * l.hgt && f.emPx < 1.3 * l.hgt;
}

/**
 * Picks one family for a page (the face most lines agree on, weighted by
 * length), then for each line the weight (and slant) in that family. A line
 * keeps another family only when it clearly matches better and is long
 * enough to tell.
 */
export function chooseFits(
  lines: { text: string; m: Measured; box: LineBox; fits: Fit[] }[],
  render: RenderText,
  prefer?: Face['family'],
): { fits: (Fit | null)[]; family: Face['family'] | null } {
  const famScore = new Map<Face['family'], number>();
  for (const l of lines) {
    const n = chars(l.text);
    if (n < 2) continue;
    const w = Math.min(n, 12);
    const best = new Map<Face['family'], number>();
    for (const f of l.fits) {
      if (!plausible(f, l.box)) continue;
      const fam = getFace(f.face).family;
      best.set(fam, Math.max(best.get(fam) ?? -1, f.score));
    }
    for (const [fam, s] of best) famScore.set(fam, (famScore.get(fam) ?? 0) + w * s);
  }
  let family: Face['family'] | null = prefer ?? null;
  if (!family) {
    let top = -Infinity;
    for (const [fam, s] of famScore) if (s > top) [top, family] = [s, fam];
  }
  // How lines that measured well relate to their OCR box: lines that could not
  // be measured (a stroke of the drawing runs into them ...) are placed the same way.
  const good: { em: number; base: number; hs: number }[] = [];
  for (const l of lines) {
    for (const f of l.fits) {
      if (getFace(f.face).family !== family || f.score < GOOD || !plausible(f, l.box) || chars(l.text) < 3) continue;
      const base = ((f.origin.x - l.box.c.x) * f.d.x + (f.origin.y - l.box.c.y) * f.d.y) / l.box.hgt;
      good.push({ em: f.emPx / l.box.hgt, base, hs: f.hscale });
    }
  }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const page = good.length >= 2 && family ? { em: median(good.map((g) => g.em)), base: median(good.map((g) => g.base)), hs: median(good.map((g) => g.hs)) } : null;
  const fits = lines.map((l) => {
    const ok = l.fits.filter((f) => plausible(f, l.box) && f.score >= GOOD);
    if (!ok.length) return page && family ? pageFit(l.text, l.box, familyFace(family, false), page) : null;
    const inFam = ok.filter((f) => getFace(f.face).family === family);
    const overall = ok.reduce((a, b) => (b.score > a.score ? b : a));
    let pick = inFam.length ? inFam.reduce((a, b) => (b.score > a.score ? b : a)) : overall;
    if (overall !== pick && chars(l.text) >= 4 && overall.score > pick.score + 0.06) pick = overall;
    // sloped lettering: try the chosen face leaning
    const leaning = fitFace(l.m, l.text, getFace(pick.face), SLANT, render);
    if (leaning && plausible(leaning, l.box) && leaning.score > pick.score + 0.02) pick = leaning;
    return pick;
  });
  return { fits, family };
}

/** A fit below this overlap is not trusted (a stroke of the drawing got in, or OCR misread). */
const GOOD = 0.4;

/** A line placed from its OCR box the way the page's well-measured lines are. */
function pageFit(text: string, l: LineBox, face: Face, page: { em: number; base: number; hs: number }): Fit {
  const d = { x: -l.u.y, y: l.u.x };
  const emPx = page.em * l.hgt;
  const advancePx = advance(face, text) * emPx * page.hs;
  const origin = { x: l.c.x - l.u.x * (advancePx / 2) + d.x * page.base * l.hgt, y: l.c.y - l.u.y * (advancePx / 2) + d.y * page.base * l.hgt };
  return { face: face.id, slant: 0, score: 0, emPx, hscale: page.hs, origin, u: l.u, d, advancePx };
}

/**
 * OCR boxes of horizontal or vertical text are often a few degrees off. A
 * box within 8° of an axis is also tried on the axis; returns that box, or
 * null when the box is on an axis already or clearly sloped.
 */
export function snappedBox(l: LineBox): LineBox | null {
  const a = Math.atan2(l.u.y, l.u.x);
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  const off = Math.abs(a - q);
  if (off < 0.005 || off > (8 * Math.PI) / 180) return null;
  return { ...l, u: { x: Math.round(Math.cos(q)), y: Math.round(Math.sin(q)) } };
}

/** RenderText on a 2D canvas (a browser canvas, or @napi-rs/canvas in tests). */
export function canvasRenderer(createCanvas: (w: number, h: number) => { getContext(t: '2d', o?: unknown): any; width: number; height: number }): RenderText {
  let canvas: ReturnType<typeof createCanvas> | null = null;
  let ctx: any = null;
  return (face, text, emPx, slant) => {
    const pad = Math.ceil(emPx * 0.5);
    const w = Math.ceil(advance(face, text) * emPx + emPx * (0.6 + slant) + 2 * pad);
    const h = Math.ceil(emPx * 1.6 + 2 * pad);
    if (!canvas || canvas.width < w || canvas.height < h) {
      canvas = createCanvas(Math.max(w, canvas?.width ?? 0), Math.max(h, canvas?.height ?? 0));
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    const baseline = pad + Math.round(emPx * 1.15);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // lean around the baseline: x' = x - slant * (y - baseline)
    ctx.setTransform(1, 0, -slant, 1, slant * baseline, 0);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${emPx}px "${face.css}"`;
    ctx.fillText(text, pad, baseline);
    const img = ctx.getImageData(0, 0, w, h);
    const alpha = new Uint8ClampedArray(w * h);
    for (let k = 0; k < w * h; k++) alpha[k] = img.data[k * 4 + 3];
    return { width: w, height: h, alpha, baseline, originX: pad };
  };
}
