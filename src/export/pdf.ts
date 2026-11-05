// PDF output.
// * PDF input: the original page is kept untouched. Each converted text is
//   covered with a white box and the new text is written on top, so all
//   other content stays exactly as it was.
// * DXF/DWG input: the drawing is plotted to a new vector PDF page.

import {
  appendBezierCurve,
  closePath,
  degrees,
  fill,
  lineTo,
  moveTo,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setDashPattern,
  setFillingRgbColor,
  setLineWidth,
  setStrokingRgbColor,
  StandardFonts,
  stroke,
  fillAndStroke,
  setLineCap,
  setLineJoin,
  LineCapStyle,
  LineJoinStyle,
} from 'pdf-lib';
import { displayColor } from '../aci';
import type { Dimension } from '../dimensions';
import { apply, applyVec, bulgeArc, insertMatrix, invert, matScale, mul, normAngle, textCorners, type Mat } from '../geom';
import type { Drawing, Entity, PathSeg, Pt, Style, TextEntity } from '../model';
import { coverPolygons, layoutText, ocrPatch } from '../render/svg';

function hexRgb(hex: string) {
  const v = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

function groupDims(dims: Dimension[]): Map<string, Dimension[]> {
  const m = new Map<string, Dimension[]>();
  for (const d of dims) {
    const l = m.get(d.textId) ?? [];
    l.push(d);
    m.set(d.textId, l);
  }
  return m;
}

/** Replaces characters Helvetica (WinAnsi) cannot show. Returns null if nothing is lost. */
function winAnsiSafe(font: PDFFont, s: string): { text: string; lossy: boolean } {
  let out = '';
  let lossy = false;
  for (const ch of s) {
    const c = ch === '\u2300' ? '\u00d8' : ch;
    try {
      font.encodeText(c);
      out += c;
    } catch {
      out += '?';
      lossy = true;
    }
  }
  return { text: out, lossy };
}

function polygon(page: PDFPage, pts: Pt[], color = rgb(1, 1, 1)): void {
  page.pushOperators(
    pushGraphicsState(),
    setFillingRgbColor(color.red, color.green, color.blue),
    moveTo(pts[0].x, pts[0].y),
    ...pts.slice(1).map((p) => lineTo(p.x, p.y)),
    closePath(),
    fill(),
    popGraphicsState(),
  );
}

/** PDF input: white-out the old text, write the converted text. */
export async function exportPdfOverlay(d: Drawing, dims: Dimension[]): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  if (!d.pdf) throw new Error('No PDF source.');
  const warnings: string[] = [];
  const doc = await PDFDocument.load(d.pdf.bytes, { updateMetadata: false });
  const page = doc.getPage(d.pdf.pageIndex);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const toUser = invert(d.pdf.userToDrawing);
  const scale = matScale(d.pdf.userToDrawing); // mm per PDF unit
  const byText = groupDims(dims.filter((x) => x.converted));
  const texts = d.entities.filter((e): e is TextEntity => e.kind === 'text' && byText.has(e.id));

  for (const t of texts) {
    const list = dims.filter((x) => x.textId === t.id);
    const lay = layoutText(t, list);
    const size = t.fontSize / scale;
    const dirU = applyVec(toUser, { x: Math.cos(t.rotation), y: Math.sin(t.rotation) });
    const angle = (Math.atan2(dirU.y, dirU.x) * 180) / Math.PI;
    const color = hexRgb(displayColor(t.style.color));
    const patch = t.ocr ? ocrPatch(t, list) : null;
    const safe = winAnsiSafe(font, patch ? patch.text : lay.text);

    if (patch && !safe.lossy) {
      // OCR / boxed text: cover the old value (and the whole drawn box) and write the new part
      for (const mask of coverPolygons(t, patch)) polygon(page, mask.map((p) => apply(toUser, p)));
      const w = font.widthOfTextAtSize(safe.text, size);
      const anchor = apply(toUser, patch.pos);
      const len = Math.hypot(dirU.x, dirU.y) || 1;
      const shift = patch.align === 'center' ? -w / 2 : patch.align === 'right' ? -w : 0;
      page.drawText(safe.text, { x: anchor.x + (dirU.x / len) * shift, y: anchor.y + (dirU.y / len) * shift, size, font, color, rotate: degrees(angle) });
    } else if (!safe.lossy) {
      // cover the whole original text and write the new line
      const pad = 0.08 * t.fontSize / Math.max(t.width, 1e-9);
      polygon(page, textCorners(t, -pad, 1 + pad).map((p) => apply(toUser, p)));
      const w = font.widthOfTextAtSize(safe.text, size);
      const anchor = apply(toUser, lay.pos);
      const dirN = { x: dirU.x / Math.hypot(dirU.x, dirU.y), y: dirU.y / Math.hypot(dirU.x, dirU.y) };
      const shift = lay.align === 'center' ? -w / 2 : lay.align === 'right' ? -w : 0;
      page.drawText(safe.text, { x: anchor.x + dirN.x * shift, y: anchor.y + dirN.y * shift, size, font, color, rotate: degrees(angle) });
    } else {
      // The line holds characters Helvetica lacks (CJK ...): replace only the values.
      const n = Math.max(1, t.text.length);
      for (const dim of list.filter((x) => x.converted)) {
        const from = dim.start / n;
        const to = dim.end / n;
        polygon(page, textCorners(t, from - 0.02, to + 0.02).map((p) => apply(toUser, p)));
        const startD = textCorners(t, from, to)[0];
        // textCorners()[0] is at the descender line; move up to the baseline
        const base = { x: startD.x - Math.sin(t.rotation) * 0.22 * t.fontSize, y: startD.y + Math.cos(t.rotation) * 0.22 * t.fontSize };
        const p = apply(toUser, base);
        page.drawText(winAnsiSafe(font, dim.converted!.text).text, { x: p.x, y: p.y, size, font, color, rotate: degrees(angle) });
      }
    }
  }
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, warnings };
}

