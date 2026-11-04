import type { Box, Entity, Pt, Block, TextEntity, PathSeg } from './model';

/** Affine matrix [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f (PDF convention). */
export type Mat = number[];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** Returns the matrix that applies `m2` first, then `m1`. */
export function mul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function apply(m: Mat, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function applyVec(m: Mat, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y, y: m[1] * p.x + m[3] * p.y };
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [...IDENTITY];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/** Average linear scale of a matrix (for line widths). */
export function matScale(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export function translate(x: number, y: number): Mat {
  return [1, 0, 0, 1, x, y];
}

export function rotateScale(rot: number, sx: number, sy: number): Mat {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [c * sx, s * sx, -s * sy, c * sy, 0, 0];
}

/** Transform of a block insert: translate(pos) * rotate * scale * translate(-base). */
export function insertMatrix(pos: Pt, rot: number, sx: number, sy: number, base: Pt): Mat {
  return mul(mul(translate(pos.x, pos.y), rotateScale(rot, sx, sy)), translate(-base.x, -base.y));
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

export function emptyBox(): Box {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function addPt(b: Box, p: Pt): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  if (p.x < b.minX) b.minX = p.x;
  if (p.y < b.minY) b.minY = p.y;
  if (p.x > b.maxX) b.maxX = p.x;
  if (p.y > b.maxY) b.maxY = p.y;
}

export function boxValid(b: Box): boolean {
  return Number.isFinite(b.minX) && b.maxX >= b.minX && b.maxY >= b.minY;
}

export function normAngle(a: number): number {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

/** Centre, radius and sweep of the arc between a and b with a DXF bulge. */
export function bulgeArc(a: Pt, b: Pt, bulge: number): { c: Pt; r: number; start: number; sweep: number } {
  const sweep = 4 * Math.atan(bulge);
  const chord = dist(a, b);
  const r = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  // distance from chord midpoint to centre (signed)
  const h = r * Math.cos(sweep / 2);
  const ux = (b.x - a.x) / chord;
  const uy = (b.y - a.y) / chord;
  const sign = sweep > 0 ? 1 : -1;
  const c = { x: mx - uy * h * sign, y: my + ux * h * sign };
  return { c, r, start: Math.atan2(a.y - c.y, a.x - c.x), sweep };
}

export function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

function circleThrough(a: Pt, b: Pt, c: Pt): { c: Pt; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const centre = { x: ux, y: uy };
  return { c: centre, r: dist(centre, a) };
}

/** Distance from p to the segment ab. */
export function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export type CubicFit =
  | { type: 'line' }
  | { type: 'arc'; c: Pt; r: number; bulge: number }
  | { type: 'curve' };

/**
 * Classify a cubic Bezier: straight line, circular arc (PDF writers draw arcs
 * and circles as Bezier approximations) or a genuine free-form curve.
 */
export function fitCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number): CubicFit {
  const chord = dist(p0, p3);
  if (segDist(p1, p0, p3) <= tol && segDist(p2, p0, p3) <= tol) return { type: 'line' };
  if (chord < 1e-9) return { type: 'curve' };
  const mid = cubicAt(p0, p1, p2, p3, 0.5);
  const circ = circleThrough(p0, mid, p3);
  if (!circ) return { type: 'curve' };
  const rtol = Math.max(tol, circ.r * 2e-3);
  for (const t of [0.15, 0.3, 0.7, 0.85]) {
    if (Math.abs(dist(cubicAt(p0, p1, p2, p3, t), circ.c) - circ.r) > rtol) return { type: 'curve' };
  }
  // Tangent at p0 must be perpendicular to the radius.
  const tx = p1.x - p0.x;
  const ty = p1.y - p0.y;
  const tl = Math.hypot(tx, ty);
  if (tl > 1e-9) {
    const rx = p0.x - circ.c.x;
    const ry = p0.y - circ.c.y;
    if (Math.abs((tx * rx + ty * ry) / (tl * circ.r)) > 0.02) return { type: 'curve' };
  }
  const a0 = Math.atan2(p0.y - circ.c.y, p0.x - circ.c.x);
  const am = Math.atan2(mid.y - circ.c.y, mid.x - circ.c.x);
  const ccw = (p0.x - circ.c.x) * (mid.y - circ.c.y) - (p0.y - circ.c.y) * (mid.x - circ.c.x) > 0;
  const half = ccw ? normAngle(am - a0) : -normAngle(a0 - am);
  const sweep = 2 * half;
  return { type: 'arc', c: circ.c, r: circ.r, bulge: Math.tan(sweep / 4) };
}

/** Points along a path (used for flattening curves to polylines). */
export function flattenSegs(start: Pt, segs: PathSeg[], steps = 16): Pt[] {
  const out: Pt[] = [start];
  let cur = start;
  for (const s of segs) {
    if (s.t === 'L') out.push(s.p);
    else if (s.t === 'C') {
      for (let i = 1; i <= steps; i++) out.push(cubicAt(cur, s.c1, s.c2, s.p, i / steps));
    } else {
      const arc = bulgeArc(cur, s.p, s.bulge);
      const n = Math.max(2, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 24)));
      for (let i = 1; i <= n; i++) {
        const a = arc.start + (arc.sweep * i) / n;
        out.push({ x: arc.c.x + arc.r * Math.cos(a), y: arc.c.y + arc.r * Math.sin(a) });
      }
    }
    cur = s.p;
  }
  return out;
}

export function arcPoints(c: Pt, r: number, start: number, end: number): Pt[] {
  let sweep = normAngle(end - start);
  if (sweep < 1e-9) sweep = 2 * Math.PI;
  const n = Math.max(4, Math.ceil(sweep / (Math.PI / 24)));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = start + (sweep * i) / n;
    pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return pts;
}

/** Corners of a text's box (baseline-relative) in drawing coordinates. */
export function textCorners(t: TextEntity, from = 0, to = 1, width = t.width): Pt[] {
  const dx = Math.cos(t.rotation);
  const dy = Math.sin(t.rotation);
  const nx = -dy;
  const ny = dx;
  const shift = t.align === 'center' ? -width / 2 : t.align === 'right' ? -width : 0;
  const x0 = shift + width * from;
  const x1 = shift + width * to;
  const lo = -0.22 * t.fontSize;
  const hi = 0.8 * t.fontSize;
  const at = (u: number, v: number): Pt => ({ x: t.pos.x + dx * u + nx * v, y: t.pos.y + dy * u + ny * v });
  return [at(x0, lo), at(x1, lo), at(x1, hi), at(x0, hi)];
}

/** Bounding box of an entity, expanding block inserts. */
export function entityBox(e: Entity, blocks: Record<string, Block>, m: Mat = IDENTITY, box = emptyBox(), depth = 0): Box {
  const add = (p: Pt) => addPt(box, apply(m, p));
  switch (e.kind) {
    case 'line': add(e.a); add(e.b); break;
    case 'polyline': {
      for (let i = 0; i < e.pts.length; i++) {
        const v = e.pts[i];
        add(v);
        const n = e.pts[(i + 1) % e.pts.length];
        if (v.bulge && (i < e.pts.length - 1 || e.closed)) {
          for (const p of flattenSegs(v, [{ t: 'A', p: n, bulge: v.bulge }], 8)) add(p);
        }
      }
      break;
    }
    case 'circle':
      for (const p of arcPoints(e.c, e.r, 0, 2 * Math.PI)) add(p);
      break;
    case 'arc':
      for (const p of arcPoints(e.c, e.r, e.start, e.end)) add(p);
      break;
    case 'curve':
      for (const p of flattenSegs(e.start, e.segs, 6)) add(p);
      for (const s of e.more ?? []) for (const p of flattenSegs(s.start, s.segs, 6)) add(p);
      break;
    case 'solid':
      e.pts.forEach(add);
      break;
    case 'text':
      textCorners(e).forEach(add);
      break;
    case 'image':
      add(e.p00); add(e.p10); add(e.p01);
      add({ x: e.p10.x + e.p01.x - e.p00.x, y: e.p10.y + e.p01.y - e.p00.y });
      break;
    case 'insert': {
      const b = blocks[e.block];
      if (!b || depth > 8) break;
      const mm = mul(m, insertMatrix(e.pos, e.rotation, e.sx, e.sy, b.base));
      for (const c of b.entities) entityBox(c, blocks, mm, box, depth + 1);
      break;
    }
  }
  return box;
}

/**
 * Extents used to fit the view. Stray far-away entities (common in real CAD
 * files) are ignored so the drawing itself fills the screen.
 */
export function drawingBounds(entities: Entity[], blocks: Record<string, Block>): Box {
  const boxes = entities.map((e) => entityBox(e, blocks)).filter(boxValid);
  if (!boxes.length) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const union = (list: Box[]) => {
    const b = emptyBox();
    for (const x of list) {
      addPt(b, { x: x.minX, y: x.minY });
      addPt(b, { x: x.maxX, y: x.maxY });
    }
    return b;
  };
  if (boxes.length < 20) return union(boxes);
  const pct = (vals: number[], p: number) => vals.sort((a, b) => a - b)[Math.floor((vals.length - 1) * p)];
  const cx = boxes.map((b) => (b.minX + b.maxX) / 2);
  const cy = boxes.map((b) => (b.minY + b.maxY) / 2);
  const x0 = pct([...cx], 0.05);
  const x1 = pct([...cx], 0.95);
  const y0 = pct([...cy], 0.05);
  const y1 = pct([...cy], 0.95);
  const span = Math.max(x1 - x0, y1 - y0, 1e-6);
  const lim = { minX: x0 - span, maxX: x1 + span, minY: y0 - span, maxY: y1 + span };
  const kept = boxes.filter((b) => b.minX >= lim.minX && b.maxX <= lim.maxX && b.minY >= lim.minY && b.maxY <= lim.maxY);
  return kept.length ? union(kept) : union(boxes);
}

/** Point-in-polygon test (even-odd). */
export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
