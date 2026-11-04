// Drawing model -> SVG markup for the preview.
// Geometry is drawn inside <g transform="scale(1,-1)"> so drawing
// coordinates (y up) are used directly.

import { displayColor } from '../aci';
import { bulgeArc, insertMatrix, textCorners, type Mat } from '../geom';
import type { Dimension, DisplayText } from '../dimensions';
import { displayText, isStandaloneDimension } from '../dimensions';
import type { Drawing, Entity, PathSeg, Pt, Style, TextEntity, Vertex } from '../model';

const f = (v: number) => (Math.abs(v) < 1e-9 ? '0' : +v.toFixed(4) + '');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function strokeStyle(s: Style, filled = false): string {
  const color = displayColor(s.color);
  const parts: string[] = [];
  if (s.stroke === false) parts.push('stroke:none');
  else {
    parts.push(`stroke:${color}`);
    const lw = s.lineWidth ?? 0;
    parts.push(lw > 0 ? `stroke-width:max(var(--hair),${f(lw)}px)` : 'stroke-width:var(--hair)');
    if (s.dash?.length) parts.push(`stroke-dasharray:${s.dash.map((d) => f(Math.max(d, 0))).join(' ')}`);
  }
  parts.push(filled && s.fill ? `fill:${displayColor(s.fill)}` : 'fill:none');
  return parts.join(';');
}

function arcSvg(from: Pt, to: Pt, bulge: number): string {
  const a = bulgeArc(from, to, bulge);
  const large = Math.abs(a.sweep) > Math.PI ? 1 : 0;
  const sweep = a.sweep > 0 ? 1 : 0;
  return `A${f(a.r)} ${f(a.r)} 0 ${large} ${sweep} ${f(to.x)} ${f(to.y)}`;
}

function polyD(pts: Vertex[], closed: boolean): string {
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  const n = pts.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    d += a.bulge ? arcSvg(a, b, a.bulge) : `L${f(b.x)} ${f(b.y)}`;
  }
  return closed ? d + 'Z' : d;
}

function segsD(start: Pt, segs: PathSeg[], closed: boolean): string {
  let d = `M${f(start.x)} ${f(start.y)}`;
  let cur = start;
  for (const s of segs) {
    if (s.t === 'L') d += `L${f(s.p.x)} ${f(s.p.y)}`;
    else if (s.t === 'A') d += arcSvg(cur, s.p, s.bulge);
    else d += `C${f(s.c1.x)} ${f(s.c1.y)} ${f(s.c2.x)} ${f(s.c2.y)} ${f(s.p.x)} ${f(s.p.y)}`;
    cur = s.p;
  }
  return closed ? d + 'Z' : d;
}

const matAttr = (m: Mat) => `matrix(${m.map(f).join(' ')})`;

export function textSvg(t: TextEntity, text = t.text, pos = t.pos, align = t.align, extraClass = ''): string {
  const deg = (t.rotation * 180) / Math.PI;
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
  const family = /serif|mono/i.test(t.fontFamily ?? '') && !/sans/i.test(t.fontFamily ?? '') ? t.fontFamily : 'Arial, Helvetica, sans-serif';
  return `<text class="t ${extraClass}" transform="translate(${f(pos.x)} ${f(pos.y)}) rotate(${f(deg)}) scale(1 -1)" font-size="${f(t.fontSize)}" text-anchor="${anchor}" font-family="${esc(family!)}" fill="${displayColor(t.style.color)}" xml:space="preserve">${esc(text)}</text>`;
}

