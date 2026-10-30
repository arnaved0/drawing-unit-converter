// DXF -> drawing model (also used for DWG, which LibreDWG converts to DXF first).
// Real DIMENSION entities keep a link to their handles so the original file
// can be patched in place on export.

import DxfParser from 'dxf-parser';
import { aciToHex, intToHex } from '../aci';
import { guessDimensionUnit } from '../dimensions';
import { drawingBounds, normAngle } from '../geom';
import { countEntities, emptyStats, newId, type Block, type Drawing, type Entity, type LengthUnit, type Pt, type SourceKind, type Style, type TextEntity } from '../model';
import { decodeDxfText } from '../textcodes';
import { entityTypesInEntitiesSection } from '../dxfpairs';

const CODEPAGES: Record<string, string> = {
  ANSI_874: 'windows-874', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_1258: 'windows-1258',
};

/** Reads a header variable straight from the DXF bytes (before choosing the text decoding). */
function headerVar(ascii: string, name: string): string | null {
  const re = new RegExp(`\\n\\s*9\\r?\\n\\${name}\\r?\\n\\s*\\d+\\r?\\n([^\\r\\n]*)`);
  return re.exec(ascii)?.[1]?.trim() ?? null;
}

export function decodeDxfBytes(bytes: Uint8Array): { text: string; utf8: boolean } {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 200000)));
  const ver = headerVar(head, '$ACADVER') ?? 'AC1009';
  const utf8 = ver >= 'AC1021';
  if (utf8) return { text: new TextDecoder('utf-8').decode(bytes), utf8 };
  const cp = (headerVar(head, '$DWGCODEPAGE') ?? 'ANSI_1252').toUpperCase();
  let label = CODEPAGES[cp] ?? 'windows-1252';
  try {
    return { text: new TextDecoder(label).decode(bytes), utf8 };
  } catch {
    label = 'windows-1252';
    return { text: new TextDecoder(label).decode(bytes), utf8 };
  }
}

const INSUNITS: Record<number, LengthUnit> = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };

/** Ratio of em size to cap height for typical CAD fonts (DXF text height = cap height). */
const EM_PER_CAP = 1 / 0.72;
const CHAR_W = 0.62; // average advance per character, in cap heights

interface Ctx {
  dxf: any;
  layerColor: Map<string, string>;
  blocks: Record<string, Block>;
  warnings: Set<string>;
}

function pt(p: any): Pt {
  return { x: Number(p?.x) || 0, y: Number(p?.y) || 0 };
}

function styleOf(e: any, ctx: Ctx, layerOverride?: string): Style {
  const layer = layerOverride ?? e.layer ?? '0';
  let color = ctx.layerColor.get(e.layer ?? '0') ?? '#000000';
  if (typeof e.color === 'number' && e.colorIndex !== 256 && e.colorIndex !== 0) color = intToHex(e.color);
  else if (typeof e.colorIndex === 'number' && e.colorIndex > 0 && e.colorIndex < 256) color = aciToHex(e.colorIndex);
  const st: Style = { layer, color };
  if (e.lineType && !/^(continuous|bylayer|byblock)$/i.test(e.lineType)) st.lineType = e.lineType;
  if (typeof e.lineweight === 'number' && e.lineweight > 0) st.lineWidth = e.lineweight / 100;
  return st;
}

function bspline(degree: number, ctrl: Pt[], knots: number[], weights?: number[]): Pt[] {
  const n = ctrl.length;
  if (n < 2) return ctrl;
  if (!knots || knots.length !== n + degree + 1) return ctrl;
  const w = weights && weights.length === n ? weights : ctrl.map(() => 1);
  const lo = knots[degree];
  const hi = knots[n];
  const steps = Math.max(20, n * 8);
  const out: Pt[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = Math.min(lo + ((hi - lo) * s) / steps, hi - 1e-10);
    let k = degree;
    while (k < n - 1 && knots[k + 1] <= t) k++;
    const d: { x: number; y: number; w: number }[] = [];
    for (let j = 0; j <= degree; j++) {
      const c = ctrl[k - degree + j];
      const ww = w[k - degree + j];
      d.push({ x: c.x * ww, y: c.y * ww, w: ww });
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den === 0 ? 0 : (t - knots[i]) / den;
        d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y, w: (1 - a) * d[j - 1].w + a * d[j].w };
      }
    }
    out.push({ x: d[degree].x / d[degree].w, y: d[degree].y / d[degree].w });
  }
  return out;
}

