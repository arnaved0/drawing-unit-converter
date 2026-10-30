// Drawing model -> DXF R12 (AC1009). R12 is the simplest DXF flavour and is
// read by every CAD program (AutoCAD, BricsCAD, LibreCAD, DraftSight, Fusion,
// SolidWorks ...). Curves that are not arcs are written as polylines.

import { hexToAci } from '../aci';
import { flattenSegs, normAngle } from '../geom';
import type { Dimension } from '../dimensions';
import type { Drawing, Entity, Pt, Style, TextEntity } from '../model';
import { layoutText } from '../render/svg';
import { encodeR12Text } from '../textcodes';

/** Cap height / em size for the Arial-like fonts PDFs mostly use. */
const CAP_PER_EM = 0.716;

class Writer {
  private out: string[] = [];
  pair(code: number, value: string | number): void {
    this.out.push(String(code).padStart(3, ' '));
    if (typeof value === 'string') this.out.push(value);
    else this.out.push(isIntCode(code) ? String(Math.round(value)) : num(value));
  }
  toString(): string {
    return this.out.length ? this.out.join('\r\n') + '\r\n' : '';
  }
}

/** DXF group codes whose values are integers (AutoCAD rejects "1.0" there). */
function isIntCode(c: number): boolean {
  return (c >= 60 && c <= 99) || (c >= 170 && c <= 179) || (c >= 270 && c <= 289) || (c >= 370 && c <= 389) || (c >= 400 && c <= 409) || (c >= 1060 && c <= 1071);
}

function num(v: number): string {
  if (!Number.isFinite(v)) return '0.0';
  const s = (Math.abs(v) < 1e-10 ? 0 : v).toFixed(6).replace(/0+$/, '');
  return s.endsWith('.') ? s + '0' : s;
}

