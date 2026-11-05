import { beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import DxfParser from 'dxf-parser';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertDimension, detectDimensions } from '../src/dimensions';
import { writeDxfR12 } from '../src/export/dxfR12';
import { exportPdfOverlay } from '../src/export/pdf';
import { advance, faceForFontName, FACES, getFace, type FaceId } from '../src/fonts/faces';
import type { Drawing, TextEntity } from '../src/model';
import { renderDimensionLayer, textSvg } from '../src/render/svg';
import { DEFAULT_SETTINGS } from '../src/units';
import { readSample } from './helpers';
import { importBytes, loadModels, nodeRenderer, ocrImport } from './ocr-helpers';

const fontDir = fileURLToPath(new URL('../public/fonts/', import.meta.url));
const loadFont = async (id: FaceId) => new Uint8Array(readFileSync(`${fontDir}${id}.ttf`));
const texts = (d: Drawing) => d.entities.filter((e): e is TextEntity => e.kind === 'text');
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

function convertAll(d: Drawing) {
  const dims = detectDimensions(d);
  const byId = new Map(texts(d).map((t) => [t.id, t]));
  for (const x of dims) convertDimension(x, byId.get(x.textId)!.text, { ...DEFAULT_SETTINGS, target: 'in', decimals: 2 }, 'mm');
  return dims;
}

/** The sizes of the text in samples/defrost-heater.pdf, which the font samples were made from. */
let truth: TextEntity[] = [];
beforeAll(async () => {
  await loadModels();
  truth = texts(await importBytes(readSample('defrost-heater.pdf'), 'x'));
}, 60000);

/** Matched faces and em size / true em size of the OCR text of a sample. */
async function fits(name: string) {
  const { d } = await ocrImport(`outlined/fonts/${name}.pdf`);
  const ocr = texts(d).filter((t) => t.ocr);
  const ratios = ocr.flatMap((t) => {
    const tr = truth.find((x) => Math.hypot(x.pos.x - t.pos.x, x.pos.y - t.pos.y) < 2);
    return tr ? [t.fontSize / tr.fontSize] : [];
  });
  return { d, faces: ocr.map((t) => t.face), ratios, hscale: median(ocr.map((t) => t.hscale ?? 1)) };
}

describe('fonts for converted values', () => {
  it('picks a lookalike face from a font name', () => {
    expect(faceForFontName('ABCDEF+ArialMT')).toBe('sans');
    expect(faceForFontName('Arial-BoldMT')).toBe('sans-bold');
    expect(faceForFontName('Helvetica')).toBe('sans');
    expect(faceForFontName('TimesNewRomanPS-BoldMT')).toBe('serif-bold');
    expect(faceForFontName('CourierNewPSMT')).toBe('mono');
    expect(faceForFontName('Verdana')).toBe('dejavu');
    expect(faceForFontName('ISOCPEUR')).toBe('iso');
    expect(faceForFontName('romans.shx')).toBe('iso');
    expect(faceForFontName('Unknown', { serif: true })).toBe('serif');
  });

  it('knows the widths of its fonts without loading them', () => {
    const render = nodeRenderer();
    void render; // registers the fonts with the canvas
    const ctx = createCanvas(10, 10).getContext('2d');
    for (const f of FACES) {
      ctx.font = `100px "${f.css}"`;
      const s = '152.4 mm Ø22.3';
      expect(advance(f, s) * 100).toBeCloseTo(ctx.measureText(s).width, -0.5); // within ~1.5 px of 700
    }
  });

  it('gives real PDF text the face its font name says, as wide as the original', async () => {
    const t = texts(await importBytes(readSample('defrost-heater.pdf'), 'x'));
    expect(t.length).toBeGreaterThan(5);
    for (const x of t) {
      expect(x.face).toBe('sans'); // Helvetica
      expect(x.hscale ?? 1).toBe(1);
    }
  });
});

describe('matching OCR text to a font', () => {
  it('finds DejaVu (Vera) lettering at its true size', async () => {
    const r = await fits('defrost-vera');
    expect(r.faces.filter((f) => f === 'dejavu').length).toBeGreaterThanOrEqual(r.faces.length - 1);
    expect(median(r.ratios)).toBeGreaterThan(0.98);
    expect(median(r.ratios)).toBeLessThan(1.02);
    expect(Math.max(...r.ratios)).toBeLessThan(1.1);
    expect(r.hscale).toBeCloseTo(1, 1);
  }, 120000);

  it('finds bold serif lettering', async () => {
    const r = await fits('defrost-tinos-bold');
    expect(r.faces.every((f) => f === 'serif-bold')).toBe(true);
    expect(median(r.ratios)).toBeGreaterThan(0.97);
    expect(median(r.ratios)).toBeLessThan(1.03);
  }, 120000);

  it('finds ISO CAD lettering written at 80% width', async () => {
    const r = await fits('defrost-osifont-narrow');
    expect(r.faces.filter((f) => f === 'iso').length).toBeGreaterThanOrEqual(r.faces.length - 1);
    expect(r.hscale).toBeGreaterThan(0.76);
    expect(r.hscale).toBeLessThan(0.84);
    expect(median(r.ratios)).toBeGreaterThan(0.97);
    expect(median(r.ratios)).toBeLessThan(1.03);
  }, 120000);

  it('writes converted values in the matched font: preview, PDF and DXF', async () => {
    const { d } = await fits('defrost-osifont-narrow');
    const dims = convertAll(d);
    const t = texts(d).find((x) => x.text === '152.4')!;
    expect(t.face).toBe('iso');
    // preview: the face, its width factor, not bold
    const layer = renderDimensionLayer(d, dims, true).texts;
    expect(layer).toContain('DUC ISO');
    expect(textSvg(t, '6.00 in')).toMatch(/scale\(0\.[78]\d* -1\)/);
    expect(layer).not.toContain('font-weight');
    // PDF: the face is embedded and used
    const { bytes } = await exportPdfOverlay(d, dims, loadFont);
    expect(Buffer.from(bytes).toString('latin1')).toContain('DUCISO');
    // DXF R12: a style for the face, the width factor on the text
    const dxf = writeDxfR12(d, dims);
    const parsed: any = new DxfParser().parseSync(dxf);
    const conv = parsed.entities.find((e: any) => e.type === 'TEXT' && e.text === '6.00 in');
    expect(conv).toBeTruthy();
    expect(dxf).toContain('isocpeur.ttf');
    expect(dxf).toMatch(/\r\n  7\r\nISOCPEUR\r\n/);
    expect(conv.xScale).toBeCloseTo(t.hscale!, 2);
  }, 120000);

  it('places the move handle with an area it shows near', async () => {
    const { d } = await fits('defrost-vera');
    const layer = renderDimensionLayer(d, convertAll(d), true).overlays;
    const m = layer.match(/class="handle" data-handle="[^"]+" data-near="([^"]+)"/);
    expect(m).toBeTruthy();
    const [x0, y0, x1, y1] = m![1].split(' ').map(Number);
    expect(x1).toBeGreaterThan(x0);
    expect(y1).toBeGreaterThan(y0);
  }, 120000);
});

describe('fallbacks', () => {
  it('writes Helvetica when no font loader is given', async () => {
    const { d } = await fits('defrost-vera');
    const { bytes } = await exportPdfOverlay(d, convertAll(d));
    const s = Buffer.from(bytes).toString('latin1');
    expect(s).toContain('/Helvetica');
    expect(s).not.toContain('DUCWide');
    expect(getFace(undefined).id).toBe('sans');
  }, 120000);
});
