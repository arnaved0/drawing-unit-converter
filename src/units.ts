import type { LengthUnit } from './model';

export const MM_PER: Record<LengthUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

export type TargetFormat = 'mm' | 'cm' | 'm' | 'in' | 'in-frac' | 'ft' | 'ft-in' | 'custom';

/** A conversion the user defines: new value = original value × factor. */
export interface CustomUnit {
  /** Suffix the drawing writes after original values ("mm", "u"); values without a suffix count too. */
  from: string;
  /** Factor as typed: a number or a fraction ("39.37", "1/25.4"). */
  factor: string;
  /** Suffix written after converted values. */
  to: string;
}

export interface ConversionSettings {
  target: TargetFormat;
  /** Decimal places for decimal formats. */
  decimals: number;
  /** Denominator for fractional inch formats (2, 4, 8, 16, 32, 64). */
  denominator: number;
  /** Append a unit label to the converted value. */
  showUnit: boolean;
  /** Inch label style: 'in' or '"'. */
  inchLabel: 'in' | '"';
  /** Remove trailing zeros (3.50 -> 3.5). */
  trimZeros: boolean;
  /** Used when target is 'custom'. */
  custom: CustomUnit;
}

export const DEFAULT_SETTINGS: ConversionSettings = {
  target: 'in',
  decimals: 2,
  denominator: 16,
  showUnit: true,
  inchLabel: 'in',
  trimZeros: false,
  custom: { from: 'mm', factor: '39.37', to: 'mil' },
};

export const TARGET_LABELS: Record<TargetFormat, string> = {
  mm: 'Millimetres (mm)',
  cm: 'Centimetres (cm)',
  m: 'Metres (m)',
  in: 'Inches, decimal',
  'in-frac': 'Inches, fractional',
  ft: 'Feet, decimal',
  'ft-in': 'Feet and inches',
  custom: 'Custom…',
};

/** "39.37" -> 39.37, "1/25.4" -> 0.03937…; null unless a positive, finite number. */
export function parseFactor(text: string): number | null {
  const t = text.trim().replace(',', '.');
  const m = /^([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)(?:\s*\/\s*([0-9]*\.?[0-9]+(?:e[-+]?\d+)?))?$/i.exec(t);
  if (!m) return null;
  const v = m[2] !== undefined ? parseFloat(m[1]) / parseFloat(m[2]) : parseFloat(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** A custom value: the number and the new suffix. */
export function formatCustom(value: number, s: ConversionSettings): FormattedValue {
  const to = s.custom.to.trim();
  return { number: fixed(value, s.decimals, s.trimZeros), label: s.showUnit ? to : '', symbol: /^["'\u2033\u2032\u00b0]$/.test(to) };
}

export function toMm(value: number, unit: LengthUnit): number {
  return value * MM_PER[unit];
}

export function fixed(v: number, decimals: number, trim: boolean): string {
  let s = v.toFixed(Math.max(0, Math.min(6, decimals)));
  if (trim && s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
  return s;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** 3.5 -> "3 1/2", 0.25 -> "1/4", 2 -> "2" (rounded to the nearest 1/denominator). */
export function fraction(v: number, denominator: number): string {
  const neg = v < 0;
  const total = Math.round(Math.abs(v) * denominator);
  const whole = Math.floor(total / denominator);
  let num = total - whole * denominator;
  let den = denominator;
  let s: string;
  if (num === 0) s = String(whole);
  else {
    const g = gcd(num, den);
    num /= g;
    den /= g;
    s = whole === 0 ? `${num}/${den}` : `${whole} ${num}/${den}`;
  }
  return neg && s !== '0' ? `-${s}` : s;
}

export interface FormattedValue {
  /** Number part, e.g. "3.50" or "3 1/2" or "5'-3 1/2\"". */
  number: string;
  /** Unit label, e.g. "in", "\"", "mm"; '' when the label is part of `number` or disabled. */
  label: string;
  /** Label is a symbol that never gets a space before it. */
  symbol: boolean;
}

export function formatLength(mm: number, s: ConversionSettings): FormattedValue {
  const inch = mm / 25.4;
  const inLabel = s.inchLabel === '"' ? { label: '"', symbol: true } : { label: 'in', symbol: false };
  switch (s.target) {
    case 'mm':
    case 'cm':
    case 'm':
      return { number: fixed(mm / MM_PER[s.target], s.decimals, s.trimZeros), label: s.showUnit ? s.target : '', symbol: false };
    case 'in':
      return { number: fixed(inch, s.decimals, s.trimZeros), ...(s.showUnit ? inLabel : { label: '', symbol: false }) };
    case 'in-frac':
      return { number: fraction(inch, s.denominator), ...(s.showUnit ? inLabel : { label: '', symbol: false }) };
    case 'ft':
      return { number: fixed(mm / MM_PER.ft, s.decimals, s.trimZeros), label: s.showUnit ? 'ft' : '', symbol: false };
    case 'custom':
      // a custom value is not a length in mm: see formatCustom
      return formatCustom(mm, s);
    case 'ft-in': {
      const totalUnits = Math.round(inch * s.denominator);
      const perFoot = 12 * s.denominator;
      const feet = Math.floor(totalUnits / perFoot);
      const rest = (totalUnits - feet * perFoot) / s.denominator;
      const inches = fraction(rest, s.denominator);
      // Feet-inch notation always carries its own ' and " marks.
      return { number: feet > 0 ? `${feet}'-${inches}"` : `${inches}"`, label: '', symbol: true };
    }
  }
}

/** Stable key so a repeated click with identical settings can toggle a conversion off. */
export function settingsKey(s: ConversionSettings): string {
  const custom = s.target === 'custom' ? [s.custom.from, s.custom.factor, s.custom.to] : [];
  return [s.target, s.decimals, s.denominator, s.showUnit, s.inchLabel, s.trimZeros, ...custom].join('|');
}