export function entitySvg(e: Entity): string {
  switch (e.kind) {
    case 'line':
      return `<line x1="${f(e.a.x)}" y1="${f(e.a.y)}" x2="${f(e.b.x)}" y2="${f(e.b.y)}" style="${strokeStyle(e.style)}"/>`;
    case 'polyline':
      return e.pts.length < 2 ? '' : `<path d="${polyD(e.pts, e.closed)}" style="${strokeStyle(e.style, e.closed)}"/>`;
    case 'circle':
      return `<circle cx="${f(e.c.x)}" cy="${f(e.c.y)}" r="${f(e.r)}" style="${strokeStyle(e.style, true)}"/>`;
    case 'arc': {
      let sweep = e.end - e.start;
      while (sweep <= 0) sweep += 2 * Math.PI;
      const a = { x: e.c.x + e.r * Math.cos(e.start), y: e.c.y + e.r * Math.sin(e.start) };
      const b = { x: e.c.x + e.r * Math.cos(e.end), y: e.c.y + e.r * Math.sin(e.end) };
      return `<path d="M${f(a.x)} ${f(a.y)}A${f(e.r)} ${f(e.r)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${f(b.x)} ${f(b.y)}" style="${strokeStyle(e.style)}"/>`;
    }
    case 'curve': {
      const d = [segsD(e.start, e.segs, e.closed), ...(e.more ?? []).map((s) => segsD(s.start, s.segs, s.closed))].join('');
      const rule = e.more?.length ? `;fill-rule:${e.evenOdd ? 'evenodd' : 'nonzero'}` : '';
      return `<path d="${d}" style="${strokeStyle(e.style, true)}${rule}"/>`;
    }
    case 'solid': {
      const fill = displayColor(e.style.fill ?? e.style.color);
      return `<polygon points="${e.pts.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}" style="fill:${fill};stroke:${fill};stroke-width:var(--hair)"/>`;
    }
    case 'text':
      return textSvg(e);
    case 'image': {
      const m: Mat = [e.p10.x - e.p00.x, e.p10.y - e.p00.y, e.p00.x - e.p01.x, e.p00.y - e.p01.y, e.p01.x, e.p01.y];
      if (!e.href) {
        return `<rect width="1" height="1" transform="${matAttr(m)}" style="fill:#eee;stroke:#999;stroke-width:var(--hair)"/>`;
      }
      return `<image href="${e.href}" width="1" height="1" preserveAspectRatio="none" transform="${matAttr(m)}"/>`;
    }
    case 'insert':
      return ''; // handled by renderGeometry, which knows the blocks
  }
}

const blockId = (name: string) => 'blk-' + name.replace(/[^A-Za-z0-9_-]/g, (c) => '_' + c.charCodeAt(0).toString(16));

/** Static part of the drawing: all geometry plus texts that hold no dimension. */
export function renderGeometry(d: Drawing, skipTextIds: Set<string>): string {
  const defs: string[] = [];
  for (const b of Object.values(d.blocks)) {
    defs.push(`<g id="${blockId(b.name)}">${b.entities.map((e) => (e.kind === 'insert' ? insertSvg(e, d) : entitySvg(e))).join('')}</g>`);
  }
  const body = d.entities
    // OCR text is invisible: the letters it reads are already drawn (outlines or image)
    .filter((e) => !(e.kind === 'text' && (skipTextIds.has(e.id) || e.ocr)))
    .map((e) => (e.kind === 'insert' ? insertSvg(e, d) : entitySvg(e)))
    .join('');
  return `<defs>${defs.join('')}</defs>${body}`;
}

function insertSvg(e: Extract<Entity, { kind: 'insert' }>, d: Drawing): string {
  const b = d.blocks[e.block];
  if (!b) return '';
  return `<use href="#${blockId(e.block)}" transform="${matAttr(insertMatrix(e.pos, e.rotation, e.sx, e.sy, b.base))}"/>`;
}

export interface TextLayout {
  text: string;
  pos: Pt;
  align: TextEntity['align'];
  /** Estimated width of the displayed text. */
  width: number;
  display: DisplayText;
}

/**
 * Where a (possibly converted) text goes. A text that is only a dimension
 * stays centred on its original position when its length changes.
 */
