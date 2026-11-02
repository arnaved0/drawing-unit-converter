// Raster line work -> CAD geometry.
//
// 1. ink mask (dark or strongly coloured pixels), text areas removed
// 2. filled triangles (arrowheads) found with a distance transform -> SOLID
// 3. Zhang-Suen thinning to 1-pixel centre lines
// 4. centre lines traced into paths between end points / junctions
// 5. each path fitted with circles, arcs and straight lines
// 6. clean-up: collinear pieces joined (dashed lines get a dash pattern),
//    arc pieces of one circle joined, end points snapped
//
// Everything is in image pixels (y down); the caller maps to drawing units.

import { luminance, otsu, type P, type RGBAImage } from './image';

export interface VLine { kind: 'line'; a: P; b: P; color: string; width: number; dash?: number[] }
export interface VArc { kind: 'arc'; c: P; r: number; /** image-space angles (y down), sweep clockwise-positive in image */ a0: number; sweep: number; color: string; width: number; dash?: number[] }
export interface VCircle { kind: 'circle'; c: P; r: number; color: string; width: number; dash?: number[] }
export interface VSolid { kind: 'solid'; pts: P[]; color: string }
export type VEntity = VLine | VArc | VCircle | VSolid;

export interface VectorizeOptions {
  pxPerMm: number;
  /** Rotated text boxes (corner points) to leave out of the line work. */
  textBoxes: P[][];
  onProgress?: (fraction: number, label: string) => void;
  /** Debug hook: receives intermediate binary images. */
  debug?: (name: string, mask: Uint8Array) => void;
}

export interface VectorizeResult {
  entities: VEntity[];
  strokeWidth: number;
  /** Dominant deviation of near-horizontal/vertical lines from the axes (radians, image space). */
  skew: number;
}

// ------------------------------------------------------------------ masks

function fillPolygon(mask: Uint8Array, w: number, h: number, poly: P[], value: number): void {
  const ys = poly.map((p) => p.y);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > y + 0.5 !== b.y > y + 0.5) xs.push(a.x + ((y + 0.5 - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) mask[y * w + x] = value;
    }
  }
}

/**
 * Evens out paper brightness (grey paper, shading, yellowed copies): each
 * pixel is scaled by the local paper level, estimated as the bright end of
 * the luminance in 64-pixel blocks and interpolated between blocks.
 */
function flattenBackground(lum: Uint8Array, w: number, h: number): void {
  const B = 64;
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const level = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let n = 0;
      for (let y = by * B; y < Math.min(h, by * B + B); y += 2) {
        for (let x = bx * B; x < Math.min(w, bx * B + B); x += 2) {
          hist[lum[y * w + x]]++;
          n++;
        }
      }
      // 90th percentile = paper (lines and text cover far less than 10 %)
      let acc = 0;
      let v = 255;
      for (let i = 0; i < 256; i++) {
        acc += hist[i];
        if (acc >= n * 0.9) {
          v = i;
          break;
        }
      }
      level[by * bw + bx] = Math.max(60, v);
    }
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const bg =
        (level[y0 * bw + x0] * (1 - tx) + level[y0 * bw + x1] * tx) * (1 - ty) + (level[y1 * bw + x0] * (1 - tx) + level[y1 * bw + x1] * tx) * ty;
      const i = y * w + x;
      lum[i] = Math.min(255, Math.round((lum[i] * 255) / bg));
    }
  }
}

function inkMask(img: RGBAImage): Uint8Array {
  const lum = luminance(img);
  flattenBackground(lum, img.width, img.height);
  const thr = otsu(lum);
  const n = img.width * img.height;
  const d = img.data;
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[i * 4];
    const g = d[i * 4 + 1];
    const b = d[i * 4 + 2];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum[i] < thr || (chroma > 70 && lum[i] < 235)) ink[i] = 1;
  }
  return ink;
}

/** Removes connected ink blobs smaller than minArea pixels (dust, speckles). */
function despeckle(ink: Uint8Array, w: number, h: number, minArea: number): void {
  const seen = new Uint8Array(ink.length);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i] || seen[i]) continue;
    comp.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      const x = k % w;
      const y = (k - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nk = ny * w + nx;
          if (ink[nk] && !seen[nk]) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
      }
    }
    if (comp.length < minArea) for (const k of comp) ink[k] = 0;
  }
}

/** Chamfer (3-4) distance to the nearest background pixel, divided by 3 (~ pixels). */
function distanceTransform(ink: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(ink.length);
  for (let i = 0; i < ink.length; i++) d[i] = ink[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) v = Math.min(v, 3);
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

/** Typical stroke width: most common width of short horizontal + vertical ink runs. */
function strokeWidthOf(ink: Uint8Array, w: number, h: number): number {
  const hist = new Uint32Array(64);
  for (let y = 0; y < h; y += 2) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (ink[y * w + x]) run++;
      else if (run) {
        if (run < 64) hist[run]++;
        run = 0;
      }
    }
  }
  for (let x = 0; x < w; x += 2) {
    let run = 0;
    for (let y = 0; y < h; y++) {
      if (ink[y * w + x]) run++;
      else if (run) {
        if (run < 64) hist[run]++;
        run = 0;
      }
    }
  }
  let best = 2;
  for (let i = 1; i < 20; i++) if (hist[i] > hist[best]) best = i;
  return best;
}

// ------------------------------------------------------------------ arrowheads

/** Finds filled triangles, returns them and clears their pixels from the ink mask. */
function findArrowheads(img: RGBAImage, ink: Uint8Array, dist: Float32Array, stroke: number, pxPerMm: number): VSolid[] {
  const { width: w, height: h } = img;
  // Thicker than a normal line. Bold lines pass this too, but fail the triangle test below.
  const core = stroke / 2 + 0.6;
  const seen = new Uint8Array(ink.length);
  const out: VSolid[] = [];
  const stack: number[] = [];
  const maxLen = 8 * pxPerMm;
  for (let i = 0; i < ink.length; i++) {
    if (seen[i] || dist[i] < core) continue;
    const blob: number[] = [];
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      blob.push(k);
      const x = k % w;
      const y = (k - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nk = ny * w + nx;
          if (!seen[nk] && dist[nk] >= core) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
      }
    }
    if (blob.length < 3 || blob.length > maxLen * maxLen) continue;
    const tri = arrowFromCore(ink, w, h, blob, stroke, pxPerMm);
    if (!tri) continue;
    // colour from the pixels inside the triangle, then erase it from the line work
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const grown = growTriangle(tri, 1.2);
    const xs = grown.map((p) => p.x);
    const ys = grown.map((p) => p.y);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(h - 1, Math.ceil(Math.max(...ys))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(w - 1, Math.ceil(Math.max(...xs))); x++) {
        const k = y * w + x;
        if (!ink[k] || !inTriangle({ x: x + 0.5, y: y + 0.5 }, grown)) continue;
        r += img.data[k * 4];
        g += img.data[k * 4 + 1];
        b += img.data[k * 4 + 2];
        n++;
        ink[k] = 0;
        seen[k] = 1;
      }
    }
    if (n) out.push({ kind: 'solid', pts: tri, color: snapColor(r / n, g / n, b / n) });
  }
  return out;
}

