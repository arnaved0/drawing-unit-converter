// Places converted values the way a drafter would: where the old value was
// when the new one fits, otherwise moved a little into clear space (along its
// dimension line, or off it) or made a little smaller, so it does not run into
// lines, arrowheads, other text or the edge of the sheet.
//
// What is on the drawing comes from a picture of it (the rendered PDF page,
// or the CAD drawing drawn without the values being replaced): an "ink map".
// Each value is tried at nearby positions and a few sizes; the try that hits
// the least ink and text, for the least movement and shrinking, wins. Values
// are placed one after another, each avoiding those placed before it.

import { apply, type Mat } from '../geom';
import type { Dimension } from '../dimensions';
import type { Box, Drawing, Pt, TextEntity } from '../model';
import { basePlacement, drawnCorners, movedPos, sized, textAdvance } from '../render/svg';

/** Dark pixels of a picture of the drawing. */
export interface InkMap {
  width: number;
  height: number;
  /** 1 = ink. */
  ink: Uint8Array;
  /** Drawing coordinates -> map pixels. */
  toGrid: Mat;
}

/** An ink map from RGBA pixels: a pixel is ink when it is clearly darker than paper. */
export function inkMapFromRGBA(data: Uint8ClampedArray, width: number, height: number, toGrid: Mat): InkMap {
  const ink = new Uint8Array(width * height);
  for (let k = 0; k < width * height; k++) {
    const o = k * 4;
    if (data[o + 3] > 40 && Math.min(data[o], data[o + 1], data[o + 2]) < 200) ink[k] = 1;
  }
  return { width, height, ink, toGrid };
}

/** Sets every map pixel inside polygon `poly` (drawing coordinates) to `v`. */
function fillPoly(grid: Uint8Array, map: InkMap, poly: Pt[], v: number, grow = 0): void {
  const q = poly.map((p) => apply(map.toGrid, p));
  const y0 = Math.max(0, Math.floor(Math.min(...q.map((p) => p.y)) - grow));
  const y1 = Math.min(map.height - 1, Math.ceil(Math.max(...q.map((p) => p.y)) + grow));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < q.length; i++) {
      const a = q[i];
      const b = q[(i + 1) % q.length];
      if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.floor(xs[k] - grow));
      const x1 = Math.min(map.width - 1, Math.ceil(xs[k + 1] + grow));
      for (let x = x0; x <= x1; x++) grid[y * map.width + x] = v;
    }
  }
}

export interface ArrangeOptions {
  /** The page is shown as rendered (PDF, picture): values are written over white patches. */
  pageShown: boolean;
  /** Where text may go (the sheet, or the drawing's extents). */
  bounds: Box;
  /** Texts to arrange; the others stay where they are. All converted ones when missing. */
  only?: Set<string>;
}

