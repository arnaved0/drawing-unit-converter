import { describe, expect, it } from 'vitest';
import { findLengthTokens, replacementText, guessDimensionUnit, displayText, convertDimension, type Dimension } from '../src/dimensions';
import { DEFAULT_SETTINGS, type ConversionSettings } from '../src/units';

const values = (text: string, ctx = {}) => findLengthTokens(text, ctx).map((t) => text.slice(t.start, t.end));

describe('finds lengths in drawing text', () => {
  // Texts taken from the example heater drawings.
  it.each([
    ['88.9', ['88.9']],
    ['8', ['8']],
    ['38.1', ['38.1']],
    ['305mm Silicone wire leads', ['305mm']],
    ['Sheath tube:  304SS 8mmDia', ['8mm']],
    ['Element sheath:316SS Dia:12mm', ['12mm']],
    ['ID>=8mm', ['8mm']],
    ['381 mm', ['381 mm']],
    ['OD<=148mm', ['148mm']],
    ['316SS sheath Dia=12mm', ['12mm']],
    ['279. 4mm', ['279. 4mm']],
    ['Dia 22.3mm(X8)', ['22.3mm']],
    ['Dia 215.9 mm', ['215.9 mm']],
    ['R 330.2mm', ['330.2mm']],
    ['R 25. 4mm', ['25. 4mm']],
    ['Element Dia =10. 9mm', ['10. 9mm']],
    ['610.61 mm', ['610.61 mm']],
    ['11.2 mm', ['11.2 mm']],
    ['Plate 6mm thick, 304SS', ['6mm']],
    ['2X R5', ['5']],
    ['Dia0', []],
    ['\u00d830', ['30']],
    ['R20', ['20']],
    ['100x50mm', ['100', '50mm']],
    ['12.5"', ['12.5"']],
    ['3 in', ['3 in']],
  ])('%s', (text, expected) => {
    expect(values(text)).toEqual(expected);
  });

  it.each([
    'Defrost tubular heater',
    '120V,475W',
    'Length in mm',
    '480V 3PH 27KW',
    '(15 Elements)',
    'Flange mat: 304SS',
    'Qty 15',
    '#6-150 Terminal box',
    '3/4"NPT Gland',
    '1.5"NPT Gland',
    '112\u00b0',
    'HOT ZONE 104.0\u00b0',
    '86.0\u00b0',
    '5/8"-18UNF',
    '#10-32',
    '480V 1700W',
    'Sheath tube:Incoloy or 310SS upon quoted',
    'C-Z',
    'M6',
    '2024-01-05',
    'SCALE 1:2',
  ])('ignores %s', (text) => {
    expect(values(text)).toEqual([]);
  });

  it('treats every number of a DIMENSION entity as a length, except angular ones', () => {
    expect(values('150', { isDimension: true, dimType: 'linear' })).toEqual(['150']);
    expect(values('60\u00b0', { isDimension: true, dimType: 'angular' })).toEqual([]);
    expect(values('1504,68', { isDimension: true })).toEqual(['1504,68']);
  });

  it('classifies radius and diameter values by their prefix', () => {
    expect(findLengthTokens('R 330.2mm')[0].kind).toBe('radius');
    expect(findLengthTokens('Dia 22.3mm(X8)')[0].kind).toBe('diameter');
    expect(findLengthTokens('\u00d812')[0].kind).toBe('diameter');
    expect(findLengthTokens('152.4')[0].kind).toBe('linear');
  });
});

function dim(text: string, i = 0): Dimension {
  const t = findLengthTokens(text)[i];
  return { ...t, id: 'd', textId: 't', original: text.slice(t.start, t.end) };
}

describe('replacement text', () => {
  const s: ConversionSettings = { ...DEFAULT_SETTINGS, target: 'in', decimals: 2 };
  it('keeps prefixes and suffixes around the value', () => {
    const d = dim('Dia 22.3mm(X8)');
    convertDimension(d, 'Dia 22.3mm(X8)', s, 'mm');
    expect(displayText('Dia 22.3mm(X8)', [d]).text).toBe('Dia 0.88in(X8)');
    const r = dim('R 330.2mm');
    convertDimension(r, 'R 330.2mm', s, 'mm');
    expect(displayText('R 330.2mm', [r]).text).toBe('R 13.00in');
  });
  it('adds a unit label to unit-less values', () => {
    expect(replacementText(dim('152.4'), '152.4', s, 'mm')).toBe('6.00 in');
    expect(replacementText(dim('152.4'), '152.4', { ...s, inchLabel: '"' }, 'mm')).toBe('6.00"');
    expect(replacementText(dim('152.4'), '152.4', { ...s, showUnit: false }, 'mm')).toBe('6.00');
  });
  it('keeps the spacing style of the original', () => {
    expect(replacementText(dim('381 mm'), '381 mm', s, 'mm')).toBe('15.00 in');
  });
  it('separates the value from a following word', () => {
    expect(displayText('Sheath tube: 304SS 8mmDia', [{ ...dim('Sheath tube: 304SS 8mmDia'), converted: { text: replacementText(dim('Sheath tube: 304SS 8mmDia'), 'Sheath tube: 304SS 8mmDia', s, 'mm'), key: '' } }]).text).toBe(
      'Sheath tube: 304SS 0.31in Dia',
    );
  });
  it('fractions and feet-inches', () => {
    expect(replacementText(dim('88.9'), '88.9', { ...s, target: 'in-frac', denominator: 16 }, 'mm')).toBe('3 1/2 in');
    expect(replacementText(dim('939.8mm'), '939.8mm', { ...s, target: 'ft-in', denominator: 16 }, 'mm')).toBe(`3'-1"`);
  });
  it('converts inch values to millimetres', () => {
    expect(replacementText(dim('12.5"'), '12.5"', { ...s, target: 'mm', decimals: 1 }, 'mm')).toBe('317.5mm');
  });
  it('keeps a decimal comma', () => {
    const t = findLengthTokens('1504,68', { isDimension: true })[0];
    const d: Dimension = { ...t, id: 'd', textId: 't', original: '1504,68' };
    expect(replacementText(d, '1504,68', s, 'mm')).toBe('59,24 in');
  });
  it('uses the value of the size partner without repeating the label', () => {
    const text = '100x50mm';
    const a = dim(text, 0);
    const b = dim(text, 1);
    a.converted = { text: replacementText(a, text, s, 'mm'), key: '' };
    b.converted = { text: replacementText(b, text, s, 'mm'), key: '' };
    expect(displayText(text, [a, b]).text).toBe('3.94x1.97in');
  });
});

describe('unit detection', () => {
  it('reads notes like "Length in mm"', () => {
    expect(guessDimensionUnit(['Defrost tubular heater', 'Length in mm', '88.9'], 'in')).toBe('mm');
    expect(guessDimensionUnit(['ALL DIMENSIONS ARE IN INCHES'], 'mm')).toBe('in');
    expect(guessDimensionUnit(['12.5"', '3"'], 'mm')).toBe('in');
    expect(guessDimensionUnit(['nothing here'], 'mm')).toBe('mm');
  });
});
