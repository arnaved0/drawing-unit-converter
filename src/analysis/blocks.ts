// Finds repeated groups of geometry (bolt heads, holes with centre marks,
// terminals ...) in an exploded drawing and turns them into block definitions
// with one INSERT per occurrence, like a CAD user would have drawn them.
//
// Method: entities with a distinctive shape (circles, closed polylines,
// curves) are grouped by shape. Each group gives candidate offsets. Nearby
// entities that appear at every offset, translated, join the block.

import { emptyBox, entityBox, flattenSegs } from '../geom';
import { newId, type Block, type Entity, type Pt } from '../model';

const Q = 0.02; // quantisation step in drawing units
const q = (v: number) => Math.round(v / Q);

function shapeKey(e: Entity, o: Pt): string | null {
  const s = `${e.style.color}|${e.style.fill ?? ''}|${(e.style.dash ?? []).map(q).join(',')}|`;
  const p = (pt: Pt) => `${q(pt.x - o.x)},${q(pt.y - o.y)}`;
  switch (e.kind) {
    case 'line': {
      const a = p(e.a);
      const b = p(e.b);
      return s + 'L' + (a < b ? a + ';' + b : b + ';' + a);
    }
    case 'circle':
      return s + `C${p(e.c)};${q(e.r)}`;
    case 'arc':
      return s + `A${p(e.c)};${q(e.r)};${Math.round(e.start * 100)};${Math.round(e.end * 100)}`;
    case 'polyline':
      return s + 'P' + (e.closed ? 'c' : 'o') + e.pts.map((v) => p(v) + ':' + Math.round((v.bulge ?? 0) * 1000)).join(';');
    case 'solid':
      return s + 'S' + e.pts.map(p).join(';');
    case 'curve':
      return s + 'K' + flattenSegs(e.start, e.segs, 4).map(p).join(';');
    default:
      return null;
  }
}

/** Reference point used to align instances. */
function refPoint(e: Entity): Pt | null {
  switch (e.kind) {
    case 'circle': return e.c;
    case 'polyline': return e.closed && e.pts.length >= 3 ? e.pts[0] : null;
    case 'curve': return e.start;
    default: return null;
  }
}

export interface BlockDetection {
  entities: Entity[];
  blocks: Record<string, Block>;
}

export function detectBlocks(entities: Entity[], minInstances = 2): BlockDetection {
  const shapes = entities.filter((e) => e.kind !== 'text' && e.kind !== 'image' && e.kind !== 'insert');
  const boxes = new Map<Entity, ReturnType<typeof emptyBox>>();
  for (const e of shapes) boxes.set(e, entityBox(e, {}));

  // spatial grid for neighbour lookups
  let cell = 1;
  {
    const sizes = shapes
      .filter((e) => refPoint(e))
      .map((e) => {
        const b = boxes.get(e)!;
        return Math.max(b.maxX - b.minX, b.maxY - b.minY);
      })
      .sort((a, b) => a - b);
    cell = Math.max(1, sizes[Math.floor(sizes.length / 2)] ?? 10) * 2;
  }
  const grid = new Map<string, Entity[]>();
  const cellKey = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const e of shapes) {
    const b = boxes.get(e)!;
    const k = cellKey((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(e);
  }
  const near = (x0: number, y0: number, x1: number, y1: number): Entity[] => {
    const out: Entity[] = [];
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
        const list = grid.get(`${gx},${gy}`);
        if (list) out.push(...list);
      }
    }
    return out;
  };

  // group seeds by shape
  const groups = new Map<string, { e: Entity; o: Pt }[]>();
  for (const e of shapes) {
    const o = refPoint(e);
    if (!o) continue;
    const k = shapeKey(e, o)!;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push({ e, o });
  }

  const used = new Set<Entity>();
  const replaced = new Map<Entity, Entity | null>(); // entity -> insert (first member) or null (removed)
  const blocks: Record<string, Block> = {};
  const ordered = [...groups.values()].filter((g) => g.length >= minInstances && g.length <= 2000).sort((a, b) => b.length - a.length);

  for (const group of ordered) {
    const inst = group.filter((g) => !used.has(g.e));
    if (inst.length < minInstances) continue;
    const seedBox = boxes.get(inst[0].e)!;
    const size = Math.max(seedBox.maxX - seedBox.minX, seedBox.maxY - seedBox.minY);
    const reach = size * 1.0;
    const neighbourhood = (o: Pt, seed: Entity): Entity[] => {
      const dx = o.x - inst[0].o.x;
      const dy = o.y - inst[0].o.y;
      return near(seedBox.minX + dx - reach, seedBox.minY + dy - reach, seedBox.maxX + dx + reach, seedBox.maxY + dy + reach).filter((e) => {
        if (used.has(e)) return false;
        if (e === seed) return true;
        const b = boxes.get(e)!;
        return b.minX >= seedBox.minX + dx - reach && b.maxX <= seedBox.maxX + dx + reach && b.minY >= seedBox.minY + dy - reach && b.maxY <= seedBox.maxY + dy + reach;
      });
    };
    // signatures around every instance
    const perInstance = inst.map(({ e, o }) => {
      const m = new Map<string, Entity>();
      for (const n of neighbourhood(o, e)) {
        const k = shapeKey(n, o);
        if (k && !m.has(k)) m.set(k, n);
      }
      return m;
    });
    const members: string[] = [];
    for (const k of perInstance[0].keys()) if (perInstance.every((m) => m.has(k))) members.push(k);
    if (members.length < 2) continue;

    const name = `BLOCK_${Object.keys(blocks).length + 1}`;
    const base = inst[0].o;
    blocks[name] = { name, base: { ...base }, entities: members.map((k) => perInstance[0].get(k)!) };
    inst.forEach(({ o }, i) => {
      const ins: Entity = { kind: 'insert', id: newId(), style: { layer: 'BLOCKS', color: '#000000' }, block: name, pos: { ...o }, sx: 1, sy: 1, rotation: 0 };
      members.forEach((k, j) => {
        const ent = perInstance[i].get(k)!;
        used.add(ent);
        replaced.set(ent, j === 0 ? ins : null);
      });
    });
  }

  if (!Object.keys(blocks).length) return { entities, blocks };
  const out: Entity[] = [];
  for (const e of entities) {
    if (!replaced.has(e)) out.push(e);
    else {
      const r = replaced.get(e);
      if (r) out.push(r);
    }
  }
  return { entities: out, blocks };
}
