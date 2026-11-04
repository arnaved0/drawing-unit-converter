// PDF -> drawing model.
// Reads the vector content of a page with pdf.js: paths become lines, arcs,
// circles, polylines and solids; text runs become text entities (with their
// colour); images are kept; repeated geometry becomes blocks.

import { detectBlocks } from '../analysis/blocks';
import { compoundFill, subpathToEntity, type RawSeg, type RawSubpath } from '../analysis/shapes';
import { guessDimensionUnit } from '../dimensions';
import { apply, applyVec, drawingBounds, entityBox, IDENTITY, matScale, mul, pointInPoly, textCorners, type Mat } from '../geom';
import { countEntities, emptyStats, newId, TEXT_OUTLINES, type Drawing, type Entity, type Pt, type Style, type TextEntity } from '../model';

/** The subset of the pdf.js API used here (works with the browser and the Node "legacy" build). */
export interface PdfJs {
  getDocument(src: { data: Uint8Array; [k: string]: unknown }): { promise: Promise<any> };
  OPS: Record<string, number>;
}

const PT_TO_MM = 25.4 / 72;

/** Optional hook to turn pdf.js image objects into PNG data URLs (needs a canvas, so browser only). */
export type ImageEncoder = (img: any) => Promise<string>;

export interface PdfImportOptions {
  pageIndex?: number;
  encodeImage?: ImageEncoder;
  /** Find repeated geometry and make blocks (default true). */
  detectBlocks?: boolean;
  /** Extra pdf.js getDocument parameters (cMapUrl, standardFontDataUrl ...). */
  docParams?: Record<string, unknown>;
}

interface GState {
  ctm: Mat;
  stroke: string;
  fill: string;
  lineWidth: number;
  dash: number[];
  textRender: number;
}

const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };

