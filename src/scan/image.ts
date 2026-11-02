// Small raster helpers shared by OCR and vectorisation (no canvas needed, so
// they run in a Web Worker and in Node tests).

export interface RGBAImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface P {
  x: number;
  y: number;
}

/** Bilinear sample of channel c at (x, y); outside the image is white. */
export function sample(img: RGBAImage, x: number, y: number, c: number): number {
  const { width: w, height: h, data } = img;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 255;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = data[(y0 * w + x0) * 4 + c];
  const b = data[(y0 * w + x1) * 4 + c];
  const d = data[(y1 * w + x0) * 4 + c];
  const e = data[(y1 * w + x1) * 4 + c];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
}

export function luminance(img: RGBAImage): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) out[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  return out;
}

/** Otsu threshold of a luminance histogram, clamped to a sensible range for drawings. */
export function otsu(lum: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i++) hist[lum[i]]++;
  const total = lum.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return Math.max(110, Math.min(200, thr));
}

/** Convex hull (monotone chain), counter-clockwise in image coordinates. */
export function convexHull(pts: P[]): P[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: P[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: P[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export interface RotRect {
  c: P;
  /** Unit vector of the long side. */
  u: P;
  /** Length of the long side and the short side. */
  long: number;
  short: number;
}

/** Minimum-area rectangle around a point set (rotating calipers over the hull). */
export function minAreaRect(pts: P[]): RotRect {
  const hull = convexHull(pts);
  if (hull.length === 1) return { c: hull[0], u: { x: 1, y: 0 }, long: 1, short: 1 };
  let best: RotRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const q of hull) {
      const pu = q.x * ux + q.y * uy;
      const pv = -q.x * uy + q.y * ux;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    if (w * h < bestArea) {
      bestArea = w * h;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      const c = { x: cu * ux - cv * uy, y: cu * uy + cv * ux };
      best = w >= h ? { c, u: { x: ux, y: uy }, long: w, short: h } : { c, u: { x: -uy, y: ux }, long: h, short: w };
    }
  }
  return best ?? { c: hull[0], u: { x: 1, y: 0 }, long: 1, short: 1 };
}

/**
 * Crops a rotated rectangle into an upright strip.
 * u = reading direction, d = "down" direction of the glyphs (image coordinates).
 */
export function cropRotated(img: RGBAImage, c: P, u: P, d: P, len: number, hgt: number, outW: number, outH: number): RGBAImage {
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sw = len / outW;
  const sh = hgt / outH;
  for (let j = 0; j < outH; j++) {
    for (let i = 0; i < outW; i++) {
      const a = (i + 0.5 - outW / 2) * sw;
      const b = (j + 0.5 - outH / 2) * sh;
      const x = c.x + u.x * a + d.x * b;
      const y = c.y + u.y * a + d.y * b;
      const o = (j * outW + i) * 4;
      out[o] = sample(img, x, y, 0);
      out[o + 1] = sample(img, x, y, 1);
      out[o + 2] = sample(img, x, y, 2);
      out[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data: out };
}
