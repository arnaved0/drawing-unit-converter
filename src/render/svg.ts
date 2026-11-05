// Drawing model -> SVG markup for the preview.
// Geometry is drawn inside <g transform="scale(1,-1)"> so drawing
// coordinates (y up) are used directly.

import { displayColor } from '../aci';
import { bulgeArc, insertMatrix, textCorners, type Mat } from '../geom';
import type { Dimension, DisplayText } from '../dimensions';
import { displayText, isStandaloneDimension, replaceStart } from '../dimensions';
import type { Drawing, Entity, PathSeg, Pt, Style, TextEntity, Vertex } from '../model';
import { advance, getFace } from '../fonts/faces';

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

/** CSS font-family of a text: its matched face, else a generic family like the original. */
function cssFamily(t: TextEntity): string {
  if (t.face) {
    const face = getFace(t.face);
    return `'${face.css}', ${face.generic}`;
  }
  return /serif|mono/i.test(t.fontFamily ?? '') && !/sans/i.test(t.fontFamily ?? '') ? t.fontFamily! : 'Arial, Helvetica, sans-serif';
}

/** Advance width of `s` written like text `t` (its face, size and width factor), in drawing units. */
export function textAdvance(t: TextEntity, s: string): number {
  if (t.face) return advance(getFace(t.face), s) * t.fontSize * (t.hscale ?? 1);
  return (t.width / Math.max(1, [...t.text].length)) * [...s].length;
}

export function textSvg(t: TextEntity, text = t.text, pos = t.pos, align = t.align, extraClass = ''): string {
  const deg = (t.rotation * 180) / Math.PI;
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
  // width factor and lean, so the text has the original's proportions
  const skew = t.slant ? ` skewX(${f((Math.atan(t.slant) * 180) / Math.PI)})` : '';
  const hs = t.hscale && t.hscale !== 1 ? t.hscale : 1;
  return `<text class="t ${extraClass}" transform="translate(${f(pos.x)} ${f(pos.y)}) rotate(${f(deg)})${skew} scale(${f(hs)} -1)" font-size="${f(t.fontSize)}" text-anchor="${anchor}" font-family="${esc(cssFamily(t))}" fill="${displayColor(t.style.color)}" xml:space="preserve">${esc(text)}</text>`;
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
  const width = display.changed ? textAdvance(t, display.text) : t.width;
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
  const cut = Math.min(...conv.map((d) => replaceStart(d, t.text)));
  const lay = layoutText(t, dims);
  // a drawn box is covered whole, so all of its text is written again
  if (cut === 0 || t.cover?.length || isStandaloneDimension(t.text, dims)) return { from: 0, text: lay.text, pos: lay.pos, align: lay.align };
  // where the value starts: the width of the text before it, in the text's own font
  const shift = Math.min(t.width, t.face ? textAdvance(t, t.text.slice(0, cut)) : (t.width * cut) / Math.max(1, t.text.length));
  const from = shift / Math.max(t.width, 1e-9);
  return {
    from,
    text: lay.text.slice(cut),
    pos: { x: t.pos.x + Math.cos(t.rotation) * shift, y: t.pos.y + Math.sin(t.rotation) * shift },
    align: 'left',
  };
}

/**
 * White areas laid over the original letters when an OCR or boxed value is
 * converted: the line from the first converted value on (a little taller than
 * the text, so ascenders, descenders and anti-aliasing are covered too). For a
 * box the user drew, exactly the drawn region: nothing outside it is covered.
 */