function layerName(s: string): string {
  const n = s.replace(/[<>/\\":;?*|=,`]/g, '_').trim();
  return n || '0';
}

interface Ctx {
  w: Writer;
  ltypes: Map<string, number[]>;
  layers: Set<string>;
}

function ltypeFor(st: Style, ctx: Ctx): string | null {
  if (!st.dash?.length) return null;
  const pattern = st.dash.map((d) => Math.max(0, d));
  if (pattern.length % 2) pattern.push(...pattern);
  const key = pattern.map((p) => p.toFixed(3)).join(',');
  for (const [name, p] of ctx.ltypes) if (p.map((x) => x.toFixed(3)).join(',') === key) return name;
  const name = `DASH${ctx.ltypes.size + 1}`;
  ctx.ltypes.set(name, pattern);
  return name;
}

function common(ctx: Ctx, type: string, st: Style): void {
  const layer = layerName(st.layer);
  ctx.layers.add(layer);
  ctx.w.pair(0, type);
  ctx.w.pair(8, layer);
  const lt = ltypeFor(st, ctx);
  if (lt) ctx.w.pair(6, lt);
  ctx.w.pair(62, hexToAci(st.color));
}

function xy(ctx: Ctx, base: number, p: Pt): void {
  ctx.w.pair(base, p.x);
  ctx.w.pair(base + 10, p.y);
  ctx.w.pair(base + 20, 0);
}

function polyline(ctx: Ctx, st: Style, pts: { x: number; y: number; bulge?: number }[], closed: boolean): void {
  if (pts.length < 2) return;
  common(ctx, 'POLYLINE', st);
  ctx.w.pair(66, 1);
  xy(ctx, 10, { x: 0, y: 0 });
  ctx.w.pair(70, closed ? 1 : 0);
  for (const p of pts) {
    ctx.w.pair(0, 'VERTEX');
    ctx.w.pair(8, layerName(st.layer));
    xy(ctx, 10, p);
    if (p.bulge) ctx.w.pair(42, p.bulge);
  }
  ctx.w.pair(0, 'SEQEND');
  ctx.w.pair(8, layerName(st.layer));
}

function text(ctx: Ctx, t: TextEntity, str: string, pos: Pt, align: TextEntity['align']): void {
  const st = { ...t.style };
  common(ctx, 'TEXT', st);
  xy(ctx, 10, pos);
  ctx.w.pair(40, t.fontSize * CAP_PER_EM);
  ctx.w.pair(1, encodeR12Text(str));
  const deg = (normAngle(t.rotation) * 180) / Math.PI;
  if (Math.abs(deg) > 1e-6) ctx.w.pair(50, deg);
  if (align !== 'left') {
    ctx.w.pair(72, align === 'center' ? 1 : 2);
    xy(ctx, 11, pos);
  }
}

const isWhite = (hex?: string | null) => !!hex && /^#(f[0-9a-f]){3}$/i.test(hex);

function entity(ctx: Ctx, e: Entity, dimsByText: Map<string, Dimension[]>): void {
  const st = e.style;
  // White fills are paper-coloured masks/backgrounds in PDFs; in CAD they would show up as solid areas.
  if (st.stroke === false && isWhite(st.fill ?? st.color) && e.kind !== 'text') return;
  switch (e.kind) {
    case 'line':
      common(ctx, 'LINE', st);
      xy(ctx, 10, e.a);
      xy(ctx, 11, e.b);
      break;
    case 'polyline':
      polyline(ctx, st, e.pts, e.closed);
      break;
    case 'circle':
      common(ctx, 'CIRCLE', st);
      xy(ctx, 10, e.c);
      ctx.w.pair(40, e.r);
      break;
    case 'arc':
      common(ctx, 'ARC', st);
      xy(ctx, 10, e.c);
      ctx.w.pair(40, e.r);
      ctx.w.pair(50, (normAngle(e.start) * 180) / Math.PI);
      ctx.w.pair(51, (normAngle(e.end) * 180) / Math.PI);
      break;
    case 'curve': {
      const pts = flattenSegs(e.start, e.segs, 16);
      polyline(ctx, st, e.closed ? pts.slice(0, -1) : pts, e.closed);
      break;
    }
    case 'solid': {
      const p = e.pts;
      common(ctx, 'SOLID', st);
      // SOLID corner order is 1, 2, 4, 3
      xy(ctx, 10, p[0]);
      xy(ctx, 11, p[1]);
      xy(ctx, 12, p.length === 4 ? p[3] : p[2]);
      xy(ctx, 13, p[2]);
      break;
    }
    case 'text': {
      const dims = dimsByText.get(e.id);
      const lay = dims ? layoutText(e, dims) : null;
      text(ctx, e, lay ? lay.text : e.text, lay ? lay.pos : e.pos, lay ? lay.align : e.align);
      break;
    }
    case 'image': {
      // R12 has no raster images: keep the frame so the position is not lost.
      const p11 = { x: e.p10.x + e.p01.x - e.p00.x, y: e.p10.y + e.p01.y - e.p00.y };
      polyline(ctx, { ...st, layer: 'IMAGES' }, [e.p00, e.p10, p11, e.p01], true);
      break;
    }
    case 'insert':
      common(ctx, 'INSERT', st);
      ctx.w.pair(2, layerName(e.block));
      xy(ctx, 10, e.pos);
      if (e.sx !== 1) ctx.w.pair(41, e.sx);
      if (e.sy !== 1) ctx.w.pair(42, e.sy);
      if (e.rotation) ctx.w.pair(50, (e.rotation * 180) / Math.PI);
      break;
  }
}

export function writeDxfR12(d: Drawing, dims: Dimension[]): string {
  const dimsByText = new Map<string, Dimension[]>();
  for (const dim of dims) {
    const l = dimsByText.get(dim.textId) ?? [];
    l.push(dim);
    dimsByText.set(dim.textId, l);
  }
  // Entities first (collects layers and linetypes), then assemble the file.
  const ent: Ctx = { w: new Writer(), ltypes: new Map(), layers: new Set(['0']) };
  for (const e of d.entities) entity(ent, e, dimsByText);
  const blk: Ctx = { w: new Writer(), ltypes: ent.ltypes, layers: ent.layers };
  for (const b of Object.values(d.blocks)) {
    blk.w.pair(0, 'BLOCK');
    blk.w.pair(8, '0');
    blk.w.pair(2, layerName(b.name));
    blk.w.pair(70, 0);
    xy(blk, 10, b.base);
    blk.w.pair(3, layerName(b.name));
    for (const e of b.entities) entity(blk, e, new Map());
    blk.w.pair(0, 'ENDBLK');
    blk.w.pair(8, '0');
  }

  const w = new Writer();
  const b = d.bounds;
  w.pair(0, 'SECTION');
  w.pair(2, 'HEADER');
  w.pair(9, '$ACADVER');
  w.pair(1, 'AC1009');
  w.pair(9, '$INSBASE');
  xy({ w } as Ctx, 10, { x: 0, y: 0 });
  w.pair(9, '$EXTMIN');
  xy({ w } as Ctx, 10, { x: b.minX, y: b.minY });
  w.pair(9, '$EXTMAX');
  xy({ w } as Ctx, 10, { x: b.maxX, y: b.maxY });
  w.pair(9, '$LTSCALE');
  w.pair(40, 1);
  w.pair(0, 'ENDSEC');

  w.pair(0, 'SECTION');
  w.pair(2, 'TABLES');
  w.pair(0, 'TABLE');
  w.pair(2, 'LTYPE');
  w.pair(70, ent.ltypes.size + 1);
  w.pair(0, 'LTYPE');
  w.pair(2, 'CONTINUOUS');
  w.pair(70, 0);
  w.pair(3, 'Solid line');
  w.pair(72, 65);
  w.pair(73, 0);
  w.pair(40, 0);
  for (const [name, pattern] of ent.ltypes) {
    w.pair(0, 'LTYPE');
    w.pair(2, name);
    w.pair(70, 0);
    w.pair(3, 'Dash pattern from PDF');
    w.pair(72, 65);
    w.pair(73, pattern.length);
    w.pair(40, pattern.reduce((a, v) => a + v, 0));
    pattern.forEach((v, i) => w.pair(49, i % 2 === 0 ? v : -v));
  }
  w.pair(0, 'ENDTAB');
  w.pair(0, 'TABLE');
  w.pair(2, 'LAYER');
  w.pair(70, ent.layers.size);
  for (const l of ent.layers) {
    w.pair(0, 'LAYER');
    w.pair(2, l);
    w.pair(70, 0);
    w.pair(62, 7);
    w.pair(6, 'CONTINUOUS');
  }
  w.pair(0, 'ENDTAB');
  w.pair(0, 'TABLE');
  w.pair(2, 'STYLE');
  w.pair(70, 1);
  w.pair(0, 'STYLE');
  w.pair(2, 'STANDARD');
  w.pair(70, 0);
  w.pair(40, 0);
  w.pair(41, 1);
  w.pair(50, 0);
  w.pair(71, 0);
  w.pair(42, 2.5);
  w.pair(3, 'arial.ttf');
  w.pair(4, '');
  w.pair(0, 'ENDTAB');
  w.pair(0, 'ENDSEC');

  return (
    w.toString() +
    ['  0', 'SECTION', '  2', 'BLOCKS', ''].join('\r\n') +
    blk.w.toString() +
    ['  0', 'ENDSEC', '  0', 'SECTION', '  2', 'ENTITIES', ''].join('\r\n') +
    ent.w.toString() +
    ['  0', 'ENDSEC', '  0', 'EOF', ''].join('\r\n')
  );
}
