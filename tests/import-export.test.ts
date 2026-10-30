import { describe, expect, it } from 'vitest';
import DxfParser from 'dxf-parser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';
import { convertDimension, detectDimensions, type Dimension } from '../src/dimensions';
import { patchDxf } from '../src/export/dxfPatch';
import { writeDxfR12 } from '../src/export/dxfR12';
import { exportPdfOverlay, exportPdfPlot } from '../src/export/pdf';
import { importDwg } from '../src/importers/dwg';
import { importDxf } from '../src/importers/dxf';
import type { Drawing, TextEntity } from '../src/model';
import { DEFAULT_SETTINGS } from '../src/units';
import { loadPdf, readSample } from './helpers';

const IN2 = { ...DEFAULT_SETTINGS, target: 'in' as const, decimals: 2 };

function convertAll(d: Drawing, dims: Dimension[], match?: (s: string) => boolean): Dimension[] {
  const texts = new Map(d.entities.filter((e): e is TextEntity => e.kind === 'text').map((t) => [t.id, t]));
  for (const dim of dims) if (!match || match(dim.original)) convertDimension(dim, texts.get(dim.textId)!.text, IN2, d.detectedDimensionUnit);
  return dims;
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  return (tc.items as any[]).map((i) => i.str).join('|');
}

describe('PDF import', () => {
  it('recognises shapes, text, colours and blocks', async () => {
    const d = await loadPdf('flange-heater.pdf');
    expect(d.stats.circles).toBeGreaterThanOrEqual(13); // flange circles + 8 bolt holes + view circle
    expect(d.stats.solids).toBeGreaterThan(5); // arrowheads
    expect(d.stats.blocks).toBe(1); // the 8 hex bolt heads
    expect(d.stats.inserts).toBe(8);
    const texts = d.entities.filter((e): e is TextEntity => e.kind === 'text').map((t) => t.text);
    expect(texts).toContain('241. 3mm'); // written one character at a time
    expect(texts).toContain('Dia\uff1a'); // CJK font
    const red = d.entities.find((e): e is TextEntity => e.kind === 'text' && e.text === 'ID>=8mm');
    expect(red?.style.color).toBe('#d91a1a');
    const rotated = d.entities.find((e): e is TextEntity => e.kind === 'text' && e.text === 'Dia 215.9 mm');
    expect(Math.round(((rotated?.rotation ?? 0) * 180) / Math.PI)).toBe(90);
    expect(d.detectedDimensionUnit).toBe('mm');
  });

  it('turns Bezier arcs back into arcs', async () => {
    const d = await loadPdf('defrost-heater.pdf');
    expect(d.stats.arcs).toBe(6);
    expect(d.stats.curves).toBe(0);
  });

  it('finds the dimensions of the example drawings', async () => {
    const d = await loadPdf('defrost-heater.pdf');
    expect(detectDimensions(d).map((x) => x.original)).toEqual(['88.9', '88.9', '127', '152.4', '38.1', '8', '305mm', '8mm']);
    const a = await loadPdf('arc-element.pdf');
    expect(detectDimensions(a).map((x) => x.original)).toEqual(['11.2 mm', '330.2mm', '25. 4mm', '610.61 mm', '10. 9mm']);
  });
});

describe('PDF export', () => {
  it('writes converted values onto the original page', async () => {
    const d = await loadPdf('defrost-heater.pdf');
    const dims = convertAll(d, detectDimensions(d));
    const { bytes } = await exportPdfOverlay(d, dims);
    const text = await pdfText(bytes);
    expect(text).toContain('3.50 in');
    expect(text).toContain('6.00 in');
    expect(text).toContain('12.01in Silicone wire leads');
  });

  it('keeps CJK neighbours by replacing only the value', async () => {
    const d = await loadPdf('arc-element.pdf');
    const dims = convertAll(d, detectDimensions(d));
    const { bytes } = await exportPdfOverlay(d, dims);
    expect(await pdfText(bytes)).toContain('13.00in');
  });
});

