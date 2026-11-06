import { beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { convertDimension, detectDimensions, type Dimension } from '../src/dimensions';
import { exportPdfOverlay } from '../src/export/pdf';
import { isInk, measureInk, pageToImage, renderPageImage, type PageImage } from '../src/ink';
import type { Drawing, Pt, TextEntity } from '../src/model';
import { coverPolygons, ocrPatch } from '../src/render/svg';
import { DEFAULT_SETTINGS, type ConversionSettings } from '../src/units';
import { readSample } from './helpers';
import { importBytes, loadModels, ocrImport } from './ocr-helpers';

const pdfjsDir = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));
const docParams = { cMapUrl: `${pdfjsDir}cmaps/`, cMapPacked: true, standardFontDataUrl: `${pdfjsDir}standard_fonts/`, useSystemFonts: false };
const IN: ConversionSettings = { ...DEFAULT_SETTINGS, target: 'in', decimals: 2 };

async function render(bytes: Uint8Array, d: Drawing): Promise<PageImage> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), ...docParams }).promise;
  const page = await doc.getPage(d.pdf!.pageIndex + 1);
  return renderPageImage(page as never, d.pdf!.userToDrawing, (w, h) => createCanvas(w, h) as never);
}
const texts = (d: Drawing) => d.entities.filter((e): e is TextEntity => e.kind === 'text');
function convert(d: Drawing, text: string, value: string, s = IN): { t: TextEntity; dims: Dimension[]; own: Dimension[] } {
  const t = texts(d).find((x) => x.text === text)!;
  const dims = detectDimensions(d);
  for (const x of dims) if (x.textId === t.id && x.original === value) convertDimension(x, t.text, s, 'mm');
  return { t, dims, own: dims.filter((x) => x.textId === t.id) };
}

/** Points along the text (step 1/8 mm) in a band around it, with their position along it. */
function band(t: TextEntity, f: (p: Pt, u: number, v: number) => void): void {
  const em = t.fontSize;
  const step = 1 / 8;
  const dx = Math.cos(t.rotation);
  const dy = Math.sin(t.rotation);
  for (let v = -0.6 * em; v <= 1.3 * em; v += step) {
    for (let u = -0.5 * em; u <= t.width + 0.5 * em; u += step) f({ x: t.pos.x + dx * u - dy * v, y: t.pos.y + dy * u + dx * v }, u, v);
  }
}

/** Points of long straight lines along the text (dimension lines) in the band around it. */
function linePoints(img: PageImage, t: TextEntity): Pt[] {
  const rows = new Map<number, { p: Pt; ink: boolean }[]>();
  band(t, (p, _u, v) => {
    const k = Math.round(v * 8);
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k)!.push({ p, ink: isInk(img, p) });
  });
  const out: Pt[] = [];
  for (const row of rows.values()) {
    let run: Pt[] = [];
    for (const c of [...row, { p: { x: 0, y: 0 }, ink: false }]) {
      if (c.ink) run.push(c.p);
      else {
        if (run.length / 8 > 1.5 * t.fontSize) out.push(...run);
        run = [];
      }
    }
  }
  return out;
}

const kept = (pts: Pt[], img: PageImage) => pts.filter((p) => isInk(img, p)).length / Math.max(1, pts.length);

describe('white-out of converted values', () => {
  beforeAll(async () => {
    await loadModels();
  }, 60000);

  it('leaves the dimension line under a converted value (PDF text)', async () => {
    const bytes = readSample('defrost-heater.pdf');
    const d = await importBytes(bytes, 'x');
    const before = await render(bytes, d);
    measureInk(d, before);
    const { t, dims } = convert(d, '152.4', '152.4');
    expect(t.ink!.length).toBeGreaterThanOrEqual(5); // 1 5 2 . 4
    const lines = linePoints(before, t);
    expect(lines.length).toBeGreaterThan(50);
    const out = await exportPdfOverlay(d, dims);
    const after = await render(out.bytes, d);
    expect(kept(lines, after)).toBeGreaterThan(0.98);
  });

  it('leaves the words before a converted value as they are, and writes only the value', async () => {
    const bytes = readSample('flange-heater.pdf');
    const d = await importBytes(bytes, 'x');
    const before = await render(bytes, d);
    measureInk(d, before);
    const { t, dims, own } = convert(d, 'Element sheath:316SS Dia:12mm', '12mm');
    const patch = ocrPatch(t, own)!;
    expect(patch.text).toBe('0.47in');
    const uValue = t.width * patch.from;
    const words: Pt[] = [];
    band(t, (p, u) => {
      if (u < uValue - 0.1 * t.fontSize && isInk(before, p)) words.push(p);
    });
    expect(words.length).toBeGreaterThan(200);
    const after = await render((await exportPdfOverlay(d, dims)).bytes, d);
    expect(kept(words, after)).toBeGreaterThan(0.99);
  });

  it('keeps the rest of a line when the new value fits, and writes it again when it does not', async () => {
    const d = await importBytes(readSample('defrost-heater.pdf'), 'x');
    measureInk(d, await render(readSample('defrost-heater.pdf'), d));
    const line = '305mm Silicone wire leads';
    const fits = convert(d, line, '305mm', { ...DEFAULT_SETTINGS, target: 'cm', decimals: 0 });
    const p1 = ocrPatch(fits.t, fits.own)!;
    expect(p1.text).toBe('31cm');
    expect(p1.to).toBeLessThan(0.3);
    // only the letters of "305mm" are whited out
    expect(coverPolygons(fits.t, p1).length).toBeGreaterThanOrEqual(4);
    expect(coverPolygons(fits.t, p1).length).toBeLessThanOrEqual(7);
    const wide = convert(d, line, '305mm', { ...IN, decimals: 3 });
    const p2 = ocrPatch(wide.t, wide.own)!;
    expect(p2.to).toBe(1);
    expect(p2.text).toBe('12.008in Silicone wire leads');
  });

  it('leaves the dimension line under a converted value read by Scan & OCR', async () => {
    const { res, d } = await ocrImport('outlined/defrost-heater-outlined.pdf');
    const img: PageImage = { width: res.image!.width, height: res.image!.height, data: res.image!.data, toImage: pageToImage(res.image!.transform as never, d.pdf!.userToDrawing) };
    measureInk(d, img);
    const { t, dims, own } = convert(d, '152.4', '152.4');
    expect(t.ink!.length).toBeGreaterThanOrEqual(5);
    // lines found on a render at the same scale as the one after (a 1-pixel line moves between scales)
    const lines = linePoints(await render(readSample('outlined/defrost-heater-outlined.pdf'), d), t);
    expect(lines.length).toBeGreaterThan(50);
    const after = await render((await exportPdfOverlay(d, dims)).bytes, d);
    expect(kept(lines, after)).toBeGreaterThan(0.98);
    // the old letters are gone: the masks are the letters, not a band
    for (const m of coverPolygons(t, ocrPatch(t, own)!)) expect(m.length).toBeGreaterThanOrEqual(4);
  }, 120000);
});