export function coverPolygons(t: TextEntity, patch: OcrPatch): Pt[][] {
  if (t.cover?.length) return [t.cover];
  const dx = Math.cos(t.rotation);
  const dy = Math.sin(t.rotation);
  const shift = t.align === 'center' ? -t.width / 2 : t.align === 'right' ? -t.width : 0;
  const padX = 0.12 * t.fontSize;
  const u0 = shift + t.width * patch.from - (patch.from > 0 ? padX / 2 : padX);
  const u1 = shift + t.width + padX;
  const v0 = -0.34 * t.fontSize;
  const v1 = 1.0 * t.fontSize;
  const at = (u: number, v: number): Pt => ({ x: t.pos.x + dx * u - dy * v, y: t.pos.y + dy * u + dx * v });
  return [[at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]];
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

/** A converted text's position after the user moved it with its handle. */
export function movedPos(t: TextEntity, p: Pt): Pt {
  return t.offset ? { x: p.x + t.offset.x, y: p.y + t.offset.y } : p;
}

/** Where the move handle of a converted text sits: just before the start of the new text. */
export function handlePoint(t: TextEntity, drawn: { text: string; pos: Pt; align: TextEntity['align'] }): Pt {
  const w = textAdvance(t, drawn.text);
  const back = drawn.align === 'center' ? w / 2 : drawn.align === 'right' ? w : 0;
  const dx = Math.cos(t.rotation);
  const dy = Math.sin(t.rotation);
  const u = -back - 0.75 * t.fontSize;
  const v = 0.35 * t.fontSize;
  return { x: drawn.pos.x + dx * u - dy * v, y: drawn.pos.y + dy * u + dx * v };
}

/** Corners of a line of text written like `t` at `pos`. */
function drawnCorners(t: TextEntity, drawn: { text: string; pos: Pt; align: TextEntity['align'] }): Pt[] {
  const w = textAdvance(t, drawn.text);
  const u0 = drawn.align === 'center' ? -w / 2 : drawn.align === 'right' ? -w : 0;
  const dx = Math.cos(t.rotation);
  const dy = Math.sin(t.rotation);
  const at = (u: number, v: number): Pt => ({ x: drawn.pos.x + dx * u - dy * v, y: drawn.pos.y + dy * u + dx * v });
  return [at(u0, -0.25 * t.fontSize), at(u0 + w, -0.25 * t.fontSize), at(u0 + w, t.fontSize), at(u0, t.fontSize)];
}

/**
 * The move handle of a converted text. `near` is the area it belongs to (the
 * original's box and the new text, drawing coordinates): it is only shown
 * while the pointer is on or near that area.
 */
function handleSvg(t: TextEntity, drawn: { text: string; pos: Pt; align: TextEntity['align'] }, area: Pt[]): string {
  const p = handlePoint(t, drawn);
  const pts = [...area, ...drawnCorners(t, drawn), p];
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const near = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(f).join(' ');
  // drawn in screen pixels (scaled by --hairn) so it stays the same size at any zoom
  return (
    `<g class="handle" data-handle="${t.id}" data-near="${near}" transform="translate(${f(p.x)} ${f(p.y)})"><g class="handle-in">` +
    `<circle r="8"/><path d="M0 -5.5V5.5M-5.5 0H5.5M0 -5.5l-2 2M0 -5.5l2 2M0 5.5l-2-2M0 5.5l2-2M-5.5 0l2-2M-5.5 0l2 2M5.5 0l-2-2M5.5 0l-2 2"/>` +
    `<title>Drag to move the converted text</title></g></g>`
  );
}

/** Where the rotate handle of a drawn box sits: the middle of its top edge, and the box's angle. */
export function rotateHandlePoint(cover: Pt[]): { p: Pt; angle: number } {
  return { p: { x: (cover[2].x + cover[3].x) / 2, y: (cover[2].y + cover[3].y) / 2 }, angle: Math.atan2(cover[1].y - cover[0].y, cover[1].x - cover[0].x) };
}

/**
 * The rotate handle of a box the user drew: a short stem up from the middle of
 * its top edge with a round grip, in screen pixels. Shown near the box, like
 * the move handles.
 */
export function rotateHandleSvg(id: string, cover: Pt[], extra = ''): string {
  const { p, angle } = rotateHandlePoint(cover);
  const xs = cover.map((q) => q.x);
  const ys = cover.map((q) => q.y);
  const near = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(f).join(' ');
  return (
    `<g class="handle rot${extra}" data-rotate="${id}" data-near="${near}" transform="translate(${f(p.x)} ${f(p.y)}) rotate(${f((angle * 180) / Math.PI)})"><g class="handle-in">` +
    `<line x1="0" y1="0" x2="0" y2="14"/><circle cy="20" r="6"/><path d="M-3 20a3 3 0 1 1 3 3M0 23l-1.8-1.6M0 23l-1.6 1.8"/>` +
    `<title>Drag to turn the box</title></g></g>`
  );
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
  const handles: string[] = [];
  for (const e of d.entities) {
    if (e.kind !== 'text') continue;
    const list = byText.get(e.id);
    if (!list) continue;
    const layout = layoutText(e, list);
    let drawn: { text: string; pos: Pt; align: TextEntity['align'] } | null = null;
    const area: Pt[] = [];
    if (e.ocr) {
      const patch = ocrPatch(e, list);
      if (patch) {
        // the white-out stays over the original; only the new text moves
        for (const mask of coverPolygons(e, patch)) {
          area.push(...mask);
          texts.push(`<polygon class="mask" points="${mask.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}"/>`);
        }
        drawn = { text: patch.text, pos: movedPos(e, patch.pos), align: patch.align };
        texts.push(textSvg(e, drawn.text, drawn.pos, drawn.align, 'converted'));
      }
    } else if (layout.display.changed) {
      drawn = { text: layout.text, pos: movedPos(e, layout.pos), align: layout.align };
      texts.push(textSvg(e, drawn.text, drawn.pos, drawn.align, 'converted'));
    } else texts.push(textSvg(e, layout.text, layout.pos, layout.align, ''));
    for (const dim of list) {
      // a box the user drew stays the box they drew
      const poly = e.cover && list.length === 1 ? e.cover : dimPolygon(e, layout, dim.id);
      area.push(...poly);
      const cls = `dim${dim.converted ? ' converted' : ''}${showHighlights ? '' : ' quiet'}`;
      overlays.push(`<polygon class="${cls}" data-dim="${dim.id}" points="${poly.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}"><title>${esc(dim.original)}${dim.converted ? ' → ' + esc(dim.converted.text) : ''}</title></polygon>`);
    }
    if (drawn) handles.push(handleSvg(e, drawn, area));
    // a box the user drew can be turned to follow an angled dimension
    if (e.manual && e.cover?.length === 4) handles.push(rotateHandleSvg(e.id, e.cover));
  }
  // handles on top, so they can be grabbed where they overlap a box
  return { texts: texts.join(''), overlays: overlays.join('') + handles.join('') };
}