// ---------------------------------------------------------------- plotting

type Op = ReturnType<typeof moveTo>;

function arcBeziers(c: Pt, r: number, a0: number, sweep: number, m: Mat): Op[] {
  const ops: Op[] = [];
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < n; i++) {
    const a = a0 + step * i;
    const b = a + step;
    const p0 = { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
    const p3 = { x: c.x + r * Math.cos(b), y: c.y + r * Math.sin(b) };
    const p1 = apply(m, { x: p0.x - k * r * Math.sin(a), y: p0.y + k * r * Math.cos(a) });
    const p2 = apply(m, { x: p3.x + k * r * Math.sin(b), y: p3.y - k * r * Math.cos(b) });
    const q3 = apply(m, p3);
    ops.push(appendBezierCurve(p1.x, p1.y, p2.x, p2.y, q3.x, q3.y));
  }
  return ops;
}

function segOps(start: Pt, segs: PathSeg[], m: Mat): Op[] {
  const s0 = apply(m, start);
  const ops: Op[] = [moveTo(s0.x, s0.y)];
  let cur = start;
  for (const s of segs) {
    if (s.t === 'L') {
      const p = apply(m, s.p);
      ops.push(lineTo(p.x, p.y));
    } else if (s.t === 'A') {
      const a = bulgeArc(cur, s.p, s.bulge);
      ops.push(...arcBeziers(a.c, a.r, a.start, a.sweep, m));
    } else {
      const c1 = apply(m, s.c1);
      const c2 = apply(m, s.c2);
      const p = apply(m, s.p);
      ops.push(appendBezierCurve(c1.x, c1.y, c2.x, c2.y, p.x, p.y));
    }
    cur = s.p;
  }
  return ops;
}

interface PlotCtx {
  page: PDFPage;
  font: PDFFont;
  ptPerUnit: number;
  lossyText: boolean;
  byText: Map<string, Dimension[]>;
  d: Drawing;
}

function paint(ctx: PlotCtx, st: Style, ops: Op[], closed: boolean, m: Mat, filled: boolean): void {
  const scale = matScale(m);
  const lw = Math.max(0.25, (st.lineWidth ?? 0) * scale);
  const c = hexRgb(displayColor(st.color));
  const fc = hexRgb(displayColor(st.fill ?? st.color));
  const doFill = filled && !!st.fill;
  const doStroke = st.stroke !== false;
  if (!doFill && !doStroke) return;
  ctx.page.pushOperators(
    pushGraphicsState(),
    setLineWidth(lw),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    setStrokingRgbColor(c.red, c.green, c.blue),
    setFillingRgbColor(fc.red, fc.green, fc.blue),
    ...(st.dash?.length ? [setDashPattern(st.dash.map((x) => Math.max(0, x) * scale), 0)] : []),
    ...ops,
    ...(closed ? [closePath()] : []),
    doFill && doStroke ? fillAndStroke() : doFill ? fill() : stroke(),
    popGraphicsState(),
  );
}

