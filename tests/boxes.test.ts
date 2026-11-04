import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addBoxedText, dimensionCentre, textFromBox, textFromPlacement } from '../src/boxes';
import { convertDimension, detectDimensions } from '../src/dimensions';
import { writeDxfR12 } from '../src/export/dxfR12';
import { readRegion } from '../src/ocr/engine';
import { renderDimensionLayer } from '../src/render/svg';
import { DEFAULT_SETTINGS } from '../src/units';
import DxfParser from 'dxf-parser';
import { loadPdf, readSample } from './helpers';
import { loadModels } from './ocr-helpers';

const IN = { ...DEFAULT_SETTINGS, target: 'in' as const, decimals: 2 };

describe('adding a box by hand', () => {
  it('turns a typed value into a dimension that converts, previews and exports', async () => {
    const d = await loadPdf('defrost-heater.pdf');
    const dims = detectDimensions(d);
    const box = { minX: 300, maxX: 320, minY: 20, maxY: 26 };
    const t = textFromBox('25.4', box);
    const edit = addBoxedText(d, dims, box, t);
    const added = edit.dims.filter((x) => x.textId === t.id);
    expect(added.map((x) => x.original)).toEqual(['25.4']);
    expect(edit.dims).toHaveLength(dims.length + 1);
    d.entities = edit.entities;
    convertDimension(added[0], t.text, IN, 'mm');
    expect(added[0].converted?.text).toBe('1.00 in');
    // drawn over a white patch in the preview
    const layer = renderDimensionLayer(d, edit.dims, true).texts;
    expect(layer).toContain('class="mask"');
    expect(layer).toContain('1.00 in');
    // and written to the DXF
    const parsed: any = new DxfParser().parseSync(writeDxfR12(d, edit.dims));
    expect(parsed.entities.some((e: any) => e.type === 'TEXT' && e.text === '1.00 in')).toBe(true);
  });

  it('counts a bare number as a length inside a box, but not an angle', () => {
    const box = { minX: 0, maxX: 30, minY: 0, maxY: 5 };
    const d = { entities: [], blocks: {} } as never;
    expect(addBoxedText(d, [], box, textFromBox('C-Z 11.2', box)).dims.map((x) => x.original)).toEqual(['11.2']);
    expect(addBoxedText(d, [], box, textFromBox('86.0°', box)).dims).toEqual([]);
  });

  it('replaces a value that was read wrongly inside the box', async () => {
    const d = await loadPdf('defrost-heater.pdf');
    const dims = detectDimensions(d);
    const wrong = dims.find((x) => x.original === '127')!;
    const c = dimensionCentre(d, wrong)!;
    const box = { minX: c.x - 6, maxX: c.x + 6, minY: c.y - 3, maxY: c.y + 3 };
    const edit = addBoxedText(d, dims, box, textFromBox('128', box));
    expect(edit.replaced).toEqual([wrong.id]);
    expect(edit.dims.map((x) => x.original)).toContain('128');
    expect(edit.dims.map((x) => x.original)).not.toContain('127');
  });

  it('places a vertical box along its long side', () => {
    const t = textFromBox('88.9', { minX: 0, maxX: 4, minY: 0, maxY: 20 });
    expect(Math.round((t.rotation * 180) / Math.PI)).toBe(90);
    expect(t.width).toBe(20);
  });

  it('keeps the place of read text when the user corrects it', () => {
    const t = textFromPlacement('88.9', { origin: { x: 10, y: 10 }, across: { x: 0, y: 12 }, up: { x: -3, y: 0 } }, '#ff0000', '38.9');
    expect(Math.round((t.rotation * 180) / Math.PI)).toBe(90);
    expect(t.fontSize).toBe(3);
    expect(t.style.color).toBe('#ff0000');
    expect(t.width).toBe(12);
  });
});

describe('reading the text inside a box', () => {
  async function crop(name: string, dpi: number, x: number, y: number, w: number, h: number, pad: number) {
    const task = pdfjs.getDocument({ data: readSample(name) });
    const page = await (await task.promise).getPage(1);
    const vp = page.getViewport({ scale: dpi / 72 });
    const c = createCanvas(w + 2 * pad, h + 2 * pad);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx as never, viewport: vp, canvas: c as never, transform: [1, 0, 0, 1, -(x - pad), -(y - pad)] } as never).promise;
    const id = ctx.getImageData(0, 0, c.width, c.height);
    await task.destroy();
    return { width: id.width, height: id.height, data: id.data };
  }

  it('reads a lone vertical digit', async () => {
    const m = await loadModels();
    // the "8" beside the top tube of the defrost heater, 200 dpi
    const img = await crop('outlined/defrost-heater-outlined.pdf', 200, 1270, 1240, 60, 90, 12);
    expect((await readRegion(m, img, 12, 200 / 25.4)).map((l) => l.text)).toContain('8');
  }, 60000);

  it('reads a slanted value under a label', async () => {
    const m = await loadModels();
    const img = await crop('outlined/arc-element-outlined.pdf', 200, 2840, 1200, 130, 110, 16);
    const texts = (await readRegion(m, img, 16, 200 / 25.4)).map((l) => l.text.replace(/\s/g, ''));
    expect(texts.some((t) => t.includes('11.2mm'))).toBe(true);
  }, 60000);
});
