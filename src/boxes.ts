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

/** Text filling a box when nothing was read in it: along the longer side (vertical boxes read bottom to top). */
export function textFromBox(text: string, b: Box, color = '#000000'): TextEntity {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const vertical = h > w * 1.2;
  const size = (vertical ? w : h) * 0.75;
  const len = vertical ? h : w;
  return {
    kind: 'text',
    id: newId('box'),
    style: { layer: 'TEXT', color },
    text,
    pos: vertical ? { x: b.maxX - (vertical ? w : h) * 0.22, y: b.minY } : { x: b.minX, y: b.minY + h * 0.22 },
    fontSize: size,
    rotation: vertical ? Math.PI / 2 : 0,
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
/** Dimensions in a text the user boxed. */
export function dimensionsOf(t: TextEntity): Dimension[] {
  return findLengthTokens(t.text, { isDimension: true }).map((tok) => {
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
export function addBoxedText(d: Drawing, dims: Dimension[], box: Box, t: TextEntity): BoxEdit {
  const poly = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  const inside = (p: Pt | null) => !!p && pointInPoly(p, poly);
  const replaced = dims.filter((x) => inside(dimensionCentre(d, x)));
  const drop = new Set(
    d.entities
      .filter((e): e is TextEntity => e.kind === 'text' && !!e.ocr && textCorners(e).every((p) => inside(p)))
      .map((e) => e.id),
  );
  const ids = new Set(replaced.map((x) => x.id));
  return {
    entities: [...d.entities.filter((e) => !drop.has(e.id)), t],
    dims: [...dims.filter((x) => !ids.has(x.id) && !drop.has(x.textId)), ...dimensionsOf(t)],
    replaced: [...ids],
  };
}
