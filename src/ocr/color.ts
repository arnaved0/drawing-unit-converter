import type { OcrLine } from './engine';
import type { RGBAImage } from './image';

/** Ink colour of a line: the average of its darkest pixels. Near-greys count as black. */
export function lineColor(img: RGBAImage, l: OcrLine): [number, number, number] {
  const d = { x: -l.u.y, y: l.u.x };
  const a = l.len * 0.4;
  const b = l.hgt * 0.4;
  const xs = [-1, 1].flatMap((s) => [-1, 1].map((t) => l.c.x + l.u.x * a * s + d.x * b * t));
  const ys = [-1, 1].flatMap((s) => [-1, 1].map((t) => l.c.y + l.u.y * a * s + d.y * b * t));
  const vals: number[][] = [];
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(img.height, Math.ceil(Math.max(...ys))); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(img.width, Math.ceil(Math.max(...xs))); x++) {
      const o = (y * img.width + x) * 4;
      vals.push([img.data[o] + img.data[o + 1] + img.data[o + 2], img.data[o], img.data[o + 1], img.data[o + 2]]);
    }
  }
  if (!vals.length) return [0, 0, 0];
  vals.sort((p, q) => p[0] - q[0]);
  const top = vals.slice(0, Math.max(1, Math.floor(vals.length * 0.06)));
  const avg = (k: number) => top.reduce((s, v) => s + v[k], 0) / top.length;
  const [r, g, bl] = [avg(1), avg(2), avg(3)];
  const max = Math.max(r, g, bl);
  const min = Math.min(r, g, bl);
  if (max - min < 45) return [0, 0, 0];
  // undo anti-aliasing towards white: stretch to a print-like colour
  const k = 1 / Math.max(1, max);
  const q = (v: number) => Math.max(0, Math.min(1, Math.round(((v - min * 0.6) * k) * 16) / 16));
  return [q(r), q(g), q(bl)];
}
