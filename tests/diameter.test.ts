import { beforeAll, describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { convertDimension, detectDimensions, displayText, findLengthTokens, replacementText, type Dimension } from '../src/dimensions';
import { writeDxfR12 } from '../src/export/dxfR12';
import { exportPdfOverlay } from '../src/export/pdf';
import type { Drawing, TextEntity } from '../src/model';
import { diameterEdits } from '../src/ocr/diameter';
import { cleanOcrText } from '../src/ocr/engine';
import { normaliseOcrText } from '../src/ocr/preprocess';
import { renderDimensionLayer } from '../src/render/svg';
import { encodeR12Text } from '../src/textcodes';
import { DEFAULT_SETTINGS, type ConversionSettings } from '../src/units';
import { loadModels, ocrImport } from './ocr-helpers';

const s: ConversionSettings = { ...DEFAULT_SETTINGS, target: 'in', decimals: 2 };
const texts = (d: Drawing) => d.entities.filter((e): e is TextEntity => e.kind === 'text');
const ocrTexts = (d: Drawing) => texts(d).filter((t) => t.ocr).map((t) => t.text);

function dim(text: string, i = 0): Dimension {
  const t = findLengthTokens(text)[i];
  return { ...t, id: 'd', textId: 't', original: text.slice(t.start, t.end) };
}
function converted(text: string, override?: Dimension['override']): string {
  const d = { ...dim(text), override };
  convertDimension(d, text, s, 'mm');
  return displayText(text, [d]).text;
}

describe('diameter values in text', () => {
  it.each([
    ['\u00d860', '60'],
    ['\u00d8 96.5', '96.5'],
    ['\u00d876.2mm', '76.2mm'],
    ['2X \u00d812 THRU', '12'],
    ['\u00d830 H7', '30'],
    ['\u00d830 H7/g6', '30'],
    ['\u00d88 DEEP', '8'],
    ['Bore \u00d822.3mm', '22.3mm'],
    ['\u230025', '25'],
    ['\u220525', '25'],
    ['\u00f825', '25'],
    ['%%c12', '12'],
  ])('%s is a diameter', (text, value) => {
    const t = findLengthTokens(text);
    expect(t.map((x) => text.slice(x.start, x.end))).toEqual([value]);
    expect(t[0].kind).toBe('diameter');
  });

  it('does not take letters with a number for a fit class without a diameter', () => {
    expect(findLengthTokens('30 H7')).toEqual([]);
    expect(findLengthTokens('M6')).toEqual([]);
  });

  it('keeps the sign in the converted text', () => {
    expect(converted('\u00d860')).toBe('\u00d82.36 in');
    expect(converted('\u00d8 96.5')).toBe('\u00d8 3.80 in');
    expect(converted('2X \u00d812 THRU')).toBe('2X \u00d80.47 in THRU');
    expect(converted('Bore \u00d822.3mm')).toBe('Bore \u00d80.88in');
  });

  it('adds or takes out the sign when the user asks', () => {
    expect(converted('152.4', { diameter: true })).toBe('\u00d86.00 in');
    expect(converted('Dia 22.3mm(X8)', { diameter: true })).toBe('Dia \u00d80.88in(X8)');
    expect(converted('\u00d860', { diameter: false })).toBe('2.36 in');
    expect(converted('\u00d8 96.5', { diameter: false })).toBe('3.80 in');
    expect(converted('2X \u00d812 THRU', { diameter: false })).toBe('2X 0.47 in THRU');
    // kept, with the drawing's spacing, when it is replaced with the value
    expect(converted('\u00d8 96.5', { diameter: true })).toBe('\u00d8 3.80 in');
    // typed text gets the sign in front unless it already has it
    expect(replacementText({ ...dim('152.4'), override: { text: '6 TYP', diameter: true } }, '152.4', s, 'mm')).toBe('\u00d86 TYP');
    expect(replacementText({ ...dim('152.4'), override: { text: '\u00d86 TYP', diameter: true } }, '152.4', s, 'mm')).toBe('\u00d86 TYP');
  });

  it('writes the sign as %%c in DXF R12', () => {
    expect(encodeR12Text('\u00d82.36 in')).toBe('%%c2.36 in');
    expect(encodeR12Text('\u22052.36 in')).toBe('%%c2.36 in');
  });
});

describe('reading the diameter sign with OCR', () => {
  it('turns look-alikes into Ø', () => {
    expect(cleanOcrText('\u220512')).toBe('\u00d812');
    expect(cleanOcrText('\u00f812')).toBe('\u00d812');
    expect(cleanOcrText('S\u00f8ren')).toBe('S\u00f8ren');
    expect(normaliseOcrText('\u2205 12')).toBe('\u00d8 12');
  });

  it('suggests Ø where OCR reads 0, O or nothing, only in front of lengths', () => {
    const e = (t: string) => diameterEdits(t).map((x) => x.text);
    expect(e('060')).toContain('\u00d860');
    expect(diameterEdits('060').find((x) => x.text === '\u00d860')?.sure).toBe(true);
    expect(e('2X O12 THRU')).toContain('2X \u00d812 THRU');
    expect(e('30 H7')).toContain('\u00d830 H7');
    expect(e('96.5')).toContain('\u00d8 96.5');
    expect(e('Sheath tube: 304SS 8mmDia').some((t) => t.includes('\u00d8304'))).toBe(false);
    expect(e('120V,475W')).toEqual([]);
    expect(e('0.75')).not.toContain('\u00d8.75');
  });

  beforeAll(async () => {
    await loadModels();
  }, 60000);

  const EXPECTED = [
    '2X \u00d812 THRU',
    'Shaft \u00d860 to \u00d844 stepped',
    '\u00d830 H7',
    '\u00d80.75 THRU',
    'Bore \u00d822.3mm',
    '\u00d860',
    '\u00d8 96.5',
    '\u00d876.2mm',
    '\u00d844',
    '360',
    '700',
    'Length in mm',
  ];

  it.each([
    ['Arial-like lettering', 'outlined/shaft-diameters-outlined.pdf'],
    ['ISO CAD lettering', 'outlined/fonts/shaft-osifont.pdf'],
    ['serif lettering', 'outlined/fonts/shaft-tinos.pdf'],
  ])('reads every Ø on a shaft drawing in %s', async (_, name) => {
    const { d } = await ocrImport(name);
    expect(ocrTexts(d).sort()).toEqual([...EXPECTED].sort());
    const dims = detectDimensions(d);
    expect(dims.filter((x) => x.kind === 'diameter').map((x) => x.original).sort()).toEqual(['0.75', '12', '22.3mm', '30', '44', '60', '76.2mm', '96.5'].sort());
  }, 120000);

  it.each(['outlined/defrost-heater-outlined.pdf', 'outlined/flange-heater-outlined.pdf', 'outlined/fonts/defrost-osifont-narrow.pdf', 'outlined/fonts/defrost-tinos.pdf'])(
    'adds no Ø to a drawing without one (%s)',
    async (name) => {
      const { d } = await ocrImport(name);
      expect(ocrTexts(d).filter((t) => t.includes('\u00d8'))).toEqual([]);
    },
    120000,
  );

  it('writes converted diameters with their sign: preview, PDF and DXF', async () => {
    const { d } = await ocrImport('outlined/fonts/shaft-osifont.pdf');
    const dims = detectDimensions(d);
    const byId = new Map(texts(d).map((t) => [t.id, t]));
    for (const x of dims) convertDimension(x, byId.get(x.textId)!.text, s, 'mm');
    // a standalone diameter is redrawn whole, sign included
    expect(renderDimensionLayer(d, dims, true).texts).toContain('\u00d82.36 in');
    const { bytes } = await exportPdfOverlay(d, dims);
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const all = ((await (await doc.getPage(1)).getTextContent()).items as any[]).map((i) => i.str).join('|');
    expect(all).toContain('\u00d82.36 in');
    expect(all).toContain('\u00d830 H7'); // the text layer keeps what was read
    const dxf = writeDxfR12(d, dims);
    expect(dxf).toContain('%%c2.36 in');
    expect(dxf).toContain('2X %%c0.47 in THRU');
  }, 120000);
});
