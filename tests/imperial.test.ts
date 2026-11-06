import { beforeAll, describe, expect, it } from 'vitest';
import { convertDimension, detectDimensions, displayText, findLengthTokens, inchValue, type Dimension } from '../src/dimensions';
import { DEFAULT_SETTINGS, type ConversionSettings } from '../src/units';
import { readSample } from './helpers';
import { importBytes, loadModels, ocrImport } from './ocr-helpers';

const MM: ConversionSettings = { ...DEFAULT_SETTINGS, target: 'mm', decimals: 1 };
const read = (text: string) => findLengthTokens(text).map((t) => [text.slice(t.start, t.end), +t.value.toFixed(4), t.unit]);
function conv(text: string, s = MM, unit: 'in' | 'mm' = 'in'): string {
  const dims: Dimension[] = findLengthTokens(text).map((t, i) => ({ ...t, id: `d${i}`, textId: 't', original: text.slice(t.start, t.end) }));
  for (const d of dims) convertDimension(d, text, s, unit);
  return displayText(text, dims).text;
}

describe('fractional inches and feet-inches', () => {
  it.each([
    ['3 3/8"', 3.375],
    ['3-3/8"', 3.375],
    ['3/8"', 0.375],
    ['3\u215c"', 3.375],
    ['3 3\u20448"', 3.375],
    ['1 15/16"', 1.9375],
    ['1/2 in', 0.5],
    ['12.5"', 12.5],
  ])('reads %s', (text, value) => {
    expect(read(text)).toEqual([[text, value, 'in']]);
  });

  it('reads feet and inches as one length', () => {
    expect(read(`5'-3 1/2"`)).toEqual([[`5'-3 1/2"`, 63.5, 'in']]);
    expect(read(`5' 6"`)).toEqual([[`5' 6"`, 66, 'in']]);
    expect(read(`6'-9"`)).toEqual([[`6'-9"`, 81, 'in']]);
    expect(read('5 ft 6 in')).toEqual([['5 ft 6 in', 66, 'in']]);
    expect(read(`12'`)).toEqual([[`12'`, 12, 'ft']]);
  });

  it('reads a fraction without a unit when the text is only a dimension', () => {
    expect(read('2 1/4')).toEqual([['2 1/4', 2.25, null]]);
    expect(read('3 3/8 TYP')).toEqual([['3 3/8', 3.375, null]]);
    expect(read('SCALE 1/2')).toEqual([]);
  });

  it('splits fractions that OCR read without the space', () => {
    expect(inchValue('33/8')).toBe(3.375);
    expect(inchValue('115/16')).toBe(1.9375);
    expect(inchValue('3/2')).toBe(1.5);
  });

  it('keeps prefixes, diameters and signs that run on', () => {
    expect(conv('2X \u00d81 1/4" THRU')).toBe('2X \u00d831.8mm THRU');
    expect(conv('2X \u00d81 1/4"THRU')).toBe('2X \u00d831.8mm THRU');
    expect(findLengthTokens('2X \u00d81 1/4"')[0].kind).toBe('diameter');
    expect(conv('R 3/4" TYP')).toBe('R 19.0mm TYP');
    expect(conv('CHAMFER 1/8" x 45\u00b0')).toBe('CHAMFER 3.2mm x 45\u00b0');
    expect(conv('6"x45\u00b0')).toBe('152.4mmx45\u00b0');
    expect(conv(`5'-3 1/2"`)).toBe('1612.9mm');
    expect(conv('2 1/2 x 4"')).toBe('63.5 x 101.6mm');
  });

  it('leaves thread and pipe sizes, codes and dates alone', () => {
    for (const t of ['3/4"NPT TAP', '5/8"-18UNF', '1/4-20 UNC', '#10-32', '1/2/2024', 'M6']) expect(read(t)).toEqual([]);
  });

  it('converts to fractional inches and feet-inches', () => {
    expect(conv('85.7', { ...MM, target: 'in-frac', denominator: 8 }, 'mm')).toBe('3 3/8 in');
    expect(conv(`3 3/8"`, { ...MM, target: 'ft-in', denominator: 16 })).toBe('3 3/8"');
    expect(conv('1612.9', { ...MM, target: 'ft-in', denominator: 16 }, 'mm')).toBe(`5'-3 1/2"`);
  });
});

describe('fractions in drawings', () => {
  beforeAll(async () => {
    await loadModels();
  }, 60000);
  const EXPECTED = [`5'-3 1/2"=63.5`, `6'-9"=81`, `3 3/8"=3.375`, `15/16"=0.9375`, '2 1/4=2.25', `1 1/4"=1.25`, `3/4"=0.75`, `1/8"=0.125`];
  const list = (d: Awaited<ReturnType<typeof importBytes>>) =>
    detectDimensions(d)
      .map((x) => `${x.original.replace(/\u201d/g, '"')}=${+x.value.toFixed(4)}`)
      .sort();

  it('reads every value of an inch drawing with real text', async () => {
    const d = await importBytes(readSample('bracket-inch.pdf'), 'x');
    expect(list(d)).toEqual([...EXPECTED].sort());
    expect(d.detectedDimensionUnit).toBe('in');
  });

  it.each(['outlined/bracket-inch-outlined.pdf', 'outlined/fonts/bracket-osifont.pdf'])('reads every value with Scan & OCR (%s)', async (name) => {
    const { d } = await ocrImport(name);
    expect(list(d)).toEqual([...EXPECTED].sort());
  }, 120000);
});
