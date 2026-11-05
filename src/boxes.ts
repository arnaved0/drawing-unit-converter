// Dimension boxes the user adds or removes by hand.
//
// A box the user draws becomes an invisible text entity (like OCR text): the
// drawing keeps showing its own letters, and a converted value is drawn on a
// white patch. Every number in it counts as a length, since the user pointed
// at it, except angles.

import { findLengthTokens, type Dimension } from './dimensions';
import { textCorners, pointInPoly } from './geom';
import { newId, type Box, type Drawing, type Pt, type TextEntity } from './model';

/** Text placed by an OCR line: baseline start, baseline vector and em vector, in drawing units. */
export interface Placement {
  origin: Pt;
  across: Pt;
  up: Pt;
}

export function textFromPlacement(text: string, p: Placement, color: string, readText = text): TextEntity {
  const len = Math.hypot(p.across.x, p.across.y);
  // keep the width per character when the user edits what OCR read
  const width = len * (Math.max(1, [...text].length) / Math.max(1, [...readText].length));
  return {
    kind: 'text',
    id: newId('box'),
    style: { layer: 'TEXT', color },
    text,
    pos: p.origin,
    fontSize: Math.hypot(p.up.x, p.up.y),
    rotation: Math.atan2(p.across.y, p.across.x),
    width,
    widthExact: true,
    align: 'left',
    fontFamily: 'Arial',
    ocr: true,
    isDimension: true,
    manual: true,
  };
}

/** Corners of an axis-aligned box: bottom-left, bottom-right, top-right, top-left. */
export function boxPoly(b: Box): Pt[] {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
}

/** Centre of a polygon (average of its corners). */
export function polyCentre(poly: Pt[]): Pt {
  return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
}

/** `poly` turned by `angle` radians (counter-clockwise) around its centre. */
export function rotatePoly(poly: Pt[], angle: number): Pt[] {
  const c = polyCentre(poly);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return poly.map((p) => ({ x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos }));
}

/** Angle of a box: direction of its bottom edge (corner 0 to corner 1). */
export function polyAngle(poly: Pt[]): number {
  return Math.atan2(poly[1].y - poly[0].y, poly[1].x - poly[0].x);
}

/** Text filling a box when nothing was read in it: along the longer side (vertical boxes read bottom to top). */
export function textFromBox(text: string, b: Box | Pt[], color = '#000000'): TextEntity {
  // worked out in the box's own frame (corner 0 at the origin, bottom edge along x), then turned with it
  const poly = Array.isArray(b) ? b : boxPoly(b);
  const angle = polyAngle(poly);
  const w = Math.hypot(poly[1].x - poly[0].x, poly[1].y - poly[0].y);
  const h = Math.hypot(poly[3].x - poly[0].x, poly[3].y - poly[0].y);
  const vertical = h > w * 1.2;
  const size = (vertical ? w : h) * 0.75;
  const len = vertical ? h : w;
  const local = vertical ? { x: w - w * 0.22, y: 0 } : { x: 0, y: h * 0.22 };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    kind: 'text',
    id: newId('box'),
    style: { layer: 'TEXT', color },
    text,
    pos: { x: poly[0].x + local.x * cos - local.y * sin, y: poly[0].y + local.x * sin + local.y * cos },
    fontSize: size,
    rotation: angle + (vertical ? Math.PI / 2 : 0),
    width: len,
    widthExact: false,
    align: 'left',
    fontFamily: 'Arial',
    ocr: true,
    isDimension: true,
    manual: true,
  };
}

let counter = 0;
/**
 * Dimensions in a text the user boxed. `customSuffix` is the custom unit's
 * original suffix: values written with it count too ("12V", "45°").
 */
export function dimensionsOf(t: TextEntity, customSuffix?: string): Dimension[] {
  return findLengthTokens(t.text, { isDimension: true, customSuffix }).map((tok) => {
    counter += 1;
    return { ...tok, id: `m${counter}`, textId: t.id, original: t.text.slice(tok.start, tok.end) };
  });
}

/** Centre of a dimension's value (drawing coordinates). */
export function dimensionCentre(d: Drawing, dim: Dimension): Pt | null {
  const t = d.entities.find((e): e is TextEntity => e.kind === 'text' && e.id === dim.textId);
  if (!t) return null;
  const n = Math.max(1, t.text.length);
  const c = textCorners(t, dim.start / n, dim.end / n);
  return { x: c.reduce((s, p) => s + p.x, 0) / 4, y: c.reduce((s, p) => s + p.y, 0) / 4 };
}

export interface BoxEdit {
  entities: Drawing['entities'];
  dims: Dimension[];
  /** Ids of the dimensions that were replaced. */
  replaced: string[];
}

/**
 * Adds a boxed text. Dimensions whose value lies inside the box are replaced
 * (the box corrects them), and OCR texts that lie wholly inside it are dropped
 * so the DXF does not get the same text twice.
 */
export function addBoxedText(d: Drawing, dims: Dimension[], box: Box | Pt[], t: TextEntity, customSuffix?: string): BoxEdit {
  // a box the user drew, possibly turned to follow an angled dimension
  const poly = Array.isArray(box) ? box : boxPoly(box);
  const inside = (p: Pt | null) => !!p && pointInPoly(p, poly);
  const replaced = dims.filter((x) => inside(dimensionCentre(d, x)));
  const drop = new Set(
    d.entities
      .filter((e): e is TextEntity => e.kind === 'text' && !!e.ocr && textCorners(e).every((p) => inside(p)))
      .map((e) => e.id),
  );
  const ids = new Set(replaced.map((x) => x.id));
  // the drawn region is covered whole once the value is converted, so no old text shows through
  const boxed: TextEntity = { ...t, cover: poly };
  return {
    entities: [...d.entities.filter((e) => !drop.has(e.id)), boxed],
    dims: [...dims.filter((x) => !ids.has(x.id) && !drop.has(x.textId)), ...dimensionsOf(t, customSuffix)],
    replaced: [...ids],
  };
}
