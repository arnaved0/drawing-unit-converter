// Turns raw vector paths (from PDF content streams) into CAD entities:
// lines, circles, arcs, polylines with arc segments, filled solids, and
// free-form curves for anything that is not a line or circular arc.

import { bulgeArc, dist, fitCubic, normAngle } from '../geom';
import { newId, type Entity, type PathSeg, type Pt, type Style, type Vertex } from '../model';

export type RawSeg = { t: 'L'; p: Pt } | { t: 'C'; c1: Pt; c2: Pt; p: Pt };

export interface RawSubpath {
  start: Pt;
  segs: RawSeg[];
  closed: boolean;
}

export interface Paint {
  stroke: boolean;
  fill: boolean;
}

/** Geometric tolerance in drawing units (mm). */
const TOL = 0.02;

function sameCircle(a: { c: Pt; r: number }, b: { c: Pt; r: number }): boolean {
  const t = Math.max(0.05, a.r * 0.005);
  return dist(a.c, b.c) <= t && Math.abs(a.r - b.r) <= t;
}

export function subpathToEntity(sp: RawSubpath, style: Style, paint: Paint): Entity | null {
  // 1. classify every Bezier segment
  const segs: PathSeg[] = [];
  let cur = sp.start;
  for (const s of sp.segs) {
    if (s.t === 'L') {
      if (dist(cur, s.p) > 1e-6) segs.push(s);
    } else {
      const fit = fitCubic(cur, s.c1, s.c2, s.p, TOL);
      if (fit.type === 'line') {
        if (dist(cur, s.p) > 1e-6) segs.push({ t: 'L', p: s.p });
      } else if (fit.type === 'arc') segs.push({ t: 'A', p: s.p, bulge: fit.bulge });
      else segs.push(s);
    }
    cur = s.p;
  }
  if (!segs.length) return null;

  const end = segs[segs.length - 1].p;
  const closed = sp.closed || (segs.length > 1 && dist(end, sp.start) <= TOL);
  const fillOnly = paint.fill && !paint.stroke;
  const st: Style = { ...style, stroke: paint.stroke, fill: paint.fill ? style.fill ?? style.color : null };

  if (segs.some((s) => s.t === 'C')) {
    return { kind: 'curve', id: newId(), style: st, start: sp.start, segs, closed };
  }

  // 2. vertices with bulges
  const verts: Vertex[] = [{ ...sp.start }];
  for (const s of segs) {
    if (s.t === 'A') verts[verts.length - 1].bulge = s.bulge;
    verts.push({ x: s.p.x, y: s.p.y });
  }
  if (closed && verts.length > 2 && dist(verts[verts.length - 1], verts[0]) <= TOL) verts.pop();

  const allLines = segs.every((s) => s.t === 'L');
  if (fillOnly && allLines && closed && verts.length >= 3 && verts.length <= 4) {
    return { kind: 'solid', id: newId(), style: st, pts: verts.map((v) => ({ x: v.x, y: v.y })) };
  }
  if (segs.length === 1 && segs[0].t === 'L' && !paint.fill) {
    return { kind: 'line', id: newId(), style: st, a: sp.start, b: segs[0].p };
  }

  // 3. arcs of one circle -> CIRCLE or ARC
  if (segs.every((s) => s.t === 'A')) {
    let p = sp.start;
    const arcs = segs.map((s) => {
      const a = bulgeArc(p, s.p, (s as { bulge: number }).bulge);
      p = s.p;
      return a;
    });
    if (arcs.every((a) => sameCircle(a, arcs[0]))) {
      const total = arcs.reduce((acc, a) => acc + a.sweep, 0);
      const c = arcs[0].c;
      const r = arcs.reduce((acc, a) => acc + a.r, 0) / arcs.length;
      if (Math.abs(Math.abs(total) - 2 * Math.PI) < 0.01) {
        return { kind: 'circle', id: newId(), style: st, c, r };
      }
      if (!paint.fill && Math.abs(total) < 2 * Math.PI) {
        const a0 = arcs[0].start;
        const a1 = a0 + total;
        const [start, endA] = total >= 0 ? [a0, a1] : [a1, a0];
        return { kind: 'arc', id: newId(), style: st, c, r, start: normAngle(start), end: normAngle(endA) };
      }
    }
  }
  return { kind: 'polyline', id: newId(), style: st, pts: verts, closed };
}