export function layoutText(t: TextEntity, dims: Dimension[]): TextLayout {
  const display = displayText(t.text, dims);
  const perChar = t.width / Math.max(1, [...t.text].length);
  const width = display.changed ? perChar * [...display.text].length : t.width;
  if (!display.changed || t.align === 'center' || !isStandaloneDimension(t.text, dims)) {
    return { text: display.text, pos: t.pos, align: t.align, width, display };
  }
  const shift = t.align === 'right' ? -t.width / 2 : t.width / 2;
  const pos = { x: t.pos.x + Math.cos(t.rotation) * shift, y: t.pos.y + Math.sin(t.rotation) * shift };
  return { text: display.text, pos, align: 'center', width, display };
}

export interface OcrPatch {
  /** Fraction of the text's width where the redrawn part starts. */
  from: number;
  text: string;
  pos: Pt;
  align: TextEntity['align'];
}

/**
 * For OCR text, the original letters stay visible (outlines or image). A
 * conversion covers the line from its first converted value to the end and
 * redraws only that part, so text before it keeps its original look and an
 * OCR misread elsewhere in the line never reaches the output.
 */
export function ocrPatch(t: TextEntity, dims: Dimension[]): OcrPatch | null {
  const conv = dims.filter((d) => d.converted);
  if (!conv.length) return null;
  const cut = Math.min(...conv.map((d) => d.start));
  const lay = layoutText(t, dims);
  if (cut === 0 || isStandaloneDimension(t.text, dims)) return { from: 0, text: lay.text, pos: lay.pos, align: lay.align };
  const from = cut / Math.max(1, t.text.length);
  const shift = t.width * from;
  return {
    from,
    text: lay.text.slice(cut),
    pos: { x: t.pos.x + Math.cos(t.rotation) * shift, y: t.pos.y + Math.sin(t.rotation) * shift },
    align: 'left',
  };
}

/** Polygon (drawing coordinates) around dimension `dimId` in a laid-out text. */
export function dimPolygon(t: TextEntity, layout: TextLayout, dimId: string): Pt[] {
  const r = layout.display.ranges.get(dimId);
  const n = Math.max(1, layout.display.text.length);
  const from = r ? r.start / n : 0;
  const to = r ? r.end / n : 1;
  const pad = 0.12 * t.fontSize / Math.max(layout.width, 1e-9);
  const tmp: TextEntity = { ...t, pos: layout.pos, align: layout.align };
  return textCorners(tmp, Math.max(0, from - pad), Math.min(1, to + pad), layout.width);
}

/** Dynamic part: texts that hold dimensions, plus the clickable highlight boxes. */
export function renderDimensionLayer(d: Drawing, dims: Dimension[], showHighlights: boolean): { texts: string; overlays: string } {
  const byText = new Map<string, Dimension[]>();
  for (const dim of dims) {
    let l = byText.get(dim.textId);
    if (!l) byText.set(dim.textId, (l = []));
    l.push(dim);
  }
  const texts: string[] = [];
  const overlays: string[] = [];
  for (const e of d.entities) {
    if (e.kind !== 'text') continue;
    const list = byText.get(e.id);
    if (!list) continue;
    const layout = layoutText(e, list);
    if (e.ocr) {
      const patch = ocrPatch(e, list);
      if (patch) {
        const pad = (0.1 * e.fontSize) / Math.max(e.width, 1e-9);
        const mask = textCorners(e, Math.max(-pad, patch.from - pad / 2), 1 + pad);
        texts.push(`<polygon class="mask" points="${mask.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}"/>`);
        texts.push(textSvg(e, patch.text, patch.pos, patch.align, 'converted'));
      }
    } else texts.push(textSvg(e, layout.text, layout.pos, layout.align, layout.display.changed ? 'converted' : ''));
    for (const dim of list) {
      const poly = dimPolygon(e, layout, dim.id);
      const cls = `dim${dim.converted ? ' converted' : ''}${showHighlights ? '' : ' quiet'}`;
      overlays.push(`<polygon class="${cls}" data-dim="${dim.id}" points="${poly.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}"><title>${esc(dim.original)}${dim.converted ? ' → ' + esc(dim.converted.text) : ''}</title></polygon>`);
    }
  }
  return { texts: texts.join(''), overlays: overlays.join('') };
}