function inTriangle(p: P, t: P[]): boolean {
  const s = (a: P, b: P) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const d1 = s(t[0], t[1]);
  const d2 = s(t[1], t[2]);
  const d3 = s(t[2], t[0]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function growTriangle(t: P[], by: number): P[] {
  const c = { x: (t[0].x + t[1].x + t[2].x) / 3, y: (t[0].y + t[1].y + t[2].y) / 3 };
  return t.map((p) => {
    const d = Math.hypot(p.x - c.x, p.y - c.y) || 1;
    return { x: p.x + ((p.x - c.x) / d) * by * 1.6, y: p.y + ((p.y - c.y) / d) * by * 1.6 };
  });
}

/**
 * Rebuilds an arrowhead from its thick core: the ink width is measured
 * across the core's axis; a filled arrowhead tapers from a wide base to a
 * point. Returns [tip, base corner, base corner] or null.
 */
function arrowFromCore(ink: Uint8Array, w: number, h: number, blob: number[], stroke: number, pxPerMm: number): P[] | null {
  let mx = 0;
  let my = 0;
  for (const k of blob) {
    mx += k % w;
    my += Math.floor(k / w);
  }
  mx = mx / blob.length + 0.5;
  my = my / blob.length + 0.5;
  // axis = direction along which the ink extends furthest from the centre (the line through the arrow)
  let bestDir = 0;
  let bestLen = -1;
  const inkAt = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    return xi >= 0 && yi >= 0 && xi < w && yi < h && ink[yi * w + xi] === 1;
  };
  const widthAt = (cx: number, cy: number, nx: number, ny: number) => {
    let a = 0;
    while (a < 6 * pxPerMm && inkAt(cx + nx * (a + 0.5), cy + ny * (a + 0.5))) a += 0.5;
    let b = 0;
    while (b < 6 * pxPerMm && inkAt(cx - nx * (b + 0.5), cy - ny * (b + 0.5))) b += 0.5;
    return { width: a + b, mid: (a - b) / 2 };
  };
  for (let s = 0; s < 36; s++) {
    const ang = (s * Math.PI) / 36;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    let len = 0;
    for (const sign of [1, -1]) {
      let t = 0;
      while (t < 8 * pxPerMm && inkAt(mx + sign * ux * t, my + sign * uy * t)) t += 0.5;
      len += t;
    }
    if (len > bestLen) {
      bestLen = len;
      bestDir = ang;
    }
  }
  const ux = Math.cos(bestDir);
  const uy = Math.sin(bestDir);
  const nx = -uy;
  const ny = ux;
  // width profile along the axis
  const prof: { t: number; width: number; mid: number }[] = [];
  const L = 7 * pxPerMm;
  for (let t = -L; t <= L; t += 0.5) {
    const cx = mx + ux * t;
    const cy = my + uy * t;
    if (!inkAt(cx, cy)) {
      prof.push({ t, width: 0, mid: 0 });
      continue;
    }
    prof.push({ t, ...widthAt(cx, cy, nx, ny) });
  }
  const thick = stroke + 1.5;
  // contiguous thick run through the centre
  const c0 = prof.findIndex((p) => p.t >= 0);
  if (prof[c0].width < thick) return null;
  let i0 = c0;
  let i1 = c0;
  while (i0 > 0 && prof[i0 - 1].width >= thick) i0--;
  while (i1 < prof.length - 1 && prof[i1 + 1].width >= thick) i1++;
  const runLen = prof[i1].t - prof[i0].t;
  if (runLen < 0.6 * pxPerMm || runLen > 6 * pxPerMm) return null;
  // widest point = base; it should be at one end of the run
  let iMax = i0;
  for (let i = i0; i <= i1; i++) if (prof[i].width > prof[iMax].width) iMax = i;
  const wMax = prof[iMax].width;
  if (wMax > 2.5 * pxPerMm || wMax < stroke * 1.8) return null;
  const baseAtStart = iMax - i0 < i1 - iMax;
  const tipSide = baseAtStart ? 1 : -1;
  // taper check: width must shrink steadily towards the tip
  const q1 = prof[baseAtStart ? i0 + Math.floor((i1 - i0) * 0.25) : i1 - Math.floor((i1 - i0) * 0.25)].width;
  const q3 = prof[baseAtStart ? i0 + Math.floor((i1 - i0) * 0.75) : i1 - Math.floor((i1 - i0) * 0.75)].width;
  if (!(q1 > q3 + 0.8)) return null;
  // tip: where the taper reaches zero width (extrapolated past the thick run)
  const tBase = prof[iMax].t;
  const tEnd = baseAtStart ? prof[i1].t : prof[i0].t;
  const tTip = tEnd + tipSide * ((thick / Math.max(wMax, 1)) * Math.abs(tEnd - tBase) + 0.5);
  const mid = prof[iMax].mid;
  const bx = mx + ux * tBase + nx * mid;
  const by = my + uy * tBase + ny * mid;
  const len = Math.abs(tTip - tBase);
  if (len < wMax * 1.2) return null; // arrowheads are longer than wide
  return [
    { x: mx + ux * tTip, y: my + uy * tTip },
    { x: bx + nx * (wMax / 2), y: by + ny * (wMax / 2) },
    { x: bx - nx * (wMax / 2), y: by - ny * (wMax / 2) },
  ];
}

// ------------------------------------------------------------------ thinning

/** Zhang-Suen thinning, in place. */
function thin(ink: Uint8Array, w: number, h: number): void {
  let active: number[] = [];
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) ink[i] = 0;
    else active.push(i);
  }
  const del: number[] = [];
  for (let iter = 0; iter < 60 && active.length; iter++) {
    let changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (const i of active) {
        if (!ink[i]) continue;
        const p2 = ink[i - w], p3 = ink[i - w + 1], p4 = ink[i + 1], p5 = ink[i + w + 1];
        const p6 = ink[i + w], p7 = ink[i + w - 1], p8 = ink[i - 1], p9 = ink[i - w - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const a = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) + (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
        if (a !== 1) continue;
        if (pass === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) del.push(i);
      }
      for (const i of del) ink[i] = 0;
      if (del.length) changed = true;
    }
    if (!changed) break;
    active = active.filter((i) => ink[i]);
  }
}