function ellipsePoints(e: any): Pt[] {
  const c = pt(e.center);
  const maj = pt(e.majorAxisEndPoint);
  const ratio = Number(e.axisRatio) || 1;
  const rot = Math.atan2(maj.y, maj.x);
  const a = Math.hypot(maj.x, maj.y);
  const b = a * ratio;
  const s = Number(e.startAngle) || 0;
  let t = e.endAngle === undefined ? 2 * Math.PI : Number(e.endAngle);
  if (t <= s) t += 2 * Math.PI;
  const n = Math.max(16, Math.ceil(((t - s) / (2 * Math.PI)) * 96));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const u = s + ((t - s) * i) / n;
    const x = a * Math.cos(u);
    const y = b * Math.sin(u);
    out.push({ x: c.x + x * Math.cos(rot) - y * Math.sin(rot), y: c.y + x * Math.sin(rot) + y * Math.cos(rot) });
  }
  return out;
}

function makeText(
  text: string,
  pos: Pt,
  capHeight: number,
  rotationDeg: number,
  align: TextEntity['align'],
  style: Style,
  extra: Partial<TextEntity> = {},
): TextEntity {
  const h = capHeight > 0 ? capHeight : 2.5;
  return {
    kind: 'text',
    id: newId('t'),
    style,
    text,
    pos,
    fontSize: h * EM_PER_CAP,
    rotation: (rotationDeg * Math.PI) / 180,
    width: h * CHAR_W * Math.max(1, text.length),
    widthExact: false,
    align,
    ...extra,
  };
}

function convertTextLike(e: any, ctx: Ctx, out: Entity[], dim?: { handle?: string; type: TextEntity['dimType'] }): void {
  const style = styleOf(e, ctx);
  if (dim) style.layer = e.layer ?? 'DIMENSIONS';
  const extra = (line: { text: string; starts: number[]; ends: number[] }, raw: string, mtext: boolean): Partial<TextEntity> => ({
    isDimension: !!dim,
    dimType: dim?.type,
    dxf: { handle: e.handle, raw, starts: line.starts, ends: line.ends, mtext, dimHandle: dim?.handle },
  });
  if (e.type === 'TEXT' || e.type === 'ATTDEF') {
    const raw: string = e.text ?? '';
    const [line] = decodeDxfText(raw, false);
    if (!line.text.trim()) return;
    const h = Number(e.textHeight) || 2.5;
    // halign: 0 left 1 center 2 right 3 aligned 4 middle 5 fit; valign: 0 baseline 1 bottom 2 middle 3 top
    const ha = Number(e.halign) || 0;
    const va = Number(e.valign) || 0;
    const fitted = ha === 3 || ha === 5;
    const useEnd = !fitted && (ha !== 0 || va !== 0) && e.endPoint;
    let p = pt(useEnd ? e.endPoint : e.startPoint);
    const rot = Number(e.rotation) || 0;
    const align: TextEntity['align'] = fitted ? 'left' : ha === 1 || ha === 4 ? 'center' : ha === 2 ? 'right' : 'left';
    // shift of the baseline from the alignment point, along the text's "up" direction
    const shift = fitted ? 0 : va === 3 ? -h : va === 2 || ha === 4 ? -h / 2 : va === 1 ? h * 0.25 : 0;
    if (shift) {
      const r = (rot * Math.PI) / 180;
      p = { x: p.x - Math.sin(r) * shift, y: p.y + Math.cos(r) * shift };
    }
    const te = makeText(line.text, p, h, rot, align, style, extra(line, raw, false));
    if (e.xScale && e.xScale > 0) te.width *= e.xScale;
    out.push(te);
    return;
  }
  // MTEXT
  const raw: string = e.text ?? '';
  const lines = decodeDxfText(raw, true);
  const h = Number(e.height) || 2.5;
  let rot = Number(e.rotation) || 0;
  if (e.directionVector && (e.directionVector.x || e.directionVector.y)) rot = (Math.atan2(e.directionVector.y, e.directionVector.x) * 180) / Math.PI;
  const ap = Number(e.attachmentPoint) || 1;
  const col = (ap - 1) % 3;
  const row = Math.floor((ap - 1) / 3);
  const align: TextEntity['align'] = col === 1 ? 'center' : col === 2 ? 'right' : 'left';
  const spacing = (h * 5) / 3;
  // Height from the cap line of the first line to the baseline of the last.
  const total = h + spacing * (lines.length - 1);
  const offset = row === 0 ? 0 : row === 1 ? total / 2 : total;
  const r = (rot * Math.PI) / 180;
  const base = pt(e.position);
  lines.forEach((line, i) => {
    if (!line.text.trim()) return;
    // distance from the attachment point down to this line's baseline
    const down = h + spacing * i - offset;
    const p = { x: base.x + Math.sin(r) * down, y: base.y - Math.cos(r) * down };
    out.push(makeText(line.text, p, h, rot, align, style, extra(line, raw, true)));
  });
}

