import { describe, expect, it } from 'vitest';
import { arrange, type InkMap } from '../src/layout/arrange';
import { convertDimension, detectDimensions } from '../src/dimensions';
import { drawnCorners, basePlacement, movedPos, sized } from '../src/render/svg';
import { emptyStats, type Drawing, type TextEntity } from '../src/model';
import { DEFAULT_SETTINGS } from '../src/units';

/** A 200 x 100 unit sheet drawn at 4 px per unit, with vertical lines at the given x. */
function sheet(linesX: number[], textAt: { x: number; y: number }, text: string): { d: Drawing; map: InkMap } {
  const W = 800;
  const H = 400;
  const ink = new Uint8Array(W * H);
  for (const lx of linesX) for (let y = 0; y < H; y++) ink[y * W + Math.round(lx * 4)] = 1;
  const t: TextEntity = {
    kind: 'text', id: 't1', style: { layer: 'TEXT', color: '#000' }, text, pos: textAt, fontSize: 5, rotation: 0,
    width: 5 * 0.55 * text.length, widthExact: false, align: 'center', isDimension: true,
  };
  const d: Drawing = {
    name: 'x', source: 'dxf', entities: [t], blocks: {}, bounds: { minX: 0, minY: 0, maxX: 200, maxY: 100 },
    geometryUnit: 'mm', detectedDimensionUnit: 'mm', stats: emptyStats(), warnings: [],
  };
  return { d, map: { width: W, height: H, ink, toGrid: [4, 0, 0, -4, 0, 400] } };
}

/** Map pixels of `poly`'s box that are ink. */
function inkUnder(map: InkMap, poly: { x: number; y: number }[]): number {
  const xs = poly.map((p) => p.x * 4);
  let n = 0;
  for (let x = Math.ceil(Math.min(...xs)); x <= Math.floor(Math.max(...xs)); x++) if (map.ink[200 * map.width + x]) n++;
  return n;
}

const IN = { ...DEFAULT_SETTINGS, target: 'in' as const, decimals: 2 };

describe('arranging converted values', () => {
  it('leaves a value that fits where it was', () => {
    const { d, map } = sheet([20, 180], { x: 100, y: 50 }, '254');
    const dims = detectDimensions(d);
    convertDimension(dims[0], '254', IN, 'mm');
    expect(arrange(d, dims, map, { pageShown: false, bounds: d.bounds })).toBe(0);
    expect((d.entities[0] as TextEntity).offset).toBeUndefined();
  });

  it('moves a longer value off a line it would cross', () => {
    // extension line just right of the original text; "10.00 in" is much longer than "254"
    const { d, map } = sheet([20, 106], { x: 100, y: 50 }, '254');
    const t = d.entities[0] as TextEntity;
    const dims = detectDimensions(d);
    convertDimension(dims[0], '254', IN, 'mm');
    const base = basePlacement(t, dims, false)!;
    const before = drawnCorners(t, { text: base.text, pos: base.pos, align: base.align });
    expect(Math.max(...before.map((p) => p.x))).toBeGreaterThan(106); // it would cross the line
    expect(arrange(d, dims, map, { pageShown: false, bounds: d.bounds })).toBe(1);
    expect(t.placedBy).toBe('auto');
    const sz = sized(t, movedPos(t, base.pos), base);
    const after = drawnCorners(sz.t, { text: base.text, pos: sz.pos, align: base.align });
    const xs = after.map((p) => p.x);
    expect(Math.max(...xs) < 106 || Math.min(...xs) > 106).toBe(true);
  });

  it('leaves values the user placed alone', () => {
    const { d, map } = sheet([20, 106], { x: 100, y: 50 }, '254');
    const t = d.entities[0] as TextEntity;
    t.placedBy = 'user';
    const dims = detectDimensions(d);
    convertDimension(dims[0], '254', IN, 'mm');
    expect(arrange(d, dims, map, { pageShown: false, bounds: d.bounds })).toBe(0);
    expect(t.offset).toBeUndefined();
    expect(inkUnder(map, [{ x: 0, y: 0 }])).toBe(0);
  });
});
