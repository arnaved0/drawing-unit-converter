import { describe, expect, it } from 'vitest';
import { formatLength, fraction, DEFAULT_SETTINGS } from '../src/units';

describe('formatLength', () => {
  const s = { ...DEFAULT_SETTINGS };
  it('metric', () => {
    expect(formatLength(152.4, { ...s, target: 'mm', decimals: 1 })).toEqual({ number: '152.4', label: 'mm', symbol: false });
    expect(formatLength(152.4, { ...s, target: 'cm', decimals: 2 }).number).toBe('15.24');
    expect(formatLength(939.8, { ...s, target: 'm', decimals: 3 }).number).toBe('0.940');
  });
  it('decimal inches and trimming', () => {
    expect(formatLength(88.9, { ...s, target: 'in', decimals: 2 }).number).toBe('3.50');
    expect(formatLength(88.9, { ...s, target: 'in', decimals: 2, trimZeros: true }).number).toBe('3.5');
    expect(formatLength(152.4, { ...s, target: 'in', decimals: 2, trimZeros: true }).number).toBe('6');
  });
  it('fractional inches', () => {
    expect(fraction(3.5, 16)).toBe('3 1/2');
    expect(fraction(0.3125, 16)).toBe('5/16');
    expect(fraction(1.999, 16)).toBe('2');
    expect(formatLength(8, { ...s, target: 'in-frac', denominator: 32 }).number).toBe('5/16');
  });
  it('feet and inches', () => {
    expect(formatLength(939.8, { ...s, target: 'ft-in', denominator: 16 }).number).toBe(`3'-1"`);
    expect(formatLength(88.9, { ...s, target: 'ft-in', denominator: 16 }).number).toBe(`3 1/2"`);
    expect(formatLength(304.8, { ...s, target: 'ft-in', denominator: 16 }).number).toBe(`1'-0"`);
  });
});