describe('DXF', () => {
  it('imports dimensions with links to the file', () => {
    const d = importDxf(readSample('plate.dxf'), 'plate.dxf');
    const dims = detectDimensions(d);
    expect(dims.map((x) => `${x.original}:${x.kind}`)).toEqual(['150:linear', '80:linear', '20:radius', '30:diameter', '6mm:linear', '8.5mm:diameter']);
    const t = d.entities.find((e): e is TextEntity => e.kind === 'text' && e.text === '150');
    expect(t?.dxf?.dimHandle).toBeTruthy();
    expect(d.entities.filter((e) => e.kind === 'insert' && e.block === 'BOLT')).toHaveLength(4);
  });

  it('patches converted values into the original file', () => {
    const src = readSample('plate.dxf');
    const d = importDxf(src, 'plate.dxf');
    const dims = convertAll(d, detectDimensions(d));
    const out = patchDxf(d, dims);
    const parsed: any = new DxfParser().parseSync(new TextDecoder().decode(out));
    const dimEnts = parsed.entities.filter((e: any) => e.type === 'DIMENSION');
    // raw AutoCAD codes (%%c = Ø) are kept; the angular dimension keeps its measured text "<>"
    expect(dimEnts.map((e: any) => e.text)).toEqual(['5.91 in', '3.15 in', 'R0.79 in', '%%c1.18 in', '<>']);
    const notes = parsed.entities.filter((e: any) => e.type === 'TEXT' || e.type === 'MTEXT').map((e: any) => e.text);
    expect(notes).toContain('Plate 0.24in thick, 304SS');
    expect(notes).toContain('Thr holes\\PDia 0.33in(X4)');
    // block text of the dimension is patched as well
    const re = importDxf(out, 'x.dxf');
    expect(re.entities.filter((e): e is TextEntity => e.kind === 'text' && !!e.isDimension).map((t) => t.text)).toEqual(['5.91 in', '3.15 in', 'R0.79 in', '\u00d81.18 in', '60\u00b0']);
    // nothing else changed
    expect(out.length - src.length).toBeLessThan(400);
  });

  it('writes a readable DXF R12', () => {
    const d = importDxf(readSample('plate.dxf'), 'plate.dxf');
    const dims = convertAll(d, detectDimensions(d));
    const r12 = writeDxfR12(d, dims);
    const parsed: any = new DxfParser().parseSync(r12);
    expect(parsed.header.$ACADVER).toBe('AC1009');
    const texts = parsed.entities.filter((e: any) => e.type === 'TEXT').map((e: any) => e.text);
    expect(texts).toContain('5.91 in');
    expect(texts).toContain('%%c1.18 in');
    expect(Object.keys(parsed.blocks)).toContain('BOLT');
  });

  it('plots a DXF to PDF', async () => {
    const d = importDxf(readSample('plate.dxf'), 'plate.dxf');
    const dims = convertAll(d, detectDimensions(d));
    const { bytes } = await exportPdfPlot(d, dims);
    const text = await pdfText(bytes);
    expect(text).toContain('5.91 in');
    expect(text).toContain('Plate 0.24in thick, 304SS');
  });
});

describe('PDF -> DXF', () => {
  it('exports recognised geometry, blocks and converted text', async () => {
    const d = await loadPdf('flange-heater.pdf');
    const dims = convertAll(d, detectDimensions(d), (s) => s === '939.8mm');
    const parsed: any = new DxfParser().parseSync(writeDxfR12(d, dims));
    const types = parsed.entities.map((e: any) => e.type);
    expect(types).toContain('CIRCLE');
    expect(types).toContain('SOLID');
    expect(types.filter((t: string) => t === 'INSERT')).toHaveLength(8);
    const texts = parsed.entities.filter((e: any) => e.type === 'TEXT').map((e: any) => e.text);
    expect(texts).toContain('37.00in');
    expect(texts).toContain('Dia:');
  });
});

describe('DWG', () => {
  const wasmDir = fileURLToPath(new URL('../node_modules/@mlightcad/libredwg-web/wasm', import.meta.url));
  it('reads a DWG through LibreDWG and patches its dimensions', async () => {
    const bytes = readSample('third-party/libredwg-example_2000.dwg');
    const d = await importDwg(bytes, 'example.dwg', wasmDir);
    expect(d.source).toBe('dwg');
    const dims = detectDimensions(d);
    expect(dims.length).toBe(8); // the angular dimension (108°) is excluded
    convertAll(d, dims, (s) => s === '449,6');
    const out = patchDxf(d, dims);
    const re = importDxf(out, 'x.dxf');
    expect(re.entities.some((e) => e.kind === 'text' && e.text === '17,70 in')).toBe(true);
  });
});