// ------------------------------------------------------------------ tracing

const NB = (w: number) => [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];

function trace(sk: Uint8Array, w: number, h: number): { pts: P[]; closed: boolean }[] {
  const nb = NB(w);
  const order = [1, 3, 4, 6, 0, 2, 5, 7]; // 4-neighbours first
  const deg = new Uint8Array(sk.length);
  // Crossing number: separate runs of skeleton pixels around a pixel.
  // 1 = end point, 2 = on a line (even with 3 neighbours on staircases), 3+ = junction.
  const cn = new Uint8Array(sk.length);
  const ring = [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1]; // N, NE, E, SE, S, SW, W, NW
  for (let i = 0; i < sk.length; i++) {
    if (!sk[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
      sk[i] = 0;
      continue;
    }
    let c = 0;
    for (const o of nb) c += sk[i + o];
    deg[i] = c;
    let runs = 0;
    for (let k = 0; k < 8; k++) if (!sk[i + ring[k]] && sk[i + ring[(k + 1) % 8]]) runs++;
    cn[i] = c === 8 ? 0 : runs;
  }
  const isNode = (i: number) => cn[i] !== 2;
  const used = new Uint8Array(sk.length);
  const paths: { pts: P[]; closed: boolean }[] = [];
  const toP = (i: number): P => {
    const x = i % w;
    return { x: x + 0.5, y: (i - x) / w + 0.5 };
  };
  const walk = (start: number, first: number): number[] => {
    const seq = [start, first];
    used[first] = 1;
    let prev = start;
    let cur = first;
    while (!isNode(cur)) {
      let next = -1;
      for (const k of order) {
        const n = cur + nb[k];
        if (!sk[n] || n === prev) continue;
        if (isNode(n) && n !== start) {
          next = n;
          break;
        }
        if (!used[n]) {
          next = n;
          break;
        }
      }
      if (next < 0) break;
      if (!isNode(next)) used[next] = 1;
      seq.push(next);
      prev = cur;
      cur = next;
      if (cur === start) break;
    }
    return seq;
  };
  for (let i = 0; i < sk.length; i++) {
    if (!sk[i] || !isNode(i) || deg[i] === 0) continue;
    for (const o of nb) {
      const n = i + o;
      if (!sk[n] || used[n]) continue;
      if (isNode(n)) continue; // node-node links: junction clusters
      const seq = walk(i, n);
      if (seq.length >= 2) paths.push({ pts: seq.map(toP), closed: false });
    }
  }
  // loops without any end point or junction (circles, closed outlines)
  for (let i = 0; i < sk.length; i++) {
    if (!sk[i] || used[i] || isNode(i)) continue;
    used[i] = 1;
    let n = -1;
    for (const k of order) if (sk[i + nb[k]] && !used[i + nb[k]]) {
      n = i + nb[k];
      break;
    }
    if (n < 0) continue;
    const seq = walk(i, n);
    paths.push({ pts: seq.map(toP), closed: seq[seq.length - 1] === i || neighbours(seq[seq.length - 1], i, w) });
  }
  return paths;
}

function neighbours(a: number, b: number, w: number): boolean {
  const ax = a % w;
  const bx = b % w;
  return Math.abs(ax - bx) <= 1 && Math.abs((a - ax) / w - (b - bx) / w) <= 1;
}

// ------------------------------------------------------------------ fitting

function smooth(pts: P[], closed: boolean): P[] {
  if (pts.length < 5) return pts;
  const n = pts.length;
  return pts.map((p, i) => {
    if (!closed && (i < 2 || i > n - 3)) return p;
    let x = 0;
    let y = 0;
    for (let k = -2; k <= 2; k++) {
      const q = pts[(i + k + n) % n];
      x += q.x;
      y += q.y;
    }
    return { x: x / 5, y: y / 5 };
  });
}

function rdp(pts: P[], eps: number, s = 0, e = pts.length - 1, out: number[] = []): number[] {
  if (s === 0 && e === pts.length - 1) out.push(0);
  let maxD = 0;
  let idx = -1;
  const a = pts[s];
  const b = pts[e];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  for (let i = s + 1; i < e; i++) {
    // closed rings start and end at the same point: use the distance to that point
    const d = len < 1e-6 ? Math.hypot(pts[i].x - a.x, pts[i].y - a.y) : Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len;
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > eps && idx > 0) {
    rdp(pts, eps, s, idx, out);
    rdp(pts, eps, idx, e, out);
  } else out.push(e);
  return out;
}

interface CircleFit {
  c: P;
  r: number;
  rms: number;
  max: number;
}

function solve3(A: number[], b: number[]): number[] | null {
  const [a, bb, c, d, e, f, g, h, i] = A;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = [
    e * i - f * h, c * h - bb * i, bb * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, bb * g - a * h, a * e - bb * d,
  ].map((v) => v / det);
  return [0, 1, 2].map((r) => inv[r * 3] * b[0] + inv[r * 3 + 1] * b[1] + inv[r * 3 + 2] * b[2]);
}

/** Algebraic (Kasa) circle fit followed by a few Gauss-Newton steps. */
function fitCircle(pts: P[]): CircleFit | null {
  const n = pts.length;
  if (n < 5) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx;
    const v = p.y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const b1 = (suuu + suvv) / 2;
  const b2 = (svvv + svuu) / 2;
  let cx = (b1 * svv - b2 * suv) / det + mx;
  let cy = (b2 * suu - b1 * suv) / det + my;
  let r = 0;
  for (const p of pts) r += Math.hypot(p.x - cx, p.y - cy);
  r /= n;
  // geometric refinement (Gauss-Newton on residuals |p - c| - r)
  for (let it = 0; it < 6; it++) {
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const g = [0, 0, 0];
    for (const p of pts) {
      const d = Math.hypot(p.x - cx, p.y - cy) || 1e-9;
      const j = [(cx - p.x) / d, (cy - p.y) / d, -1];
      const res = d - r;
      for (let a = 0; a < 3; a++) {
        g[a] += j[a] * res;
        for (let b = 0; b < 3; b++) A[a * 3 + b] += j[a] * j[b];
      }
    }
    const delta = solve3(A, g.map((v) => -v));
    if (!delta) break;
    cx += delta[0];
    cy += delta[1];
    r += delta[2];
    if (Math.abs(delta[0]) + Math.abs(delta[1]) + Math.abs(delta[2]) < 1e-3) break;
  }
  let s2 = 0;
  let max = 0;
  for (const p of pts) {
    const e = Math.abs(Math.hypot(p.x - cx, p.y - cy) - r);
    s2 += e * e;
    if (e > max) max = e;
  }
  return { c: { x: cx, y: cy }, r, rms: Math.sqrt(s2 / n), max };
}

/** Signed sweep from a to b through the path points (image angles). */
function sweepOf(c: P, pts: P[]): { a0: number; sweep: number } {
  const a0 = Math.atan2(pts[0].y - c.y, pts[0].x - c.x);
  let total = 0;
  let prev = a0;
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(pts[i].y - c.y, pts[i].x - c.x);
    let d = a - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    prev = a;
  }
  return { a0, sweep: total };
}