const DIM_TYPES: Record<number, TextEntity['dimType']> = { 0: 'linear', 1: 'linear', 2: 'angular', 3: 'diameter', 4: 'radius', 5: 'angular', 6: 'ordinate' };

function convertEntity(e: any, ctx: Ctx, out: Entity[], inBlock: boolean): void {
  if (e.inPaperSpace && !inBlock) return;
  if (e.visible === false) return;
  const style = () => styleOf(e, ctx);
  switch (e.type) {
    case 'LINE': {
      const v = e.vertices ?? [];
      if (v.length >= 2) out.push({ kind: 'line', id: newId(), style: style(), a: pt(v[0]), b: pt(v[1]) });
      break;
    }
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      if (e.is3dPolyline === false && e.isPolyfaceMesh) break;
      const verts = (e.vertices ?? []).filter((v: any) => !v.splineControlPoint && !v.faces);
      if (verts.length < 2) break;
      const pts = verts.map((v: any) => ({ x: Number(v.x) || 0, y: Number(v.y) || 0, bulge: Number(v.bulge) || undefined }));
      out.push({ kind: 'polyline', id: newId(), style: style(), pts, closed: !!e.shape });
      break;
    }
    case 'CIRCLE':
      out.push({ kind: 'circle', id: newId(), style: style(), c: pt(e.center), r: Number(e.radius) || 0 });
      break;
    case 'ARC':
      out.push({ kind: 'arc', id: newId(), style: style(), c: pt(e.center), r: Number(e.radius) || 0, start: normAngle(e.startAngle || 0), end: normAngle(e.endAngle || 0) });
      break;
    case 'ELLIPSE':
      out.push({ kind: 'polyline', id: newId(), style: style(), pts: ellipsePoints(e), closed: false });
      break;
    case 'SPLINE': {
      const ctrl = (e.controlPoints ?? []).map(pt);
      const pts = ctrl.length >= 2 ? bspline(Number(e.degreeOfSplineCurve) || 3, ctrl, e.knotValues, e.weights) : (e.fitPoints ?? []).map(pt);
      if (pts.length >= 2) out.push({ kind: 'polyline', id: newId(), style: style(), pts, closed: !!e.closed });
      break;
    }
    case 'SOLID':
    case '3DFACE': {
      const p = (e.points ?? e.vertices ?? []).map(pt);
      if (p.length >= 3) {
        // SOLID vertex order is 1,2,4,3
        const ordered = e.type === 'SOLID' && p.length === 4 ? [p[0], p[1], p[3], p[2]] : p;
        const st = style();
        if (e.type === 'SOLID') st.fill = st.color;
        out.push({ kind: e.type === 'SOLID' ? 'solid' : 'polyline', id: newId(), style: st, pts: ordered, closed: true } as Entity);
      }
      break;
    }
    case 'TEXT':
    case 'MTEXT':
      convertTextLike(e, ctx, out);
      break;
    case 'ATTDEF':
      break; // attribute definitions are templates, not visible geometry
    case 'INSERT': {
      const name = e.name;
      if (!name || !ensureBlock(name, ctx)) break;
      const sx = Number(e.xScale ?? 1) || 1;
      const sy = Number(e.yScale ?? 1) || 1;
      const rot = ((Number(e.rotation) || 0) * Math.PI) / 180;
      const cols = Math.max(1, Number(e.columnCount) || 1);
      const rows = Math.max(1, Number(e.rowCount) || 1);
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const p = pt(e.position);
          const dx = i * (Number(e.columnSpacing) || 0);
          const dy = j * (Number(e.rowSpacing) || 0);
          out.push({
            kind: 'insert',
            id: newId('i'),
            style: style(),
            block: name,
            pos: { x: p.x + dx * Math.cos(rot) - dy * Math.sin(rot), y: p.y + dx * Math.sin(rot) + dy * Math.cos(rot) },
            sx,
            sy,
            rotation: rot,
          });
        }
      }
      break;
    }
    case 'DIMENSION': {
      const type = DIM_TYPES[(Number(e.dimensionType) || 0) & 7] ?? 'linear';
      const blk = e.block ? ctx.dxf.blocks?.[e.block] : null;
      const dimInfo = { handle: e.handle, type };
      let gotText = false;
      if (blk?.entities) {
        // Dimension blocks are drawn in WCS at insertion (0,0): inline their geometry.
        for (const be of blk.entities) {
          if (be.type === 'TEXT' || be.type === 'MTEXT') {
            convertTextLike(be, ctx, out, dimInfo);
            gotText = true;
          } else if (be.type !== 'POINT') convertEntity(be, ctx, out, true);
        }
      }
      if (!gotText && e.middleOfText) {
        const override = typeof e.text === 'string' && e.text && e.text !== '<>' ? e.text : null;
        const value = override ?? (typeof e.actualMeasurement === 'number' ? String(+e.actualMeasurement.toFixed(4)) : '');
        if (value) {
          const prefix = override ? '' : type === 'radius' ? 'R' : type === 'diameter' ? '\u00d8' : '';
          const te = makeText(prefix + value, pt(e.middleOfText), 2.5, 0, 'center', styleOf(e, ctx), { isDimension: true, dimType: type });
          te.dxf = { raw: te.text, starts: [...te.text].map((_, i) => i), ends: [...te.text].map((_, i) => i + 1), mtext: true, dimHandle: e.handle };
          out.push(te);
        }
      }
      break;
    }
    default:
      break; // POINT and anything dxf-parser passes through; unsupported types are reported once per file
  }
}