function toHex(c: unknown): string {
  if (typeof c === 'string' && /^#[0-9a-f]{6}/i.test(c)) return c.slice(0, 7).toLowerCase();
  if (Array.isArray(c) || ArrayBuffer.isView(c)) {
    const a = Array.from(c as ArrayLike<number>);
    if (a.length >= 3) return '#' + a.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }
  return '#000000';
}

function parsePath(data: ArrayLike<number> | null | undefined, m: Mat): RawSubpath[] {
  const out: RawSubpath[] = [];
  if (!data) return out;
  let cur: RawSubpath | null = null;
  let last: Pt = { x: 0, y: 0 };
  const P = (x: number, y: number) => apply(m, { x, y });
  for (let i = 0; i < data.length; ) {
    const op = data[i++];
    if (op === DRAW.moveTo) {
      last = P(data[i++], data[i++]);
      cur = { start: last, segs: [], closed: false };
      out.push(cur);
    } else if (op === DRAW.lineTo) {
      const p = P(data[i++], data[i++]);
      if (!cur) out.push((cur = { start: last, segs: [], closed: false }));
      cur.segs.push({ t: 'L', p });
      last = p;
    } else if (op === DRAW.curveTo) {
      const c1 = P(data[i++], data[i++]);
      const c2 = P(data[i++], data[i++]);
      const p = P(data[i++], data[i++]);
      if (!cur) out.push((cur = { start: last, segs: [], closed: false }));
      cur.segs.push({ t: 'C', c1, c2, p });
      last = p;
    } else if (op === DRAW.quadraticCurveTo) {
      const c = P(data[i++], data[i++]);
      const p = P(data[i++], data[i++]);
      if (!cur) out.push((cur = { start: last, segs: [], closed: false }));
      const c1 = { x: last.x + (2 / 3) * (c.x - last.x), y: last.y + (2 / 3) * (c.y - last.y) };
      const c2 = { x: p.x + (2 / 3) * (c.x - p.x), y: p.y + (2 / 3) * (c.y - p.y) };
      cur.segs.push({ t: 'C', c1, c2, p } as RawSeg);
      last = p;
    } else if (op === DRAW.closePath) {
      if (cur) {
        cur.closed = true;
        last = cur.start;
        cur = null;
      }
    } else break;
  }
  return out.filter((s) => s.segs.length > 0);
}

interface RawText {
  str: string;
  origin: Pt;
  dir: Pt; // unit vector along the baseline
  size: number;
  width: number;
  color: string;
  font: string;
  /** Text rendering mode 3: an OCR text layer. */
  invisible: boolean;
}

/** Merges runs that continue each other on the same baseline (per-character PDF output). */
function mergeRuns(items: RawText[]): RawText[] {
  const lines: RawText[] = [];
  for (const it of items) {
    let merged = false;
    for (let k = lines.length - 1; k >= Math.max(0, lines.length - 12); k--) {
      const l = lines[k];
      if (Math.abs(l.dir.x * it.dir.y - l.dir.y * it.dir.x) > 0.02 || l.dir.x * it.dir.x + l.dir.y * it.dir.y < 0) continue;
      if (Math.abs(l.size - it.size) > 0.15 * l.size || l.color !== it.color || l.invisible !== it.invisible) continue;
      const end = { x: l.origin.x + l.dir.x * l.width, y: l.origin.y + l.dir.y * l.width };
      const vx = it.origin.x - end.x;
      const vy = it.origin.y - end.y;
      const along = vx * l.dir.x + vy * l.dir.y;
      const perp = Math.abs(-l.dir.y * (it.origin.x - l.origin.x) + l.dir.x * (it.origin.y - l.origin.y));
      if (perp > 0.25 * l.size || along < -0.35 * l.size || along > 0.75 * l.size) continue;
      const gap = along > 0.18 * l.size && !l.str.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '';
      l.str += gap + it.str;
      l.width = along + it.width + l.width;
      merged = true;
      break;
    }
    if (!merged) lines.push({ ...it });
  }
  return lines;
}


/**
 * Moves filled shapes that lie inside an OCR text line to the TEXT_OUTLINES
 * layer. Triangles are left alone: those are arrowheads.
 */
function markTextOutlines(entities: Entity[]): Set<Entity> {
  const marked = new Set<Entity>();
  const ocr = entities.filter((e): e is TextEntity => e.kind === 'text' && !!e.ocr);
  if (!ocr.length) return marked;
  const polys = ocr.map((t) => ({ poly: textCorners(t, -0.06, 1.06), box: entityBox(t, {}), size: t.fontSize }));
  for (const e of entities) {
    const filled = (e.kind === 'curve' || e.kind === 'polyline' || e.kind === 'solid') && e.style.stroke === false && !!e.style.fill;
    if (!filled || (e.kind === 'solid' && e.pts.length === 3)) continue;
    const b = entityBox(e, {});
    for (const p of polys) {
      if (b.minX < p.box.minX - p.size || b.maxX > p.box.maxX + p.size || b.minY < p.box.minY - p.size || b.maxY > p.box.maxY + p.size) continue;
      const pts = [
        { x: b.minX, y: b.minY },
        { x: b.maxX, y: b.minY },
        { x: b.maxX, y: b.maxY },
        { x: b.minX, y: b.maxY },
      ];
      // the shape's centre inside the line and the shape no bigger than a letter
      const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      if (pointInPoly(c, p.poly) && Math.max(b.maxX - b.minX, b.maxY - b.minY) < p.size * 1.6 && pts.filter((q) => pointInPoly(q, p.poly)).length >= 2) {
        e.style = { ...e.style, layer: TEXT_OUTLINES };
        marked.add(e);
        break;
      }
    }
  }
  return marked;
}

export async function importPdf(pdfjs: PdfJs, bytes: Uint8Array, name: string, opts: PdfImportOptions = {}): Promise<Drawing> {
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false, ...opts.docParams }) as { promise: Promise<any>; destroy(): Promise<void> };
  const doc = await task.promise;
  try {
    const pageIndex = Math.min(opts.pageIndex ?? 0, doc.numPages - 1);
    const page = await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    // PDF user space -> viewport (y down) -> drawing mm (y up, origin bottom-left of the page)
    const userToDrawing = mul([PT_TO_MM, 0, 0, -PT_TO_MM, 0, vp.height * PT_TO_MM], vp.transform as Mat);
    const OPS = pdfjs.OPS;
    const opList = await page.getOperatorList();
    const fn: number[] = opList.fnArray;
    const args: any[] = opList.argsArray;

    const warnings: string[] = [];
    const entities: Entity[] = [];
    const glyphColors: { ch: string; color: string; invisible: boolean }[] = [];
    const pendingImages: { objId: string | null; inline: any; ctm: Mat }[] = [];
    const stack: GState[] = [];
    let gs: GState = { ctm: [...IDENTITY], stroke: '#000000', fill: '#000000', lineWidth: 1, dash: [], textRender: 0 };

    const styleFor = (layer: string, color: string): Style => {
      const scale = matScale(mul(userToDrawing, gs.ctm));
      const st: Style = { layer, color, lineWidth: gs.lineWidth * scale };
      if (gs.dash.length && gs.dash.some((d) => d > 0)) st.dash = gs.dash.map((d) => d * scale);
      return st;
    };

    const paintOps = new Map<number, { stroke: boolean; fill: boolean; close?: boolean }>([
      [OPS.stroke, { stroke: true, fill: false }],
      [OPS.closeStroke, { stroke: true, fill: false, close: true }],
      [OPS.fill, { stroke: false, fill: true }],
      [OPS.eoFill, { stroke: false, fill: true }],
      [OPS.fillStroke, { stroke: true, fill: true }],
      [OPS.eoFillStroke, { stroke: true, fill: true }],
      [OPS.closeFillStroke, { stroke: true, fill: true, close: true }],
      [OPS.closeEOFillStroke, { stroke: true, fill: true, close: true }],
    ]);

    for (let i = 0; i < fn.length; i++) {
      const op = fn[i];
      const a = args[i];
      switch (op) {
        case OPS.save:
          stack.push({ ...gs, dash: [...gs.dash], ctm: [...gs.ctm] });
          break;
        case OPS.restore:
          gs = stack.pop() ?? gs;
          break;
        case OPS.transform:
          gs.ctm = mul(gs.ctm, a as Mat);
          break;
        case OPS.paintFormXObjectBegin:
          stack.push({ ...gs, dash: [...gs.dash], ctm: [...gs.ctm] });
          if (Array.isArray(a?.[0]) || ArrayBuffer.isView(a?.[0])) gs.ctm = mul(gs.ctm, Array.from(a[0] as number[]));
          break;
        case OPS.paintFormXObjectEnd:
          gs = stack.pop() ?? gs;
          break;
        case OPS.setLineWidth:
          gs.lineWidth = a[0];
          break;
        case OPS.setDash:
          gs.dash = Array.from((a[0] ?? []) as number[]);
          break;
        case OPS.setGState:
          for (const [k, v] of a[0] as [string, any][]) {
            if (k === 'LW') gs.lineWidth = v;
            else if (k === 'D') gs.dash = Array.from((v?.[0] ?? []) as number[]);
          }
          break;
        case OPS.setStrokeRGBColor:
          gs.stroke = toHex(a[0] ?? a);
          break;
        case OPS.setFillRGBColor:
          gs.fill = toHex(a[0] ?? a);
          break;
        case OPS.setTextRenderingMode:
          gs.textRender = a[0];
          break;
        case OPS.showText:
        case OPS.showSpacedText: {
          for (const g of (a[0] ?? []) as any[]) {
            if (g && typeof g === 'object' && typeof g.unicode === 'string' && g.unicode.trim()) {
              glyphColors.push({ ch: g.unicode, color: gs.textRender === 1 ? gs.stroke : gs.fill, invisible: gs.textRender === 3 });
            }
          }
          break;
        }
        case OPS.constructPath: {
          const paintOp: number = a[0];
          const paint = paintOps.get(paintOp);
          if (!paint) break; // endPath (clipping) or unknown
          const data = a[1]?.[0] as ArrayLike<number> | null;
          const m = mul(userToDrawing, gs.ctm);
          const subpaths = parsePath(data, m);
          if (paint.fill && !paint.stroke && subpaths.length > 1) {
            // one filled shape with holes (letters drawn as outlines, rings)
            const st = styleFor('FILLS', gs.fill);
            st.fill = gs.fill;
            const ent = compoundFill(subpaths, st, paintOp === OPS.eoFill);
            if (ent) entities.push(ent);
            break;
          }
          for (const sp of subpaths) {
            if (paint.close) sp.closed = true;
            const color = paint.stroke ? gs.stroke : gs.fill;
            const layer = paint.fill && !paint.stroke ? 'FILLS' : gs.dash.some((d) => d > 0) ? 'DASHED' : 'GEOMETRY';
            const st = styleFor(layer, color);
            if (paint.fill) st.fill = gs.fill;
            const ent = subpathToEntity(sp, st, paint);
            if (ent) entities.push(ent);
          }
          break;
        }
        case OPS.paintImageXObject:
        case OPS.paintImageMaskXObject:
          pendingImages.push({ objId: typeof a[0] === 'string' ? a[0] : a[0]?.data ?? null, inline: typeof a[0] === 'object' ? a[0] : null, ctm: mul(userToDrawing, gs.ctm) });
          break;
        case OPS.paintInlineImageXObject:
          pendingImages.push({ objId: null, inline: a[0], ctm: mul(userToDrawing, gs.ctm) });
          break;
        default:
          break;
      }
    }

    // images
    for (const img of pendingImages) {
      let obj: any = img.inline;
      if (!obj && img.objId) {
        obj = await new Promise((resolve) => {
          const store = img.objId!.startsWith('g_') ? page.commonObjs : page.objs;
          try {
            store.get(img.objId, resolve);
          } catch {
            resolve(null);
          }
          setTimeout(() => resolve(null), 3000);
        });
      }
      const pxW = obj?.width ?? 0;
      const pxH = obj?.height ?? 0;
      let href = '';
      if (obj && opts.encodeImage) {
        try {
          href = await opts.encodeImage(obj);
        } catch {
          href = '';
        }
      }
      entities.push({
        kind: 'image',
        id: newId('img'),
        style: { layer: 'IMAGES', color: '#808080' },
        href,
        p00: apply(img.ctm, { x: 0, y: 0 }),
        p10: apply(img.ctm, { x: 1, y: 0 }),
        p01: apply(img.ctm, { x: 0, y: 1 }),
        pxW,
        pxH,
      });
    }

    // text
    const tc = await page.getTextContent({ includeMarkedContent: false });
    const raw: RawText[] = [];
    let gp = 0;
    for (const item of tc.items as any[]) {
      // Whitespace-only runs are dropped; mergeRuns re-inserts spaces from the gaps.
      if (typeof item.str !== 'string' || !item.str.trim()) continue;
      // colour and visibility: walk the glyph stream in parallel
      let color = '#000000';
      let invisible = false;
      const first = item.str.trim()[0];
      for (let look = gp; look < Math.min(glyphColors.length, gp + 60); look++) {
        if (glyphColors[look].ch === first || glyphColors[look].ch.startsWith(first)) {
          color = glyphColors[look].color;
          invisible = glyphColors[look].invisible;
          gp = look + item.str.replace(/\s/g, '').length;
          break;
        }
      }
      const t = item.transform as Mat;
      const origin = apply(userToDrawing, { x: t[4], y: t[5] });
      const dv = applyVec(userToDrawing, { x: t[0], y: t[1] });
      const up = applyVec(userToDrawing, { x: t[2], y: t[3] });
      const dl = Math.hypot(dv.x, dv.y) || 1;
      const size = Math.hypot(up.x, up.y) || (item.height ?? 10) * PT_TO_MM;
      const widthScale = matScale(userToDrawing);
      raw.push({
        str: item.str,
        origin,
        dir: { x: dv.x / dl, y: dv.y / dl },
        size,
        width: (item.width ?? 0) * widthScale,
        color,
        font: tc.styles?.[item.fontName]?.fontFamily ?? 'sans-serif',
        invisible,
      });
    }
    for (const r of mergeRuns(raw)) {
      const text = r.str.replace(/\s+$/, '').replace(/^\s+/, '');
      if (!text) continue;
      const te: TextEntity = {
        kind: 'text',
        id: newId('t'),
        style: { layer: 'TEXT', color: r.color },
        text,
        pos: r.origin,
        fontSize: r.size,
        rotation: Math.atan2(r.dir.y, r.dir.x),
        width: r.width > 0 ? r.width : r.size * 0.55 * text.length,
        widthExact: r.width > 0,
        align: 'left',
        fontFamily: r.font,
      };
      if (r.invisible) te.ocr = true;
      entities.push(te);
    }

    // Letter shapes under OCR text are that text: they keep being drawn, but are
    // not part of the geometry (no blocks, not exported to DXF next to the TEXT).
    const outlines = markTextOutlines(entities);

    // repeated geometry -> blocks
    let finalEntities = entities;
    let blocks = {};
    if (opts.detectBlocks !== false) {
      const det = detectBlocks(entities.filter((e) => !outlines.has(e)));
      finalEntities = [...det.entities, ...entities.filter((e) => outlines.has(e))];
      blocks = det.blocks;
    }

    const stats = emptyStats();
    countEntities(finalEntities, stats);
    stats.blocks = Object.keys(blocks).length;

    stats.texts = finalEntities.filter((e) => e.kind === 'text').length;
    const texts = finalEntities.filter((e): e is TextEntity => e.kind === 'text');
    if (!texts.length) {
      warnings.push('No text found on this page. Turn on "Read text with OCR first" to read text that is drawn as outlines or scanned.');
    }
    if (pendingImages.length && !opts.encodeImage) warnings.push('Images were found but not decoded.');

    return {
      name,
      source: 'pdf',
      entities: finalEntities,
      blocks,
      bounds: drawingBounds(finalEntities, blocks),
      geometryUnit: 'mm',
      detectedDimensionUnit: guessDimensionUnit(texts.map((t) => t.text), 'mm'),
      pdf: { bytes, pageIndex, pageCount: doc.numPages, userToDrawing },
      stats,
      warnings,
    };
  } finally {
    await task.destroy();
  }
}
