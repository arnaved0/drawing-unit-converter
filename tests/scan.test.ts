import { beforeAll, describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { convertDimension, detectDimensions } from '../src/dimensions';
import { exportPdfOverlay } from '../src/export/pdf';
import { DEFAULT_SETTINGS } from '../src/units';
import { writeDxfR12 } from '../src/export/dxfR12';
import { countEntities, emptyStats, type Drawing, type Entity, type TextEntity } from '../src/model';
import { cleanOcrText, type OcrModels } from '../src/scan/ocr';
import { processScan, type ScanResult } from '../src/scan/pipeline';
import DxfParser from 'dxf-parser';
import { loadPdf } from './helpers';
import { loadModels, renderSample } from './scan-helpers';

const DPI = 200;
let models: OcrModels;
const results: Record<string, ScanResult> = {};

async function scan(name: string): Promise<ScanResult> {
  if (!results[name]) {
    const img = await renderSample(`scanned/${name}-scan.pdf`, DPI);
    results[name] = await processScan(models, img, { pxPerMm: DPI / 25.4, pageHeightMm: (img.height / DPI) * 25.4 });
  }
  return results[name];
}

function asDrawing(name: string, r: ScanResult): Drawing {
  const stats = emptyStats();
  countEntities(r.entities, stats);
  return { name, source: 'pdf', entities: r.entities, blocks: {}, bounds: { minX: 0, minY: 0, maxX: 420, maxY: 297 }, geometryUnit: 'mm', detectedDimensionUnit: r.detectedUnit, stats, warnings: [] };
}

const kinds = (es: Entity[]) => {
  const k: Record<string, number> = {};
  for (const e of es) k[e.kind] = (k[e.kind] ?? 0) + 1;
  return k;
};

beforeAll(async () => {
  models = await loadModels();
}, 60000);

describe('scanned PDF detection', () => {
  it('flags image-only pages as scans', async () => {
    const d = await loadPdf('scanned/flange-heater-scan.pdf');
    expect(d.scan).toBeTruthy();
    expect(d.pdf?.imagePx).toBeGreaterThan(5);
    const v = await loadPdf('flange-heater.pdf');
    expect(v.scan).toBeUndefined();
  });
});

describe('OCR of scanned drawings', () => {
  it('reads every dimension of the flange heater', async () => {
    const d = asDrawing('flange', await scan('flange-heater'));
    const dims = detectDimensions(d).map((x) => x.original.replace(/\s+/g, ' '));
    for (const v of ['939.8mm', '152.4mm', '23.9', '1.6mm', '8mm', '381mm', '148mm', '165.1mm', '219.1mm', '215.9mm', '241.3mm', '279.4mm', '22.3mm', '215.9 mm', '12mm']) {
      expect(dims).toContain(v);
    }
    // not lengths
    const texts = d.entities.filter((e): e is TextEntity => e.kind === 'text').map((t) => t.text);
    expect(texts).toContain('3/4"NPT Gland');
    expect(texts).toContain('480V 3PH 27KW');
    expect(d.detectedDimensionUnit).toBe('mm');
  }, 120000);

  it('reads vertical and slanted text', async () => {
    const d = asDrawing('defrost', await scan('defrost-heater'));
    expect(detectDimensions(d).map((x) => x.original).sort()).toEqual(['127', '152.4', '305mm', '38.1', '8', '88.9', '88.9', '8mm'].sort());
    const vertical = d.entities.filter((e): e is TextEntity => e.kind === 'text' && e.text === '38.1')[0];
    expect(Math.round((vertical.rotation * 180) / Math.PI)).toBeGreaterThan(80);
    expect(vertical.style.color).not.toBe('#000000'); // red in the drawing
    const a = asDrawing('arc', await scan('arc-element'));
    const ad = detectDimensions(a).map((x) => x.original);
    for (const v of ['610.61mm', '330.2mm', '25.4mm', '10.9mm', '11.2mm']) expect(ad).toContain(v);
    // CJK labels are read too
    expect(a.entities.some((e) => e.kind === 'text' && e.text.includes('紧固件'))).toBe(true);
  }, 120000);
});

describe('PDF output for scans', () => {
  it('writes converted values onto the scan and keeps the scanned text before them', async () => {
    const d = await loadPdf('scanned/flange-heater-scan.pdf');
    const r = await scan('flange-heater');
    d.entities = r.entities;
    d.scan = { href: '', pxPerMm: DPI / 25.4, processed: true, ocrLines: r.ocrLines, traced: r.traced, skewDeg: r.skewDeg };
    const dims = detectDimensions(d);
    const texts = new Map(d.entities.filter((e): e is TextEntity => e.kind === 'text').map((t) => [t.id, t]));
    for (const dim of dims) convertDimension(dim, texts.get(dim.textId)!.text, { ...DEFAULT_SETTINGS, target: 'in', decimals: 2 }, 'mm');
    const { bytes } = await exportPdfOverlay(d, dims);
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    const out = (tc.items as any[]).map((i) => i.str).join('|');
    expect(out).toContain('37.00in');
    expect(out).toContain('0.88in(X8)');
    // only the part from the value on is redrawn, so misread words before it are not written
    expect(out).not.toMatch(/sheath/i);
  }, 120000);
});

describe('poor scans', () => {
  it('reads the dimensions of a tilted, low-resolution copy on grey, unevenly lit paper', async () => {
    const img = await renderSample('scanned/flange-heater-photocopy.pdf', DPI);
    const r = await processScan(models, img, { pxPerMm: DPI / 25.4, pageHeightMm: (img.height / DPI) * 25.4 });
    const dims = detectDimensions(asDrawing('photocopy', r)).map((x) => x.original.replace(/\s+/g, ' '));
    const expected = ['939.8mm', '152.4mm', '23.9', '1.6mm', '8mm', '381mm', '148mm', '165.1mm', '219.1mm', '215.9mm', '241.3mm', '279.4mm', '22.3mm', '12mm'];
    const found = expected.filter((v) => dims.includes(v));
    expect(found.length).toBeGreaterThanOrEqual(expected.length - 1);
    expect(Math.abs(r.skewDeg)).toBeGreaterThan(0.8); // the 1.2° tilt is noticed
  }, 120000);
});

describe('tracing scanned line work', () => {
  it('rebuilds circles, dashed circles and arrowheads of the flange view', async () => {
    const r = await scan('flange-heater');
    const k = kinds(r.entities);
    const circles = r.entities.filter((e) => e.kind === 'circle') as Extract<Entity, { kind: 'circle' }>[];
    // flange (279.4 / 215.9 dia on paper ~ 84 / 56 mm) outer + inner + dashed bolt circle + 8 holes
    expect(circles.filter((c) => c.r > 30).length).toBeGreaterThanOrEqual(3);
    expect(circles.filter((c) => c.r > 1.5 && c.r < 3).length).toBeGreaterThanOrEqual(8);
    expect(circles.some((c) => c.style.dash && c.r > 30)).toBe(true);
    expect(k.solid ?? 0).toBeGreaterThanOrEqual(6);
    // red circle of the terminal box view keeps its colour
    expect(circles.some((c) => c.r > 40 && c.style.color !== '#000000')).toBe(true);
  }, 120000);

  it('rebuilds the tube bends of the defrost heater as arcs and its arrowheads', async () => {
    const r = await scan('defrost-heater');
    const k = kinds(r.entities);
    expect(k.arc ?? 0).toBeGreaterThanOrEqual(6);
    expect(k.solid ?? 0).toBeGreaterThanOrEqual(12);
    expect(k.line ?? 0).toBeGreaterThan(30);
  }, 120000);

  it('exports traced geometry and text to DXF', async () => {
    const d = asDrawing('defrost', await scan('defrost-heater'));
    const parsed: any = new DxfParser().parseSync(writeDxfR12(d, detectDimensions(d)));
    const types = new Set(parsed.entities.map((e: any) => e.type));
    for (const t of ['LINE', 'ARC', 'SOLID', 'TEXT']) expect(types.has(t)).toBe(true);
  }, 120000);
});

describe('OCR clean-up', () => {
  it('fixes common misreads in numbers', () => {
    expect(cleanOcrText('86:0°')).toBe('86.0°');
    expect(cleanOcrText('1O.9mm')).toBe('10.9mm');
    expect(cleanOcrText('l52.4')).toBe('152.4');
    expect(cleanOcrText('Φ12')).toBe('\u00d812');
    expect(cleanOcrText('Silicone')).toBe('Silicone');
  });
});
