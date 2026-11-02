// Scanned page -> drawing model: OCR text becomes text entities (so the
// normal dimension detection, conversion and export work), traced line work
// becomes lines, arcs, circles and arrowheads. Runs in a Web Worker in the
// browser and directly in tests.

import { guessDimensionUnit } from '../dimensions';
import { drawingBounds } from '../geom';
import { countEntities, emptyStats, newId, type Entity, type Pt, type Style, type TextEntity } from '../model';
import type { P, RGBAImage } from './image';
import { runOcr, type OcrLine, type OcrModels } from './ocr';
import { vectorize, type VEntity } from './vectorize';

export interface ScanResult {
  entities: Entity[];
  ocrLines: number;
  traced: number;
  skewDeg: number;
  detectedUnit: ReturnType<typeof guessDimensionUnit>;
}

export interface ScanOptions {
  /** Pixels per millimetre of the rendered page. */
  pxPerMm: number;
  /** Page height in mm (image y=0 is the top of the page). */
  pageHeightMm: number;
  onProgress?: (fraction: number, label: string) => void;
}

/** Text em size per OCR box height (PP-OCR boxes are padded around the glyphs). */
const EM_PER_BOX = 0.66;
/** Text advance per OCR box length. */
const WIDTH_PER_BOX = 0.94;

export function ocrBoxCorners(l: OcrLine, grow = 1): P[] {
  const d = { x: -l.u.y, y: l.u.x };
  const a = (l.len / 2) * grow;
  const b = (l.hgt / 2) * grow;
  return [
    { x: l.c.x - l.u.x * a - d.x * b, y: l.c.y - l.u.y * a - d.y * b },
    { x: l.c.x + l.u.x * a - d.x * b, y: l.c.y + l.u.y * a - d.y * b },
    { x: l.c.x + l.u.x * a + d.x * b, y: l.c.y + l.u.y * a + d.y * b },
    { x: l.c.x - l.u.x * a + d.x * b, y: l.c.y - l.u.y * a + d.y * b },
  ];
}

function textColor(img: RGBAImage, l: OcrLine): string {
  // darkest pixels inside the box carry the ink colour
  const pts = ocrBoxCorners(l, 0.8);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const vals: [number, number, number, number][] = [];
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(img.height, Math.ceil(Math.max(...ys))); y += 1) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(img.width, Math.ceil(Math.max(...xs))); x += 1) {
      const o = (y * img.width + x) * 4;
      const r = img.data[o];
      const g = img.data[o + 1];
      const b = img.data[o + 2];
      vals.push([r + g + b, r, g, b]);
    }
  }
  vals.sort((p, q) => p[0] - q[0]);
  const top = vals.slice(0, Math.max(1, Math.floor(vals.length * 0.08)));
  const avg = (k: number) => top.reduce((s, v) => s + v[k], 0) / top.length;
  const r = avg(1);
  const g = avg(2);
  const b = avg(3);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 45) return '#000000';
  const k = 255 / Math.max(1, max);
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(((v - min * 0.6) * k) / 16) * 16));
  return '#' + [q(r), q(g), q(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** OCR line (image pixels) -> text entity (drawing mm). */
export function ocrLineToText(l: OcrLine, img: RGBAImage, pxPerMm: number, pageHeightMm: number): TextEntity {
  const toD = (p: P): Pt => ({ x: p.x / pxPerMm, y: pageHeightMm - p.y / pxPerMm });
  const fsPx = l.hgt * EM_PER_BOX;
  const widthPx = l.len * WIDTH_PER_BOX;
  const d = { x: -l.u.y, y: l.u.x }; // glyph down, image space
  // baseline-left: half the text back along u, then down to the baseline
  const base = { x: l.c.x - l.u.x * (widthPx / 2) + d.x * 0.36 * fsPx, y: l.c.y - l.u.y * (widthPx / 2) + d.y * 0.36 * fsPx };
  return {
    kind: 'text',
    id: newId('t'),
    style: { layer: 'TEXT', color: textColor(img, l) },
    text: l.text,
    pos: toD(base),
    fontSize: fsPx / pxPerMm,
    rotation: Math.atan2(-l.u.y, l.u.x),
    width: widthPx / pxPerMm,
    widthExact: true,
    align: 'left',
    fontFamily: 'Arial',
    ocrConfidence: l.confidence,
  };
}

export async function processScan(models: OcrModels, img: RGBAImage, opts: ScanOptions): Promise<ScanResult> {
  const { pxPerMm, pageHeightMm } = opts;
  const toD = (p: P): Pt => ({ x: p.x / pxPerMm, y: pageHeightMm - p.y / pxPerMm });

  const lines = await runOcr(models, img, { pxPerMm, onProgress: (f, s) => opts.onProgress?.(f * 0.7, s) });

  const entities: Entity[] = [];
  const texts = lines.map((l) => ocrLineToText(l, img, pxPerMm, pageHeightMm));

  const vec = vectorize(img, {
    pxPerMm,
    textBoxes: lines.map((l) => ocrBoxCorners(l, 1.08)),
    onProgress: (f, s) => opts.onProgress?.(0.7 + f * 0.3, s),
  });
  for (const v of vec.entities) {
    const e = toEntity(v, toD, pxPerMm, vec.strokeWidth);
    if (e) entities.push(e);
  }
  entities.push(...texts);
  return {
    entities,
    ocrLines: lines.length,
    traced: vec.entities.length,
    skewDeg: (vec.skew * 180) / Math.PI,
    detectedUnit: guessDimensionUnit(texts.map((t) => t.text), 'mm'),
  };
}

function toEntity(v: VEntity, toD: (p: P) => Pt, pxPerMm: number, stroke: number): Entity | null {
  const style = (color: string, width: number, dash?: number[], layer = 'GEOMETRY'): Style => ({
    layer: dash ? 'DASHED' : layer,
    color,
    lineWidth: width > stroke * 1.6 ? width / pxPerMm : 0,
    dash: dash?.map((x) => x / pxPerMm),
  });
  switch (v.kind) {
    case 'line':
      return { kind: 'line', id: newId(), style: style(v.color, v.width, v.dash), a: toD(v.a), b: toD(v.b) };
    case 'circle':
      return { kind: 'circle', id: newId(), style: style(v.color, v.width, v.dash), c: toD(v.c), r: v.r / pxPerMm };
    case 'arc': {
      // image angles are clockwise (y down); drawing angles counter-clockwise
      const s = -v.a0;
      const e = -(v.a0 + v.sweep);
      const [start, end] = v.sweep >= 0 ? [e, s] : [s, e];
      const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return { kind: 'arc', id: newId(), style: style(v.color, v.width, v.dash), c: toD(v.c), r: v.r / pxPerMm, start: norm(start), end: norm(end) };
    }
    case 'solid':
      return { kind: 'solid', id: newId(), style: { layer: 'ARROWS', color: v.color, fill: v.color, stroke: false }, pts: v.pts.map(toD) };
  }
}

/** Fills in counts and bounds after a scan was processed. */
export function scanStats(entities: Entity[]) {
  const stats = emptyStats();
  countEntities(entities.filter((e) => e.style.layer !== 'SCAN'), stats);
  return { stats, bounds: drawingBounds(entities, {}) };
}