function fitLine(pts: P[]): { a: P; b: P; rms: number } {
  const n = pts.length;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const proj = (p: P) => (p.x - mx) * ux + (p.y - my) * uy;
  const t0 = proj(pts[0]);
  const t1 = proj(pts[n - 1]);
  let s2 = 0;
  for (const p of pts) s2 += ((p.x - mx) * -uy + (p.y - my) * ux) ** 2;
  return { a: { x: mx + ux * t0, y: my + uy * t0 }, b: { x: mx + ux * t1, y: my + uy * t1 }, rms: Math.sqrt(s2 / n) };
}

interface Piece {
  kind: 'line' | 'arc' | 'circle';
  pts: P[];
  line?: { a: P; b: P };
  circle?: CircleFit;
  a0?: number;
  sweep?: number;
}

function fitPath(raw: P[], closed: boolean, eps: number, pxPerMm: number): Piece[] {
  const pts = smooth(raw, closed);
  const minArcR = 0.4 * pxPerMm;
  const maxArcR = 800 * pxPerMm;
  // Tolerances in pixels: scanned edges wobble by about a pixel whatever the radius.
  const good = (f: CircleFit | null) =>
    !!f && f.r > minArcR && f.r < maxArcR && f.rms < Math.max(0.7, Math.min(2, f.r * 0.004)) && f.max < Math.max(2, Math.min(5, f.r * 0.012));
  /** An arc only wins over a straight line when it clearly fits better. */
  const arcBeatsLine = (seg: P[], f: CircleFit) => {
    const lf = fitLine(seg);
    return lf.rms > 1.0 && f.rms < lf.rms * 0.5;
  };

  // closed outline with a few straight sides (hex head, square, triangle) -> polygon, not circle
  if (closed && raw.length >= 12) {
    const ring = [...raw, raw[0]];
    const eps2 = Math.max(1.5, eps);
    // a ring starts and ends at the same point: simplify the two halves separately
    let far = 0;
    for (let k = 1; k < raw.length; k++) if (Math.hypot(raw[k].x - raw[0].x, raw[k].y - raw[0].y) > Math.hypot(raw[far].x - raw[0].x, raw[far].y - raw[0].y)) far = k;
    const h1 = rdp(ring.slice(0, far + 1), eps2);
    const h2 = rdp(ring.slice(far), eps2).map((i) => i + far);
    let v = [...h1, ...h2.slice(1)];
    // blurred corners add short extra chords: drop vertices where the outline hardly turns
    for (let changed = true; changed && v.length > 4; ) {
      changed = false;
      for (let k = 1; k < v.length - 1; k++) {
        const a = ring[v[k - 1]];
        const b = ring[v[k]];
        const c = ring[v[k + 1]];
        const t1 = Math.atan2(b.y - a.y, b.x - a.x);
        const t2 = Math.atan2(c.y - b.y, c.x - b.x);
        let d = Math.abs(t2 - t1);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d < 0.3) {
          v = [...v.slice(0, k), ...v.slice(k + 1)];
          changed = true;
          break;
        }
      }
    }
    const nSides = v.length - 1;
    if (nSides >= 3 && nSides <= 8) {
      let straight = true;
      for (let k = 0; k < nSides && straight; k++) {
        const a = ring[v[k]];
        const b = ring[v[k + 1]];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        if (L < 4) straight = false;
        for (let j = v[k] + 1; j < v[k + 1] && straight; j++) {
          const p = ring[j];
          // corners are rounded by the pen width, so allow more deviation near the ends
          const tPos = Math.min(j - v[k], v[k + 1] - j) / Math.max(1, v[k + 1] - v[k]);
          const tol = tPos < 0.2 ? Math.max(2, eps2 * 1.2) : Math.max(1.2, eps2 * 0.75);
          if (Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / L > tol) straight = false;
        }
      }
      if (straight) {
        return Array.from({ length: nSides }, (_, k) => ({ kind: 'line' as const, pts: ring.slice(v[k], v[k + 1] + 1), line: { a: ring[v[k]], b: ring[v[k + 1]] } }));
      }
    }
  }
  // whole path one circle / arc?
  if (pts.length >= 8) {
    const f = fitCircle(pts);
    if (good(f)) {
      const { a0, sweep } = sweepOf(f!.c, pts);
      if (closed && Math.abs(Math.abs(sweep) - 2 * Math.PI) < 0.6) return [{ kind: 'circle', pts, circle: f! }];
      if (Math.abs(sweep) > 0.25 && Math.abs(sweep) < 2 * Math.PI - 0.3 && arcBeatsLine(pts, f!)) return [{ kind: 'arc', pts, circle: f!, a0, sweep }];
    }
  }
  if (closed) pts.push(pts[0]);
  const idx = rdp(pts, eps);
  // group consecutive short chords that turn the same way into arcs
  const pieces: Piece[] = [];
  let i = 0;
  while (i < idx.length - 1) {
    let j = i + 1;
    let bestArc: Piece | null = null;
    // try to extend an arc over chords i..j
    for (let k = i + 2; k < idx.length; k++) {
      const seg = pts.slice(idx[i], idx[k] + 1);
      if (seg.length < 8) continue;
      const f = fitCircle(seg);
      if (!good(f)) break;
      const { a0, sweep } = sweepOf(f!.c, seg);
      if (Math.abs(sweep) < 0.3 || !arcBeatsLine(seg, f!)) continue;
      bestArc = { kind: 'arc', pts: seg, circle: f!, a0, sweep };
      j = k;
    }
    if (bestArc) {
      pieces.push(bestArc);
      i = j;
      continue;
    }
    const seg = pts.slice(idx[i], idx[i + 1] + 1);
    pieces.push({ kind: 'line', pts: seg, line: { a: pts[idx[i]], b: pts[idx[i + 1]] } });
    i += 1;
  }
  return pieces;
}