/** Moves and resizes converted values so they sit clear of the drawing. Returns how many changed. */
export function arrange(d: Drawing, dims: Dimension[], map: InkMap, opts: ArrangeOptions): number {
  const byText = new Map<string, Dimension[]>();
  for (const x of dims) {
    const l = byText.get(x.textId) ?? [];
    l.push(x);
    byText.set(x.textId, l);
  }
  const texts = d.entities.filter((e): e is TextEntity => e.kind === 'text' && byText.has(e.id));
  // what is drawn, without the original letters of converted values (they are whited out)
  const ink = map.ink.slice();
  const taken = new Uint8Array(map.width * map.height);
  const items: { t: TextEntity; base: NonNullable<ReturnType<typeof basePlacement>> }[] = [];
  for (const t of texts) {
    const list = byText.get(t.id)!;
    const converted = list.some((x) => x.converted);
    const base = converted ? basePlacement(t, list, opts.pageShown) : null;
    if (base) for (const m of base.masks) fillPoly(ink, map, m, 0, 0.5);
    if (base && t.placedBy !== 'user' && (!opts.only || opts.only.has(t.id))) items.push({ t, base });
  }
  // text that stays as it is: unconverted values, and converted ones not arranged now
  for (const t of texts) {
    if (items.some((it) => it.t === t)) continue;
    const list = byText.get(t.id)!;
    const base = list.some((x) => x.converted) ? basePlacement(t, list, opts.pageShown) : null;
    if (base) {
      const sz = sized(t, movedPos(t, base.pos), base);
      fillPoly(taken, map, drawnCorners(sz.t, { text: base.text, pos: sz.pos, align: base.align }), 1);
    } else if (!opts.pageShown) {
      // CAD: unconverted values are not in the picture of the drawing
      fillPoly(taken, map, box(t, t.text, t.pos, t.align, 0, 0), 1);
    }
  }

  const step = 1; // map pixel
  const em = (t: TextEntity) => t.fontSize;
  /** Cost of writing item `it` moved by (du, dv) em and scaled by k. */
  const cost = (it: (typeof items)[number], du: number, dv: number, k: number): { c: number; poly: Pt[] } | null => {
    const t = it.t;
    const e = em(t);
    const dir = { x: Math.cos(t.rotation), y: Math.sin(t.rotation) };
    const up = { x: -dir.y, y: dir.x };
    const off = { x: (dir.x * du + up.x * dv) * e, y: (dir.y * du + up.y * dv) * e };
    const t2: TextEntity = { ...t, offset: off, sizeScale: k === 1 ? undefined : k };
    const sz = sized(t2, movedPos(t2, it.base.pos), it.base);
    const st = sz.t;
    const w = textAdvance(st, it.base.text);
    const a0 = it.base.align === 'center' ? -w / 2 : it.base.align === 'right' ? -w : 0;
    // the letters (digits reach a little under the baseline), and a margin of clear paper around them
    // from the baseline (a dimension line just under it is not in the letters) to the top of the digits
    const core = { u0: a0, u1: a0 + w, v0: 0.02 * st.fontSize, v1: 0.8 * st.fontSize };
    const m = 0.2 * st.fontSize;
    const d0 = { x: Math.cos(st.rotation), y: Math.sin(st.rotation) };
    const n0 = { x: -d0.y, y: d0.x };
    const at = (u: number, v: number): Pt => ({ x: sz.pos.x + d0.x * u + n0.x * v, y: sz.pos.y + d0.y * u + n0.y * v });
    const outer = [at(core.u0 - m, core.v0 - m), at(core.u1 + m, core.v0 - m), at(core.u1 + m, core.v1 + m), at(core.u0 - m, core.v1 + m)];
    // never past the edge of the sheet
    const b = opts.bounds;
    if (outer.some((p) => p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY)) return null;
    // What the original value already sat on or next to (its dimension line,
    // the arrowheads at its ends) was the drafter's choice: only new overlaps count.
    const o0 = { x: Math.cos(t.rotation), y: Math.sin(t.rotation) };
    const oShift = t.align === 'center' ? -t.width / 2 : t.align === 'right' ? -t.width : 0;
    const om = 0.25 * e;
    const ou0 = oShift - om;
    const ou1 = oShift + t.width + om;
    const ov0 = -0.3 * e;
    const ov1 = 1.05 * e;
    const local = (p: Pt) => {
      const x = p.x - t.pos.x;
      const y = p.y - t.pos.y;
      return { u: x * o0.x + y * o0.y, v: -x * o0.y + y * o0.x };
    };
    const accepted = (p: Pt) => {
      const q = local(p);
      return q.u >= ou0 && q.u <= ou1 && q.v >= ov0 && q.v <= ov1;
    };
    // the line the text sits on runs on past its ends: next to the letters, it is fine
    const inBand = (p: Pt) => {
      const q = local(p);
      return q.v >= ov0 && q.v <= ov1;
    };
    // sample the map along the text
    const g = map.toGrid;
    const scale = Math.hypot(g[0], g[1]);
    const nu = Math.max(2, Math.ceil((core.u1 - core.u0 + 2 * m) * scale / step));
    const nv = Math.max(2, Math.ceil((core.v1 - core.v0 + 2 * m) * scale / step));
    let coreN = 0;
    let coreInk = 0;
    let coreTaken = 0;
    let rimN = 0;
    let rimInk = 0;
    for (let i = 0; i <= nu; i++) {
      const u = core.u0 - m + ((core.u1 - core.u0 + 2 * m) * i) / nu;
      for (let j = 0; j <= nv; j++) {
        const v = core.v0 - m + ((core.v1 - core.v0 + 2 * m) * j) / nv;
        const p = at(u, v);
        const x = Math.floor(g[0] * p.x + g[2] * p.y + g[4]);
        const y = Math.floor(g[1] * p.x + g[3] * p.y + g[5]);
        const inside = x >= 0 && y >= 0 && x < map.width && y < map.height;
        const k2 = y * map.width + x;
        const rawInk = inside && ink[k2] === 1;
        const isInk = rawInk && !accepted(p);
        const isTaken = inside && taken[k2] === 1;
        if (u >= core.u0 && u <= core.u1 && v >= core.v0 && v <= core.v1) {
          coreN++;
          if (isInk) coreInk++;
          if (isTaken) coreTaken++;
        } else {
          rimN++;
          if ((isInk && !inBand(p)) || isTaken) rimInk++;
        }
      }
    }
    // In ink per em of text height (samples per em along each side): a thin line
    // across the letters costs about as much as moving the value 8 em; covering
    // other letters or a filled area costs far more.
    const spe = Math.max(1, (st.fontSize * scale) / step);
    const c =
      26 * (coreInk / spe) + 120 * (coreTaken / spe) + 4 * (rimInk / spe) + 2.5 * (Math.abs(du) + 1.4 * Math.abs(dv)) + 45 * (1 - k);
    return { c, poly: drawnCorners(st, { text: it.base.text, pos: sz.pos, align: it.base.align }) };
  };

  // the most crowded first: they get the clear space nearby
  const start = items.map((it) => ({ it, c: cost(it, 0, 0, 1)?.c ?? Infinity }));
  start.sort((p, q) => q.c - p.c);
  let changed = 0;
  const ALONG = [0, -0.25, 0.25, -0.5, 0.5, -1, 1, -1.6, 1.6, -2.5, 2.5, -4, 4];
  const ACROSS = [0, 0.3, -0.3, 0.6, -0.6, 1, -1, 1.5, -1.5, 2.2, -2.2];
  const SIZES = [1, 0.9, 0.8, 0.7];
  for (const { it } of start) {
    let best = { c: Infinity, du: 0, dv: 0, k: 1, poly: [] as Pt[] };
    for (const k of SIZES) {
      // a value inside a longer line stays in the line: only its size may change
      for (const du of it.base.whole ? ALONG : [0]) {
        for (const dv of it.base.whole ? ACROSS : [0]) {
          // moving costs at least as much as this: no need to look
          if (2.5 * (Math.abs(du) + 1.4 * Math.abs(dv)) + 45 * (1 - k) >= best.c) continue;
          const r = cost(it, du, dv, k);
          if (r && r.c < best.c) best = { c: r.c, du, dv, k, poly: r.poly };
        }
      }
    }
    if (!Number.isFinite(best.c)) continue;
    const t = it.t;
    const e = em(t);
    const dir = { x: Math.cos(t.rotation), y: Math.sin(t.rotation) };
    const up = { x: -dir.y, y: dir.x };
    const off = best.du || best.dv ? { x: (dir.x * best.du + up.x * best.dv) * e, y: (dir.y * best.du + up.y * best.dv) * e } : undefined;
    const k = best.k === 1 ? undefined : best.k;
    if (!same(t.offset, off) || t.sizeScale !== k) changed++;
    t.offset = off;
    t.sizeScale = k;
    t.placedBy = off || k ? 'auto' : undefined;
    // later values keep clear of this one
    fillPoly(taken, map, best.poly, 1, 1);
  }
  return changed;
}

const same = (a?: Pt, b?: Pt) => (!a && !b) || (!!a && !!b && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9);

/** Corners of text `s` written like `t` at `pos` (shifted du, dv em). */
function box(t: TextEntity, s: string, pos: Pt, align: TextEntity['align'], du: number, dv: number): Pt[] {
  const p = { x: pos.x + (Math.cos(t.rotation) * du - Math.sin(t.rotation) * dv) * t.fontSize, y: pos.y + (Math.sin(t.rotation) * du + Math.cos(t.rotation) * dv) * t.fontSize };
  return drawnCorners(t, { text: s, pos: p, align });
}