function ensureBlock(name: string, ctx: Ctx): boolean {
  if (ctx.blocks[name]) return true;
  const b = ctx.dxf.blocks?.[name];
  if (!b) return false;
  const block: Block = { name, base: pt(b.position), entities: [] };
  ctx.blocks[name] = block; // register first to stop recursion loops
  for (const e of b.entities ?? []) convertEntity(e, ctx, block.entities, true);
  return true;
}

const KNOWN_TYPES = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE', 'VERTEX', 'SEQEND', 'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE', 'SOLID', '3DFACE', 'TEXT', 'MTEXT', 'INSERT', 'ATTRIB', 'ATTDEF', 'DIMENSION', 'POINT', 'VIEWPORT']);

/** Entity types in the ENTITIES section that dxf-parser silently drops. */
function unsupportedTypes(text: string): string[] {
  return [...entityTypesInEntitiesSection(text)].filter((t) => !KNOWN_TYPES.has(t));
}

export function importDxf(bytes: Uint8Array, name: string, source: SourceKind = 'dxf'): Drawing {
  const { text, utf8 } = decodeDxfBytes(bytes);
  const parser = new DxfParser();
  let dxf: any;
  try {
    dxf = parser.parseSync(text);
  } catch (err) {
    throw new Error(`Could not read the DXF file: ${(err as Error).message}`);
  }
  if (!dxf) throw new Error('Could not read the DXF file.');
  const layerColor = new Map<string, string>();
  for (const [lname, l] of Object.entries<any>(dxf.tables?.layer?.layers ?? {})) {
    layerColor.set(lname, typeof l.color === 'number' ? intToHex(l.color) : '#000000');
  }
  const ctx: Ctx = { dxf, layerColor, blocks: {}, warnings: new Set() };
  const entities: Entity[] = [];
  for (const e of dxf.entities ?? []) convertEntity(e, ctx, entities, false);
  const skipped = unsupportedTypes(text);
  if (skipped.length) ctx.warnings.add(`Not shown (not supported yet): ${skipped.join(', ')}.`);

  const insUnits = INSUNITS[Number(dxf.header?.$INSUNITS)] ?? (Number(dxf.header?.$MEASUREMENT) === 0 && dxf.header?.$MEASUREMENT !== undefined ? 'in' : 'mm');
  const stats = emptyStats();
  countEntities(entities, stats);
  stats.blocks = Object.keys(ctx.blocks).length;
  const texts = entities.filter((e): e is TextEntity => e.kind === 'text');
  const hasHandles = /\n\s*5\r?\n[0-9A-Fa-f]+\r?\n/.test(text);
  return {
    name,
    source,
    entities,
    blocks: ctx.blocks,
    bounds: drawingBounds(entities, ctx.blocks),
    geometryUnit: insUnits,
    detectedDimensionUnit: guessDimensionUnit(texts.map((t) => t.text), insUnits),
    dxf: { bytes, utf8, hasHandles },
    stats,
    warnings: [...ctx.warnings],
  };
}
