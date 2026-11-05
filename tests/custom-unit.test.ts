import { describe, expect, it } from 'vitest';
import { canConvert, convertDimension, detectDimensions, displayText, findLengthTokens, replacementText, type Dimension } from '../src/dimensions';
import { addBoxedText, textFromBox } from '../src/boxes';
import { cleanOcrText } from '../src/ocr/engine';
import { normaliseOcrText } from '../src/ocr/preprocess';
import { writeDxfR12 } from '../src/export/dxfR12';
import type { Drawing, TextEntity } from '../src/model';
import { DEFAULT_SETTINGS, parseFactor, settingsKey, type ConversionSettings, type CustomUnit } from '../src/units';

const custom = (c: Partial<CustomUnit>, more: Partial<ConversionSettings> = {}): ConversionSettings => ({
  ...DEFAULT_SETTINGS,
  target: 'custom',
  decimals: 2,
  custom: { from: 'mm', factor: '39.37', to: 'mil', ...c },
  ...more,
});

function dim(text: string, customSuffix?: string, i = 0): Dimension {
  const t = findLengthTokens(text, { customSuffix })[i];
  return { ...t, id: 'd', textId: 't', original: text.slice(t.start, t.end) };
}
const conv = (text: string, s: ConversionSettings, i = 0) => {
  const d = dim(text, s.custom.from, i);
  convertDimension(d, text, s, 'mm');
  return displayText(text, [d]).text;
};

describe('custom unit', () => {
  it('reads factors as numbers or fractions', () => {
    expect(parseFactor('39.37')).toBe(39.37);
    expect(parseFactor('1/25.4')).toBeCloseTo(0.03937, 5);
    expect(parseFactor(' 2,5 ')).toBe(2.5);
    expect(parseFactor('2.5e-3')).toBe(0.0025);
    for (const bad of ['', 'abc', '0', '-2', '1/0', '1/']) expect(parseFactor(bad)).toBeNull();
  });

  it('multiplies by the factor and writes the new suffix', () => {
    const s = custom({});
    expect(conv('152.4', s)).toBe('5999.99 mil');
    expect(conv('381 mm', s)).toBe('14999.97 mil');
    expect(conv('8mm', s)).toBe('314.96mil');
    expect(conv('Dia 22.3mm(X8)', s)).toBe('Dia 877.95mil(X8)');
    expect(conv('\u00d860', s)).toBe('\u00d82362.20 mil');
    expect(conv('300mm Silicone wire leads', custom({}, { trimZeros: true, decimals: 1 }))).toBe('11811mil Silicone wire leads');
  });

  it('follows the label setting and symbols', () => {
    expect(conv('152.4', custom({}, { showUnit: false }))).toBe('5999.99');
    expect(conv('100', custom({ from: 'mm', factor: '1/25.4', to: '"' }))).toBe('3.94"');
    expect(conv('100', custom({ to: '' }))).toBe('3937.00');
  });

  it('finds values written with a suffix of the user’s own', () => {
    const s = custom({ from: 'u', factor: '2.5', to: 'pt' });
    expect(findLengthTokens('12 u')[0]).toBeUndefined();
    const t = findLengthTokens('Gap 12 u wide', { customSuffix: 'u' });
    expect(t.map((x) => [x.value, x.suffix, x.spaced])).toEqual([[12, 'u', true]]);
    expect(conv('Gap 12 u wide', s)).toBe('Gap 30.00 pt wide');
    expect(conv('4u', s)).toBe('10.00pt');
    expect(conv('7', s)).toBe('17.50 pt'); // no unit: in the original unit
    // a suffix that is part of a word is not the unit
    expect(findLengthTokens('12 units', { customSuffix: 'u' })).toEqual([]);
  });

  it('converts other standard units through a standard original unit', () => {
    const s = custom({ from: 'mm', factor: '2', to: 'mm' }); // a scaled drawing
    expect(conv('5 in', s)).toBe('254.00 mm');
    expect(conv('40', s)).toBe('80.00 mm');
  });

  it('leaves values in another unit alone when the original suffix is not a standard unit', () => {
    const s = custom({ from: 'u', factor: '2.5', to: 'pt' });
    const d = dim('5 in', 'u');
    expect(canConvert(d, s)).toBe(false);
    expect(replacementText(d, '5 in', s, 'mm')).toBe('5 in');
    expect(canConvert(dim('5 u', 'u'), s)).toBe(true);
    // no factor: nothing converts
    expect(canConvert(dim('5'), custom({ factor: 'x' }))).toBe(false);
    // a value in the user's own unit does not convert to a standard unit
    expect(canConvert(dim('5 u', 'u'), { ...DEFAULT_SETTINGS })).toBe(false);
    // typed text always applies
    expect(canConvert({ ...dim('5 in', 'u'), override: { text: 'A' } }, s)).toBe(true);
  });

  it('a change of factor or suffix is a new conversion (a second click does not undo it)', () => {
    expect(settingsKey(custom({ factor: '2' }))).not.toBe(settingsKey(custom({ factor: '3' })));
    expect(settingsKey(custom({ to: 'a' }))).not.toBe(settingsKey(custom({ to: 'b' })));
  });

  it('detects suffix values in a drawing and writes them to DXF', () => {
    const t: TextEntity = { kind: 'text', id: 't1', style: { layer: 'TEXT', color: '#000000' }, text: 'Pitch 12 u', pos: { x: 0, y: 0 }, fontSize: 3, rotation: 0, width: 20, widthExact: false, align: 'left' };
    const d = { name: 'x', source: 'dxf', entities: [t], blocks: {}, bounds: { minX: 0, minY: 0, maxX: 20, maxY: 3 }, geometryUnit: 'mm', detectedDimensionUnit: 'mm', stats: {} as never, warnings: [] } as unknown as Drawing;
    expect(detectDimensions(d)).toEqual([]);
    const dims = detectDimensions(d, { customSuffix: 'u' });
    expect(dims.map((x) => x.original)).toEqual(['12 u']);
    const s = custom({ from: 'u', factor: '2.5', to: 'pt' });
    convertDimension(dims[0], t.text, s, 'mm');
    expect(writeDxfR12(d, dims)).toContain('Pitch 30.00 pt');
  });
});