// ------------------------------------------------------------------ colours

export function snapColor(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 55) return '#000000';
  // boost to a print-like colour so faded scans keep a clear hue
  const k = 255 / Math.max(1, max);
  const q = (v: number) => Math.min(255, Math.round(((v - min * 0.6) * k) / 16) * 16);
  return '#' + [q(r), q(g), q(b)].map((v) => Math.max(0, v).toString(16).padStart(2, '0')).join('');
}

/** Same ink: both black, or hues close to each other (faint dots of a coloured line vary). */
function colorClose(a: string, b: string): boolean {
  if (a === b) return true;
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) < 160;
}

function colorAlong(img: RGBAImage, pts: P[]): string {
  let r = 0, g = 0, b = 0, n = 0;
  const step = Math.max(1, Math.floor(pts.length / 40));
  for (let i = 0; i < pts.length; i += step) {
    const x = Math.floor(pts[i].x);
    const y = Math.floor(pts[i].y);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const o = (y * img.width + x) * 4;
    r += img.data[o];
    g += img.data[o + 1];
    b += img.data[o + 2];
    n++;
  }
  return n ? snapColor(r / n, g / n, b / n) : '#000000';
}

function widthAlong(dist: Float32Array, w: number, pts: P[]): number {
  const vals: number[] = [];
  const step = Math.max(1, Math.floor(pts.length / 30));
  for (let i = 0; i < pts.length; i += step) vals.push(dist[Math.floor(pts[i].y) * w + Math.floor(pts[i].x)] || 0);
  vals.sort((a, b) => a - b);
  return 2 * (vals[Math.floor(vals.length / 2)] ?? 0.5) - 1;
}

// ------------------------------------------------------------------ clean-up

const lineAngle = (l: VLine) => Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x);
const llen = (l: VLine) => Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);

/** Joins collinear lines separated by small gaps; repeated gaps make a dashed line. */
function joinCollinear(lines: VLine[], maxGap: number, tolPerp: number): VLine[] {
  const items = lines.map((l) => ({ l, dead: false, pieces: 1, gaps: [] as number[], dashes: [llen(l)] }));
  // sort by direction, then try to join neighbours
  for (let pass = 0; pass < 3; pass++) {
    let merged = false;
    const live = items.filter((it) => !it.dead);
    // bucket by quantised angle (mod pi)
    const buckets = new Map<number, typeof live>();
    for (const it of live) {
      let a = lineAngle(it.l);
      if (a < 0) a += Math.PI;
      if (a >= Math.PI) a -= Math.PI;
      const k = Math.round(a / 0.02);
      for (const kk of [k - 1, k, k + 1]) {
        const key = ((kk % 158) + 158) % 158;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = []));
        if (kk === k) b.push(it);
      }
    }
    for (const it of live) {
      if (it.dead) continue;
      let a = lineAngle(it.l);
      if (a < 0) a += Math.PI;
      const k = Math.round(a / 0.02);
      const cands = [k - 1, k, k + 1].flatMap((kk) => buckets.get(((kk % 158) + 158) % 158) ?? []);
      for (const ot of cands) {
        if (ot === it || ot.dead || it.dead) continue;
        const A = it.l;
        const B = ot.l;
        const ux = Math.cos(lineAngle(A));
        const uy = Math.sin(lineAngle(A));
        const perp = (p: P) => Math.abs((p.x - A.a.x) * -uy + (p.y - A.a.y) * ux);
        if (perp(B.a) > tolPerp || perp(B.b) > tolPerp) continue;
        let da = Math.abs(lineAngle(A) - lineAngle(B)) % Math.PI;
        if (da > Math.PI / 2) da = Math.PI - da;
        if (da > 0.03) continue;
        const t = (p: P) => (p.x - A.a.x) * ux + (p.y - A.a.y) * uy;
        const a0 = Math.min(t(A.a), t(A.b));
        const a1 = Math.max(t(A.a), t(A.b));
        const b0 = Math.min(t(B.a), t(B.b));
        const b1 = Math.max(t(B.a), t(B.b));
        const gap = Math.max(b0 - a1, a0 - b1);
        if (gap > maxGap) continue;
        const lo = Math.min(a0, b0);
        const hi = Math.max(a1, b1);
        const ox = A.a.x - ux * t(A.a);
        const oy = A.a.y - uy * t(A.a);
        it.l = { ...A, a: { x: ox + ux * lo, y: oy + uy * lo }, b: { x: ox + ux * hi, y: oy + uy * hi }, width: Math.max(A.width, B.width) };
        if (gap > 0.5) {
          it.gaps.push(gap, ...ot.gaps);
          it.dashes.push(...ot.dashes);
        }
        it.pieces += ot.pieces;
        ot.dead = true;
        merged = true;
      }
    }
    if (!merged) break;
  }
  return items
    .filter((it) => !it.dead)
    .map((it) => {
      if (it.pieces >= 4 && it.gaps.length >= 3) {
        const g = [...it.gaps].sort((a, b) => a - b)[Math.floor(it.gaps.length / 2)];
        const d = [...it.dashes].sort((a, b) => a - b);
        const long = d[Math.floor(d.length * 0.75)];
        const short = d[Math.floor(d.length * 0.15)];
        const dash = long > short * 2.5 && short < g * 2 ? [long, g, short, g] : [long, g];
        return { ...it.l, dash };
      }
      return it.l;
    });
}

/**
 * Missing angle up to which an arc is really a circle that another line
 * crossed (a gap of ~10 px, at most 35°).
 */
function nearFull(r: number): number {
  return Math.max(0.12, Math.min(0.6, 10 / Math.max(1, r)));
}

