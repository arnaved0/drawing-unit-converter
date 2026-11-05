// Internal drawing model. It follows the DXF/DWG entity model (lines, arcs,
// polylines with bulges, text, block inserts) so that every input format maps
// onto it and every output format can be written from it.

import type { FaceId } from './fonts/faces';

export interface Pt {
  x: number;
  y: number;
}

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export interface Style {
  layer: string;
  /** '#rrggbb' stroke colour (or text colour). */
  color: string;
  /** Fill colour for filled shapes, null/undefined = not filled. */
  fill?: string | null;
  /** false = fill only. Defaults to true. */
  stroke?: boolean;
  /** Line width in drawing units; 0 or undefined = hairline. */
  lineWidth?: number;
  /** Dash pattern in drawing units (on, off, on, off ...). */
  dash?: number[];
  /** DXF linetype name, when the source had one. */
  lineType?: string;
}

/** Polyline vertex. bulge = tan(sweep/4) of the arc to the next vertex (DXF convention). */
export interface Vertex extends Pt {
  bulge?: number;
}

/** A path segment used for curves that are neither lines nor circular arcs. */
export type PathSeg =
  | { t: 'L'; p: Pt }
  | { t: 'A'; p: Pt; bulge: number }
  | { t: 'C'; c1: Pt; c2: Pt; p: Pt };

interface Base {
  id: string;
  style: Style;
}

export interface LineEntity extends Base {
  kind: 'line';
  a: Pt;
  b: Pt;
}
export interface PolylineEntity extends Base {
  kind: 'polyline';
  pts: Vertex[];
  closed: boolean;
}
export interface CircleEntity extends Base {
  kind: 'circle';
  c: Pt;
  r: number;
}
/** Arc from start to end angle (radians), counter-clockwise. */
export interface ArcEntity extends Base {
  kind: 'arc';
  c: Pt;
  r: number;
  start: number;
  end: number;
}
/** Free-form path with cubic Bezier segments (curves that are not arcs). */
export interface CurveEntity extends Base {
  kind: 'curve';
  start: Pt;
  segs: PathSeg[];
  closed: boolean;
  /** Further subpaths of the same filled shape (holes of letters, washers). */
  more?: { start: Pt; segs: PathSeg[]; closed: boolean }[];
  /** Fill rule for `more`: even-odd instead of non-zero winding. */
  evenOdd?: boolean;
}
/** Filled triangle/quad (arrowheads), like DXF SOLID. */
export interface SolidEntity extends Base {
  kind: 'solid';
  pts: Pt[];
}

/** Link from a text entity back to the DXF entity it came from, for in-place patching. */
export interface DxfTextSource {
  /** Handle of the TEXT/MTEXT entity holding the characters. */
  handle?: string;
  /** Full raw (encoded) string of that entity. */
  raw: string;
  /** Raw index where each display character starts / ends (see textcodes.ts). */
  starts: number[];
  ends: number[];
  /** true for MTEXT, false for TEXT. */
  mtext: boolean;
  /** Handle of the owning DIMENSION entity, when the text is a dimension's text. */
  dimHandle?: string;
}

export interface TextEntity extends Base {
  kind: 'text';
  text: string;
  /** Anchor point. With align 'left' it is the start of the baseline. */
  pos: Pt;
  /** Em size of the font in drawing units (not cap height). */
  fontSize: number;
  /** Radians, counter-clockwise. */
  rotation: number;
  /** Advance width of the original string in drawing units. */
  width: number;
  /** true when width came from the source file (PDF), false when estimated. */
  widthExact: boolean;
  align: 'left' | 'center' | 'right';
  fontFamily?: string;
  /**
   * The bundled font that looks like this text (src/fonts/faces.ts): from the
   * font name for real text, matched to the letter shapes for OCR text.
   * Converted values are written in it.
   */
  face?: FaceId;
  /** Width factor against the face's own widths (1 when missing). */
  hscale?: number;
  /** Lean of sloped lettering: tan of the angle, positive leans right. */
  slant?: number;
  /** Text belongs to a real dimension object (DXF/DWG DIMENSION). */
  isDimension?: boolean;
  /** Dimension type when isDimension: angular dimensions are never converted. */
  dimType?: 'linear' | 'radius' | 'diameter' | 'angular' | 'ordinate';
  /**
   * Invisible text (an OCR text layer) over text that is drawn as outlines or
   * is part of an image. It is not drawn itself; a converted value is drawn
   * over a white patch instead.
   */
  ocr?: boolean;
  /** Added by the user with a box. */
  manual?: boolean;
  /** The region the user drew (drawing coordinates): covered whole when the value is converted. */
  cover?: Pt[];
  /**
   * Where the user moved the converted text to (drawing units, added to its
   * position). The white-out over the original stays where it was.
   */
  offset?: Pt;
  dxf?: DxfTextSource;
}