describe('custom unit in boxes the user draws', () => {
  const box = { minX: 0, minY: 0, maxX: 20, maxY: 5 };
  const empty = { name: 'x', source: 'pdf', entities: [], blocks: {}, bounds: box, geometryUnit: 'mm', detectedDimensionUnit: 'mm', stats: {} as never, warnings: [] } as unknown as Drawing;
  const found = (text: string, suffix?: string) => addBoxedText(empty, [], box, textFromBox(text, box), suffix).dims.map((x) => x.original);

  it('finds volts and degrees when they are the original unit', () => {
    expect(found('120V')).toEqual([]);
    expect(found('120V', 'V')).toEqual(['120V']);
    expect(found('480V 3PH 27KW', 'V')).toEqual(['480V']);
    expect(found('45°')).toEqual([]);
    expect(found('45°', '°')).toEqual(['45°']);
    expect(found('HOT ZONE 104.0°', '°')).toEqual(['104.0°']);
    expect(found('45 deg', 'deg')).toEqual(['45 deg']);
    expect(found('3.5 kV', 'V')).toEqual([]);
  });

  it('reads a degree sign that OCR saw as * or º', () => {
    expect(cleanOcrText('112*')).toBe('112\u00b0');
    expect(cleanOcrText('86.0\u00ba')).toBe('86.0\u00b0');
    expect(cleanOcrText('A*B 2*3')).toBe('A*B 2*3');
    expect(normaliseOcrText('112\uff0a')).toBe('112\u00b0');
  });

  it('converts them with the factor and the new suffix', () => {
    const v = custom({ from: 'V', factor: '1/1000', to: 'kV' }, { decimals: 3 });
    expect(conv('480V 3PH', v)).toBe('0.480kV 3PH');
    const deg = custom({ from: '°', factor: '0.0174533', to: 'rad' });
    expect(conv('45°', deg)).toBe('0.79rad');
    expect(conv('HOT ZONE 104.0°', deg)).toBe('HOT ZONE 1.82rad');
    const toDeg = custom({ from: 'rad', factor: '57.2958', to: '°' }, { decimals: 1 });
    expect(conv('1.5 rad', toDeg)).toBe('85.9°');
  });
});
