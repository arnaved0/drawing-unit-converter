import { beforeAll, describe, expect, it } from 'vitest';
import DxfParser from 'dxf-parser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { convertDimension, detectDimensions } from '../src/dimensions';
import { writeDxfR12 } from '../src/export/dxfR12';
import { exportPdfOverlay } from '../src/export/pdf';
import { TEXT_OUTLINES, type Drawing, type TextEntity } from '../src/model';
import { normaliseOcrText, type PreprocessResult } from '../src/ocr/preprocess';
import { renderGeometry, renderDimensionLayer } from '../src/render/svg';
import { DEFAULT_SETTINGS } from '../src/units';
import { readSample } from './helpers';
import { importBytes, loadModels, ocrSample } from './ocr-helpers';

const cache: Record<string, PreprocessResult> = {};
async function ocr(name: string) {
  return (cache[name] ??= await ocrSample(name));
}
const texts = (d: Drawing) => d.entities.filter((e): e is TextEntity => e.kind === 'text');
const dimsOf = (d: Drawing) => detectDimensions(d).map((x) => x.original);
function convertAll(d: Drawing) {
  const dims = detectDimensions(d);
  const byId = new Map(texts(d).map((t) => [t.id, t]));
  for (const x of dims) convertDimension(x, byId.get(x.textId)!.text, { ...DEFAULT_SETTINGS, target: 'in', decimals: 2 }, 'mm');
  return dims;
}

beforeAll(async () => {
  await loadModels();
}, 60000);

describe('Scan & OCR before import', () => {
  it('a PDF with text drawn as outlines has no dimensions without OCR', async () => {
    const d = await importBytes(readSample('outlined/flange-heater-outlined.pdf'), 'x');
    expect(dimsOf(d)).toEqual([]);
  });

  it('turns outlined text into real text and finds every dimension of the flange heater', async () => {
    const res = await ocr('outlined/flange-heater-outlined.pdf');
    expect(res.added).toBeGreaterThan(30);
    const d = await importBytes(res.bytes, 'x');
    const dims = dimsOf(d);
    for (const v of ['939.8mm', '152.4mm', '23.9', '1.6mm', '8mm', '381 mm', '148mm', '165.1mm', '219.1mm', '215.9mm', '241.3mm', '279.4mm', '22.3mm', '215.9 mm', '12mm']) {
      expect(dims).toContain(v);
    }
    // things that are not lengths stay unconverted
    expect(texts(d).map((t) => t.text)).toContain('3/4"NPT Gland');
    expect(texts(d).find((t) => t.text === '381 mm')?.style.color).not.toBe('#000000'); // red
  }, 120000);

  it('reads vertical and slanted dimensions', async () => {
    const d = await importBytes((await ocr('outlined/defrost-heater-outlined.pdf')).bytes, 'x');
    expect(dimsOf(d).sort()).toEqual(['127', '152.4', '305mm', '38.1', '8', '88.9', '88.9', '8mm'].sort());
    const a = await importBytes((await ocr('outlined/arc-element-outlined.pdf')).bytes, 'x');
    const ad = dimsOf(a).map((s) => s.replace(/\s/g, ''));
    for (const v of ['610.61mm', '330.2mm', '25.4mm', '10.9mm', '11.2mm']) expect(ad).toContain(v);
    // angles keep their degree sign, so they are not treated as lengths
    expect(ad).not.toContain('112');
  }, 120000);

  it('adds nothing to a PDF that already has real text', async () => {
    const res = await ocr('flange-heater.pdf');
    expect(res.added).toBe(0);
    expect(res.alreadyText).toBeGreaterThan(30);
  }, 120000);

  it('leaves the page looking exactly as before and makes it searchable', async () => {
    const res = await ocr('outlined/flange-heater-outlined.pdf');
    const doc = await pdfjs.getDocument({ data: res.bytes.slice() }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    expect((tc.items as any[]).map((i) => i.str).join(' ')).toContain('939.8mm');
    const ops = await (await doc.getPage(1)).getOperatorList();
    expect(ops.fnArray).toContain(pdfjs.OPS.setTextRenderingMode); // invisible (mode 3) text layer
  }, 120000);
});

describe('working with OCR text', () => {
  it('marks the letter shapes it covers and keeps them out of the DXF', async () => {
    const d = await importBytes((await ocr('outlined/defrost-heater-outlined.pdf')).bytes, 'x');
    const outlines = d.entities.filter((e) => e.style.layer === TEXT_OUTLINES);
    expect(outlines.length).toBeGreaterThan(80);
    // arrowheads are not mistaken for letters
    expect(d.entities.filter((e) => e.kind === 'solid' && e.pts.length === 3 && e.style.layer === TEXT_OUTLINES)).toHaveLength(0);
    const dims = convertAll(d);
    const parsed: any = new DxfParser().parseSync(writeDxfR12(d, dims));
    const dxfTexts = parsed.entities.filter((e: any) => e.type === 'TEXT').map((e: any) => e.text);
    expect(dxfTexts).toContain('3.50 in');
    expect(dxfTexts).toContain('Defrost tubular heater');
    // letter outlines are not exported next to the TEXT entities
    expect(parsed.entities.filter((e: any) => e.type === 'POLYLINE').length).toBeLessThan(20);
  }, 120000);

  it('does not draw OCR text twice in the preview; converted values are drawn on a white patch', async () => {
    const d = await importBytes((await ocr('outlined/defrost-heater-outlined.pdf')).bytes, 'x');
    const dims = detectDimensions(d);
    expect(renderGeometry(d, new Set())).not.toContain('Defrost tubular heater');
    expect(renderDimensionLayer(d, dims, true).texts).toBe('');
    const conv = convertAll(d);
    const layer = renderDimensionLayer(d, conv, true).texts;
    expect(layer).toContain('class="mask"');
    expect(layer).toContain('3.50 in');
  }, 120000);

  it('writes converted values into the PDF and keeps the rest of the line as it was', async () => {
    const d = await importBytes((await ocr('outlined/flange-heater-outlined.pdf')).bytes, 'x');
    const { bytes } = await exportPdfOverlay(d, convertAll(d));
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    const visible = (tc.items as any[]).map((i) => i.str).join('|');
    expect(visible).toContain('37.00in');
    expect(visible).toContain('0.88in(X8)');
  }, 120000);
});

describe('OCR text clean-up', () => {
  it('normalises full-width punctuation and splits a label from the value below it', () => {
    expect(normaliseOcrText('Dia：')).toBe('Dia:');
    expect(normaliseOcrText('C-Z11.2mm')).toBe('C-Z 11.2mm');
    expect(normaliseOcrText('R25.4mm')).toBe('R25.4mm');
    expect(normaliseOcrText('紧固件')).toBeNull();
  });
});

describe('letters with holes', () => {
  it('keeps the holes of outlined letters (no black blobs)', async () => {
    const d = await importBytes(readSample('outlined/flange-heater-outlined.pdf'), 'x');
    const compound = d.entities.filter((e) => e.kind === 'curve' && (e.more?.length ?? 0) > 0);
    expect(compound.length).toBeGreaterThan(30); // 0, 4, 6, 8, 9, A, B, D, P, R ...
    expect(renderGeometry(d, new Set())).toContain('fill-rule:nonzero');
  });
});
