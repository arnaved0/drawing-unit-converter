import { describe, expect, it } from 'vitest';
import DxfParser from 'dxf-parser';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { convertDimension, detectDimensions, findLengthTokens, replacementText, type Dimension } from '../src/dimensions';
import { writeDxfR12 } from '../src/export/dxfR12';
import { exportPdfPages } from '../src/export/pdf';
import { importPdf, type PdfJs } from '../src/importers/pdf';
import type { Drawing, TextEntity } from '../src/model';
import { renderDimensionLayer } from '../src/render/svg';
import { DEFAULT_SETTINGS } from '../src/units';
import { loadPdf, readSample } from './helpers';

const IN = { ...DEFAULT_SETTINGS, target: 'in' as const, decimals: 2 };
const dim = (text: string): Dimension => {
  const t = findLengthTokens(text)[0];
  return { ...t, id: 'd', textId: 't', original: text.slice(t.start, t.end) };
};
const texts = (d: Drawing) => d.entities.filter((e): e is TextEntity => e.kind === 'text');
function convertWhere(d: Drawing, pick: (s: string) => boolean): Dimension[] {
  const dims = detectDimensions(d);
  const byId = new Map(texts(d).map((t) => [t.id, t]));
  for (const x of dims) if (pick(x.original)) convertDimension(x, byId.get(x.textId)!.text, IN, 'mm');
  return dims;
}
async function pdfText(bytes: Uint8Array, page: number): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const tc = await (await doc.getPage(page)).getTextContent();
  return (tc.items as any[]).map((i) => i.str).join('|');
}

describe('settings for one dimension', () => {
  it('uses text typed by the user as it is', () => {
    expect(replacementText({ ...dim('88.9'), override: { text: '3-1/2 IN.' } }, '88.9', IN, 'mm')).toBe('3-1/2 IN.');
  });
});

describe('moving converted text', () => {
  it('moves the new text and its handle, but not the white-out', async () => {
    const d = await loadPdf('defrost-heater.pdf');
    const dims = convertWhere(d, (s) => s === '127');
    const t = texts(d).find((x) => x.text === '127')!;
    const before = renderDimensionLayer(d, dims, true);
    expect(before.overlays).toContain(`data-handle="${t.id}"`);
    t.offset = { x: 10, y: 5 };
    const after = renderDimensionLayer(d, dims, true);
    const pos = (svg: string) => /translate\(([-\d.]+) ([-\d.]+)\) rotate[^>]*>5\.00 in</.exec(svg)!.slice(1).map(Number);
    const [x0, y0] = pos(before.texts);
    const [x1, y1] = pos(after.texts);
    expect(x1 - x0).toBeCloseTo(10, 3);
    expect(y1 - y0).toBeCloseTo(5, 3);
    // the original text is still covered in place (non-OCR text: the old text is simply not drawn)
    const parsed: any = new DxfParser().parseSync(writeDxfR12(d, dims));
    const moved = parsed.entities.find((e: any) => e.type === 'TEXT' && e.text === '5.00 in');
    const orig = t.pos;
    expect(Math.abs(moved.startPoint.x - orig.x - 10)).toBeLessThan(t.width + 0.01);
    expect(moved.startPoint.y - orig.y).toBeCloseTo(5, 3);
  });

  it('keeps a drawn box covered when its text is moved', async () => {
    const d = await loadPdf('defrost-heater.pdf');
    const { addBoxedText, textFromBox } = await import('../src/boxes');
    const box = { minX: 300, maxX: 330, minY: 20, maxY: 32 };
    const edit = addBoxedText(d, [], box, textFromBox('25.4', box));
    d.entities = edit.entities;
    const t = texts(d).find((x) => x.manual)!;
    convertDimension(edit.dims[0], t.text, IN, 'mm');
    t.offset = { x: 40, y: 40 };
    const layer = renderDimensionLayer(d, edit.dims, true);
    expect(layer.texts).toContain('<polygon class="mask" points="300,20 330,20 330,32 300,32"/>');
  });
});

describe('several pages', () => {
  it('writes the conversions of every page into one PDF', async () => {
    // a two-page PDF: defrost heater, then flange heater
    const out = await PDFDocument.create();
    for (const f of ['defrost-heater.pdf', 'flange-heater.pdf']) {
      const src = await PDFDocument.load(readSample(f));
      const [p] = await out.copyPages(src, [0]);
      out.addPage(p);
    }
    const bytes = new Uint8Array(await out.save());
    const load = (i: number) => importPdf(pdfjs as unknown as PdfJs, bytes, 'two.pdf', { pageIndex: i });
    const p0 = await load(0);
    const p1 = await load(1);
    const d0 = convertWhere(p0, (s) => s === '127');
    const d1 = convertWhere(p1, (s) => s === '939.8mm');
    const res = await exportPdfPages(bytes, [{ d: p0, dims: d0 }, { d: p1, dims: d1 }]);
    expect(await pdfText(res.bytes, 1)).toContain('5.00 in');
    expect(await pdfText(res.bytes, 2)).toContain('37.00in');
    expect(await pdfText(res.bytes, 1)).not.toContain('37.00in');
  });
});