/** Joins arc pieces that lie on the same circle (split at junctions). */
function joinArcs(arcs: VArc[], circles: VCircle[]): { arcs: VArc[]; circles: VCircle[] } {
  const used = new Set<VArc>();
  const outArcs: VArc[] = [];
  for (const a of arcs) {
    if (used.has(a)) continue;
    const group = arcs.filter((b) => !used.has(b) && Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y) < Math.max(1.5, a.r * 0.02) && Math.abs(a.r - b.r) < Math.max(1.2, a.r * 0.02));
    group.forEach((g) => used.add(g));
    if (group.length === 1) {
      if (Math.abs(a.sweep) > 2 * Math.PI - nearFull(a.r)) circles.push({ kind: 'circle', c: a.c, r: a.r, color: a.color, width: a.width });
      else outArcs.push(a);
      continue;
    }
    // union of angular intervals on [0, 2pi)
    const iv = group.map((g) => {
      const s = g.sweep >= 0 ? g.a0 : g.a0 + g.sweep;
      const st = ((s % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return [st, st + Math.abs(g.sweep)] as [number, number];
    });
    iv.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    // small gaps come from junctions where another line crossed the circle
    const gapTol = Math.max(0.08, 6 / Math.max(1, a.r));
    for (const v of iv) {
      const last = merged[merged.length - 1];
      if (last && v[0] <= last[1] + gapTol) last[1] = Math.max(last[1], v[1]);
      else merged.push([...v]);
    }
    // wrap-around
    if (merged.length > 1 && merged[merged.length - 1][1] >= 2 * Math.PI + merged[0][0] - gapTol) {
      merged[0][0] = merged[merged.length - 1][0] - 2 * Math.PI;
      merged.pop();
    }
    const c = { x: group.reduce((s, g) => s + g.c.x, 0) / group.length, y: group.reduce((s, g) => s + g.c.y, 0) / group.length };
    const r = group.reduce((s, g) => s + g.r, 0) / group.length;
    const base = group[0];
    // many evenly spread pieces all round = a dashed / centre-line circle
    if (merged.length >= 6) {
      const gaps = merged.map((m, k) => (k + 1 < merged.length ? merged[k + 1][0] : merged[0][0] + 2 * Math.PI) - m[1]);
      const lens = merged.map((m) => m[1] - m[0]);
      const maxGap = Math.max(...gaps);
      if (maxGap < 0.6 && lens.reduce((s, v) => s + v, 0) > Math.PI * 0.5) {
        const med = (v: number[]) => [...v].sort((p, q) => p - q)[Math.floor(v.length / 2)];
        const d = [...lens].sort((p, q) => p - q);
        const long = d[Math.floor(d.length * 0.75)] * r;
        const short = d[Math.floor(d.length * 0.15)] * r;
        const g = med(gaps) * r;
        circles.push({ kind: 'circle', c, r, color: base.color, width: base.width, dash: long > short * 2.5 ? [long, g, short, g] : [long, g] });
        continue;
      }
    }
    for (const [s, e] of merged) {
      if (e - s > 2 * Math.PI - nearFull(r)) circles.push({ kind: 'circle', c, r, color: base.color, width: base.width });
      else outArcs.push({ ...base, c, r, a0: s, sweep: e - s });
    }
  }
  return { arcs: outArcs, circles };
}

function snapEndpoints(lines: VLine[], arcs: VArc[], tol: number): void {
  const ends: { p: P; set: (q: P) => void }[] = [];
  for (const l of lines) {
    ends.push({ p: l.a, set: (q) => (l.a = q) }, { p: l.b, set: (q) => (l.b = q) });
  }
  for (const a of arcs) {
    const p0 = { x: a.c.x + a.r * Math.cos(a.a0), y: a.c.y + a.r * Math.sin(a.a0) };
    const p1 = { x: a.c.x + a.r * Math.cos(a.a0 + a.sweep), y: a.c.y + a.r * Math.sin(a.a0 + a.sweep) };
    ends.push({ p: p0, set: () => undefined }, { p: p1, set: () => undefined });
  }
  const cell = tol * 2;
  const grid = new Map<string, number[]>();
  ends.forEach((e, i) => {
    const k = `${Math.floor(e.p.x / cell)},${Math.floor(e.p.y / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  const done = new Uint8Array(ends.length);
  ends.forEach((e, i) => {
    if (done[i]) return;
    const gx = Math.floor(e.p.x / cell);
    const gy = Math.floor(e.p.y / cell);
    const cluster: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
      if (!done[j] && Math.hypot(ends[j].p.x - e.p.x, ends[j].p.y - e.p.y) <= tol) cluster.push(j);
    }
    if (cluster.length < 2) return;
    // arc ends are exact; snap lines to them, else to the average
    const arcEnd = cluster.find((j) => j >= lines.length * 2);
    const target = arcEnd !== undefined ? ends[arcEnd].p : { x: cluster.reduce((s, j) => s + ends[j].p.x, 0) / cluster.length, y: cluster.reduce((s, j) => s + ends[j].p.y, 0) / cluster.length };
    for (const j of cluster) {
      done[j] = 1;
      ends[j].set({ ...target });
    }
  });
}

/**
 * Dashed circles and arcs (centre lines, hidden lines) trace as chains of short
 * pieces. Chains of 6+ short pieces that lie on one circle become one dashed
 * circle or arc. Returns the remaining lines.
 */
function dashedCurves(lines: VLine[], arcs: VArc[], circles: VCircle[], pxPerMm: number): VLine[] {
  const maxPiece = 6 * pxPerMm;
  // dash-dot lines: the dots are too small to trace, so allow dash + dot + 2 gaps
  const maxGap = 4 * pxPerMm;
  const shortIdx = lines.map((l, i) => (llen(l) <= maxPiece ? i : -1)).filter((i) => i >= 0);
  const parent = new Map<number, number>(shortIdx.map((i) => [i, i]));
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(i, r);
    return r;
  };
  const cell = maxGap;
  const grid = new Map<string, number[]>();
  for (const i of shortIdx) {
    for (const p of [lines[i].a, lines[i].b]) {
      const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    }
  }
  for (const i of shortIdx) {
    for (const p of [lines[i].a, lines[i].b]) {
      const gx = Math.floor(p.x / cell);
      const gy = Math.floor(p.y / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
        if (j === i || !colorClose(lines[j].color, lines[i].color)) continue;
        const q = lines[j];
        const d = Math.min(Math.hypot(q.a.x - p.x, q.a.y - p.y), Math.hypot(q.b.x - p.x, q.b.y - p.y));
        if (d > maxGap) continue;
        let da = Math.abs(lineAngle(lines[i]) - lineAngle(q)) % Math.PI;
        if (da > Math.PI / 2) da = Math.PI - da;
        if (da < 0.6) parent.set(find(i), find(j));
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (const i of shortIdx) (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(i);
  const remove = new Set<number>();
  const piecePts = (i: number): P[] => [lines[i].a, lines[i].b, { x: (lines[i].a.x + lines[i].b.x) / 2, y: (lines[i].a.y + lines[i].b.y) / 2 }];
  const endGap = (i: number, g: number[]) => {
    let best = Infinity;
    for (const j of g) {
      if (j === i) continue;
      for (const p of [lines[i].a, lines[i].b]) for (const q of [lines[j].a, lines[j].b]) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    }
    return best;
  };
  for (const g0 of groups.values()) {
    if (g0.length < 6) continue;
    // dashes have gaps; touching pieces are a polygon (hex head, polyline)
    const gaps0 = g0.map((i) => endGap(i, g0)).sort((a, b) => a - b);
    if (gaps0[Math.floor(gaps0.length / 2)] < Math.max(2.5, 0.3 * pxPerMm)) continue;
    // robust fit: drop pieces far from the first fit (a crossing line, a neighbour), fit again
    let g = g0;
    let f = fitCircle(g.flatMap(piecePts));
    for (let round = 0; round < 3 && f; round++) {
      const res = g.map((i) => piecePts(i).reduce((s, p) => s + Math.abs(Math.hypot(p.x - f!.c.x, p.y - f!.c.y) - f!.r), 0) / 3);
      const sorted = [...res].sort((a, b) => a - b);
      const lim = Math.max(1.5, sorted[Math.floor(sorted.length / 2)] * 3);
      const keep = g.filter((_, k) => res[k] <= lim);
      if (keep.length === g.length || keep.length < 6) break;
      g = keep;
      f = fitCircle(g.flatMap(piecePts));
    }
    const pts = g.flatMap(piecePts);
    if (g.length < 6 || !f || f.r < 2 * pxPerMm || f.r > 300 * pxPerMm || f.rms > Math.max(1.2, f.r * 0.01)) continue;
    // nearly straight chains are dashed lines, handled by joinCollinear
    const lf = fitLine(pts);
    if (lf.rms < 1.2) continue;
    // absorb other short pieces on the same circle (chains broken by holes or crossings)
    const tol = Math.max(2, f.r * 0.012);
    const inG = new Set(g);
    for (const i of shortIdx) {
      if (inG.has(i) || remove.has(i) || !colorClose(lines[i].color, lines[g[0]].color)) continue;
      if (piecePts(i).every((p) => Math.abs(Math.hypot(p.x - f!.c.x, p.y - f!.c.y) - f!.r) <= tol)) {
        g.push(i);
        inG.add(i);
      }
    }
    const angs = g.map((i) => {
      const m = { x: (lines[i].a.x + lines[i].b.x) / 2, y: (lines[i].a.y + lines[i].b.y) / 2 };
      return ((Math.atan2(m.y - f.c.y, m.x - f.c.x) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    }).sort((a, b) => a - b);
    const gaps = angs.map((a, k) => (k + 1 < angs.length ? angs[k + 1] : angs[0] + 2 * Math.PI) - a);
    const maxG = Math.max(...gaps);
    if (2 * Math.PI - maxG < Math.PI / 3) continue; // less than 60° of a circle: not convincing
    const lens = g.map((i) => llen(lines[i])).sort((a, b) => a - b);
    const long = lens[Math.floor(lens.length * 0.75)];
    const short = lens[Math.floor(lens.length * 0.15)];
    const pieceGap = Math.max(0.5, (2 * Math.PI * f.r) / g.length - (lens.reduce((s, v) => s + v, 0) / lens.length));
    const dash = long > short * 2.5 ? [long, pieceGap / 2, short, pieceGap / 2] : [long, pieceGap];
    const base = lines[g[0]];
    // gaps up to ~ a bolt hole plus dash spacing still count as a full circle
    if (maxG * f.r < 9 * pxPerMm) circles.push({ kind: 'circle', c: f.c, r: f.r, color: base.color, width: base.width, dash });
    else {
      const k = gaps.indexOf(maxG);
      const start = angs[(k + 1) % angs.length];
      const sweep = 2 * Math.PI - maxG;
      arcs.push({ kind: 'arc', c: f.c, r: f.r, a0: start, sweep, color: base.color, width: base.width, dash });
    }
    g.forEach((i) => remove.add(i));
  }
  // arc pieces lying on a dashed circle found here belong to it
  for (let k = arcs.length - 1; k >= 0; k--) {
    const a = arcs[k];
    if (circles.some((c) => c.dash && Math.hypot(c.c.x - a.c.x, c.c.y - a.c.y) < Math.max(2, c.r * 0.015) && Math.abs(c.r - a.r) < Math.max(2, c.r * 0.015))) arcs.splice(k, 1);
  }
  return lines.filter((_, i) => !remove.has(i));
}

/**
 * On blurry or low-resolution scans a big circle can trace as a chain of
 * straight chords. Chains of 6+ touching chords that turn gently the same
 * way and lie on one circle become a circle or an arc.
 */
function chordsToCurves(lines: VLine[], arcs: VArc[], circles: VCircle[], pxPerMm: number): VLine[] {
  const tol = Math.max(2.5, 0.25 * pxPerMm);
  const reach = tol * 1.5;
  const ends = new Map<string, number[]>();
  const key = (p: P) => `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`;
  const near = (p: P) => {
    const out: number[] = [];
    const gx = Math.round(p.x / tol);
    const gy = Math.round(p.y / tol);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(ends.get(`${gx + dx},${gy + dy}`) ?? []));
    return out;
  };
  lines.forEach((l, i) => {
    for (const p of [l.a, l.b]) (ends.get(key(p)) ?? ends.set(key(p), []).get(key(p))!).push(i);
  });
  const used = new Set<number>();
  const remove = new Set<number>();
  const turn = (a: VLine, b: VLine) => {
    let d = Math.abs(lineAngle(a) - lineAngle(b)) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d;
  };
  for (let s = 0; s < lines.length; s++) {
    if (used.has(s) || llen(lines[s]) > 25 * pxPerMm) continue;
    // grow a chain in both directions through gently turning neighbours
    const chain = [s];
    used.add(s);
    for (const dir of [0, 1]) {
      let cur = s;
      let tip = dir === 0 ? lines[s].a : lines[s].b;
      for (let guard = 0; guard < 400; guard++) {
        const cand = near(tip).filter((j) => !used.has(j) && colorClose(lines[j].color, lines[cur].color) && turn(lines[cur], lines[j]) < 0.5);
        const j = cand.find((k) => Math.min(Math.hypot(lines[k].a.x - tip.x, lines[k].a.y - tip.y), Math.hypot(lines[k].b.x - tip.x, lines[k].b.y - tip.y)) <= reach);
        if (j === undefined) break;
        used.add(j);
        if (dir === 0) chain.unshift(j);
        else chain.push(j);
        const l = lines[j];
        tip = Math.hypot(l.a.x - tip.x, l.a.y - tip.y) < Math.hypot(l.b.x - tip.x, l.b.y - tip.y) ? l.b : l.a;
        cur = j;
      }
    }
    if (chain.length < 6) continue;
    const pts = chain.flatMap((i) => [lines[i].a, { x: (lines[i].a.x + lines[i].b.x) / 2, y: (lines[i].a.y + lines[i].b.y) / 2 }, lines[i].b]);
    const f = fitCircle(pts);
    if (!f || f.r < 3 * pxPerMm || f.r > 300 * pxPerMm || f.rms > Math.max(1.5, f.r * 0.008)) continue;
    if (fitLine(pts).rms < 2) continue; // straight
    const { a0, sweep } = sweepOf(f.c, pts);
    const base = lines[chain[0]];
    if (Math.abs(sweep) > 2 * Math.PI - nearFull(f.r)) circles.push({ kind: 'circle', c: f.c, r: f.r, color: base.color, width: base.width });
    else if (Math.abs(sweep) > 0.5) arcs.push({ kind: 'arc', c: f.c, r: f.r, a0, sweep, color: base.color, width: base.width });
    else continue;
    chain.forEach((i) => remove.add(i));
  }
  return lines.filter((_, i) => !remove.has(i));
}

/** Median deviation of long near-axis lines from horizontal/vertical. */
function estimateSkew(lines: VLine[], minLen: number): number {
  const devs: number[] = [];
  for (const l of lines) {
    if (llen(l) < minLen) continue;
    let a = lineAngle(l);
    // fold to (-pi/4, pi/4]
    while (a > Math.PI / 4) a -= Math.PI / 2;
    while (a <= -Math.PI / 4) a += Math.PI / 2;
    if (Math.abs(a) < 0.035) for (let k = 0; k < Math.ceil(llen(l) / minLen); k++) devs.push(a);
  }
  if (devs.length < 3) return 0;
  devs.sort((a, b) => a - b);
  return devs[Math.floor(devs.length / 2)];
}

// ------------------------------------------------------------------ main

export function vectorize(img: RGBAImage, opts: VectorizeOptions): VectorizeResult {
  const { width: w, height: h } = img;
  const mm = opts.pxPerMm;
  opts.onProgress?.(0.05, 'Separating line work from paper');
  const ink = inkMask(img);
  for (const box of opts.textBoxes) fillPolygon(ink, w, h, box, 0);
  despeckle(ink, w, h, Math.max(4, Math.round((0.25 * mm) ** 2)));
  const stroke = strokeWidthOf(ink, w, h);

  opts.onProgress?.(0.2, 'Finding arrowheads');
  const dist = distanceTransform(ink, w, h);
  const solids = findArrowheads(img, ink, dist, stroke, mm);

  opts.onProgress?.(0.35, 'Thinning lines');
  opts.debug?.('ink', ink);
  const sk = ink.slice();
  thin(sk, w, h);
  opts.debug?.('skeleton', sk);

  opts.onProgress?.(0.6, 'Tracing lines');
  const paths = trace(sk, w, h);

  opts.onProgress?.(0.75, 'Fitting lines, arcs and circles');
  const lines: VLine[] = [];
  let arcs: VArc[] = [];
  let circles: VCircle[] = [];
  const minLen = Math.max(3, 0.5 * mm);
  const eps = Math.max(1.1, stroke * 0.55);
  for (const p of paths) {
    if (p.pts.length < 2) continue;
    if (p.pts.length < 4) {
      // tiny piece: a short dash of a dotted line (kept for dashed-curve detection)
      const a = p.pts[0];
      const b = p.pts[p.pts.length - 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) >= 2) lines.push({ kind: 'line', a, b, color: colorAlong(img, p.pts), width: Math.max(1, widthAlong(dist, w, p.pts)) });
      continue;
    }
    for (const piece of fitPath(p.pts, p.closed, eps, mm)) {
      const color = colorAlong(img, piece.pts);
      const width = Math.max(1, widthAlong(dist, w, piece.pts));
      if (piece.kind === 'circle') circles.push({ kind: 'circle', c: piece.circle!.c, r: piece.circle!.r, color, width });
      else if (piece.kind === 'arc') arcs.push({ kind: 'arc', c: piece.circle!.c, r: piece.circle!.r, a0: piece.a0!, sweep: piece.sweep!, color, width });
      else {
        const l: VLine = { kind: 'line', a: piece.line!.a, b: piece.line!.b, color, width };
        lines.push(l);
      }
    }
  }

  opts.onProgress?.(0.88, 'Cleaning up');
  const unchorded = chordsToCurves(lines, arcs, circles, mm);
  ({ arcs, circles } = joinArcs(arcs, circles));
  const rest = dashedCurves(unchorded, arcs, circles, mm);
  const joined = joinCollinear(rest, Math.max(stroke * 3, 1.6 * mm), Math.max(1.5, stroke * 0.8));
  const kept = joined.filter((l) => llen(l) >= minLen);
  snapEndpoints(kept, arcs, Math.max(2, stroke * 1.2));
  const skew = estimateSkew(kept, 20 * mm);
  arcs = arcs.filter((a) => a.r * Math.abs(a.sweep) >= minLen);
  // concentric duplicates (both edges of a thick circle) -> keep one
  const uniq: VCircle[] = [];
  for (const c of circles) if (!uniq.some((u) => Math.hypot(u.c.x - c.c.x, u.c.y - c.c.y) < 1.5 && Math.abs(u.r - c.r) < Math.max(1.5, stroke))) uniq.push(c);
  opts.onProgress?.(1, 'Done');
  return { entities: [...kept, ...arcs, ...uniq, ...solids], strokeWidth: stroke, skew };
}