function plotEntity(ctx: PlotCtx, e: Entity, m: Mat, depth: number): void {
  switch (e.kind) {
    case 'line':
      paint(ctx, e.style, segOps(e.a, [{ t: 'L', p: e.b }], m), false, m, false);
      break;
    case 'polyline': {
      if (e.pts.length < 2) break;
      const segs: PathSeg[] = [];
      const n = e.pts.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = e.pts[i];
        const b = e.pts[(i + 1) % n];
        segs.push(a.bulge ? { t: 'A', p: b, bulge: a.bulge } : { t: 'L', p: b });
      }
      paint(ctx, e.style, segOps(e.pts[0], segs, m), e.closed, m, e.closed);
      break;
    }
    case 'circle': {
      const s = apply(m, { x: e.c.x + e.r, y: e.c.y });
      paint(ctx, e.style, [moveTo(s.x, s.y), ...arcBeziers(e.c, e.r, 0, 2 * Math.PI, m)], true, m, true);
      break;
    }
    case 'arc': {
      let sweep = normAngle(e.end - e.start);
      if (sweep < 1e-9) sweep = 2 * Math.PI;
      const s = apply(m, { x: e.c.x + e.r * Math.cos(e.start), y: e.c.y + e.r * Math.sin(e.start) });
      paint(ctx, e.style, [moveTo(s.x, s.y), ...arcBeziers(e.c, e.r, e.start, sweep, m)], false, m, false);
      break;
    }
    case 'curve': {
      // all subpaths in one path, so letter holes stay holes (non-zero winding)
      const ops = [{ start: e.start, segs: e.segs, closed: e.closed }, ...(e.more ?? [])].flatMap((sp) => [...segOps(sp.start, sp.segs, m), ...(sp.closed ? [closePath()] : [])]);
      paint(ctx, e.style, ops, false, m, true);
      break;
    }
    case 'solid': {
      const st = { ...e.style, fill: e.style.fill ?? e.style.color };
      paint(ctx, st, segOps(e.pts[0], e.pts.slice(1).map((p) => ({ t: 'L' as const, p })), m), true, m, true);
      break;
    }
    case 'text': {
      if (e.ocr) break; // only PDFs have OCR text, and they are exported by exportPdfOverlay
      const dims = ctx.byText.get(e.id);
      const lay = dims ? layoutText(e, dims) : { text: e.text, pos: e.pos, align: e.align };
      const safe = winAnsiSafe(ctx.font, lay.text);
      if (safe.lossy) ctx.lossyText = true;
      const dir = applyVec(m, { x: Math.cos(e.rotation), y: Math.sin(e.rotation) });
      const dl = Math.hypot(dir.x, dir.y) || 1;
      const size = e.fontSize * matScale(m);
      if (size < 0.5) break;
      const w = ctx.font.widthOfTextAtSize(safe.text, size);
      const p = apply(m, lay.pos);
      const shift = lay.align === 'center' ? -w / 2 : lay.align === 'right' ? -w : 0;
      ctx.page.drawText(safe.text, {
        x: p.x + (dir.x / dl) * shift,
        y: p.y + (dir.y / dl) * shift,
        size,
        font: ctx.font,
        color: hexRgb(displayColor(e.style.color)),
        rotate: degrees((Math.atan2(dir.y, dir.x) * 180) / Math.PI),
      });
      break;
    }
    case 'image':
      break; // DXF/DWG images reference external files, which a browser upload does not include
    case 'insert': {
      const b = ctx.d.blocks[e.block];
      if (!b || depth > 8) break;
      const mm = mul(m, insertMatrix(e.pos, e.rotation, e.sx, e.sy, b.base));
      for (const c of b.entities) plotEntity(ctx, c, mm, depth + 1);
      break;
    }
  }
}

const MM = 72 / 25.4;

/** DXF/DWG input: plot the drawing to an A3 sheet (or larger if needed). */
export async function exportPdfPlot(d: Drawing, dims: Dimension[]): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const doc = await PDFDocument.create();
  const b = d.bounds;
  const bw = Math.max(b.maxX - b.minX, 1e-6);
  const bh = Math.max(b.maxY - b.minY, 1e-6);
  const landscape = bw >= bh;
  const [W, H] = landscape ? [420 * MM, 297 * MM] : [297 * MM, 420 * MM];
  const margin = 10 * MM;
  const s = Math.min((W - 2 * margin) / bw, (H - 2 * margin) / bh);
  const ox = (W - bw * s) / 2 - b.minX * s;
  const oy = (H - bh * s) / 2 - b.minY * s;
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx: PlotCtx = { page, font, ptPerUnit: s, lossyText: false, byText: groupDims(dims), d };
  const m: Mat = [s, 0, 0, s, ox, oy];
  for (const e of d.entities) plotEntity(ctx, e, m, 0);
  doc.setTitle(d.name);
  doc.setProducer('Drawing Unit Converter');
  const warnings: string[] = [];
  if (ctx.lossyText) warnings.push('Some characters (for example CJK text) are not available in the PDF font and were replaced with "?".');
  return { bytes: await doc.save(), warnings };
}