export interface ImageEntity extends Base {
  kind: 'image';
  /** data: URL (PNG) or '' when it could not be decoded. */
  href: string;
  /** Image corners in drawing coords: bottom-left, bottom-right, top-left. */
  p00: Pt;
  p10: Pt;
  p01: Pt;
  pxW: number;
  pxH: number;
}

export interface InsertEntity extends Base {
  kind: 'insert';
  block: string;
  pos: Pt;
  sx: number;
  sy: number;
  /** Radians. */
  rotation: number;
}

export type Entity =
  | LineEntity
  | PolylineEntity
  | CircleEntity
  | ArcEntity
  | CurveEntity
  | SolidEntity
  | TextEntity
  | ImageEntity
  | InsertEntity;

export interface Block {
  name: string;
  base: Pt;
  entities: Entity[];
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ImportStats {
  lines: number;
  polylines: number;
  circles: number;
  arcs: number;
  curves: number;
  solids: number;
  texts: number;
  images: number;
  blocks: number;
  inserts: number;
  dimensions: number;
}

export type SourceKind = 'pdf' | 'dxf' | 'dwg';

export interface PdfSource {
  bytes: Uint8Array;
  pageIndex: number;
  pageCount: number;
  /** Affine [a,b,c,d,e,f] mapping PDF user space -> drawing coordinates. */
  userToDrawing: number[];
}

export interface DxfSource {
  /** Original DXF bytes (for DWG input: the DXF produced by LibreDWG). */
  bytes: Uint8Array;
  /** true when the file stores strings as UTF-8 (AC1021 / R2007 and later). */
  utf8: boolean;
  /** true when entities carry handles, which in-place patching needs. */
  hasHandles: boolean;
}

export interface Drawing {
  name: string;
  source: SourceKind;
  entities: Entity[];
  blocks: Record<string, Block>;
  bounds: Box;
  /** Units of the geometry. PDF imports are stored in paper millimetres. */
  geometryUnit: LengthUnit;
  /** Best guess for the unit that unit-less dimension values are written in. */
  detectedDimensionUnit: LengthUnit;
  pdf?: PdfSource;
  dxf?: DxfSource;
  stats: ImportStats;
  warnings: string[];
}

export function emptyStats(): ImportStats {
  return {
    lines: 0,
    polylines: 0,
    circles: 0,
    arcs: 0,
    curves: 0,
    solids: 0,
    texts: 0,
    images: 0,
    blocks: 0,
    inserts: 0,
    dimensions: 0,
  };
}

/** Layer of filled letter shapes that an OCR text layer covers (see importers/pdf.ts). */
export const TEXT_OUTLINES = 'TEXT_OUTLINES';

let idCounter = 0;
export function newId(prefix = 'e'): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

export function countEntities(entities: Entity[], stats: ImportStats): void {
  for (const e of entities) {
    switch (e.kind) {
      case 'line': stats.lines++; break;
      case 'polyline': stats.polylines++; break;
      case 'circle': stats.circles++; break;
      case 'arc': stats.arcs++; break;
      case 'curve': stats.curves++; break;
      case 'solid': stats.solids++; break;
      case 'text': stats.texts++; break;
      case 'image': stats.images++; break;
      case 'insert': stats.inserts++; break;
    }
  }
}
