// Finds length values inside drawing text and rewrites them in another unit.
//
// A drawing text becomes clickable when it holds a length:
//   * a number with an explicit length unit anywhere in the text
//     ("305mm Silicone wire leads", "Dia 22.3mm(X8)", "OD<=148mm"), or
//   * a bare number when the text is nothing but a dimension
//     ("88.9", "R 25.4", "Ø12", "2X R5"), or
//   * any number inside the text of a real DXF/DWG DIMENSION entity.
// Angles, thread and pipe sizes, counts, voltages, powers and material grades
// are left alone ("112°", '3/4"NPT', "#10-32", "(X8)", "480V", "304SS").

import type { Drawing, Entity, LengthUnit, TextEntity } from './model';
import { formatCustom, formatLength, MM_PER, parseFactor, settingsKey, toMm, type ConversionSettings, type CustomUnit } from './units';

export type DimKind = 'linear' | 'radius' | 'diameter';

export interface LengthToken {
  /** Range of number + unit inside the text. */
  start: number;
  end: number;
  value: number;
  /** Unit written in the text, null when the value is unit-less. */
  unit: LengthUnit | null;
  /** A space separated number and unit ("381 mm"). */
  spaced: boolean;
  kind: DimKind;
  /** Unit borrowed from a neighbour ("100x50mm"): output the number only. */
  noLabel?: boolean;
  /** Written with a decimal comma ("1504,68"): the converted value keeps it. */
  comma?: boolean;
  /** Written as feet and inches ("5'-3 1/2\""): value is in inches. */
  compound?: boolean;
  /** The custom unit's suffix written after the value ("12 u"); unit is then null. */
  suffix?: string;
}

export interface Dimension extends LengthToken {
  id: string;
  textId: string;
  original: string;
  converted?: { text: string; key: string };
  /** Settings for this dimension only, set in the dimension list. */
  override?: DimensionOverride;
}

export interface DimensionOverride {
  /** Text typed by the user: used as the converted text as it is. */
  text?: string;
  /** Diameter sign in front of the converted value: true = add it, false = take it out. */
  diameter?: boolean;
}

/** A diameter sign (and one space) right before position `at` of `text`, or null. */
export function diameterSignBefore(text: string, at: number): { start: number; sign: string } | null {
  const m = /(?:[\u00d8\u00f8\u2300\u2205\u03c6\u03a6]|%%c)\s?$/i.exec(text.slice(Math.max(0, at - 4), at));
  return m ? { start: at - m[0].length, sign: m[0] } : null;
}

/** True when the value of `d` is written with a diameter sign. */
export function hasDiameterSign(d: { start: number }, text: string): boolean {
  return !!diameterSignBefore(text, d.start);
}

/**
 * Where the text a conversion replaces starts. Normally at the value; when the
 * user chose to add or take out the diameter sign, a sign before the value is
 * replaced too.
 */
export function replaceStart(d: Dimension, text: string): number {
  if (d.override?.diameter === undefined) return d.start;
  return diameterSignBefore(text, d.start)?.start ?? d.start;
}

// A unit word is not followed by a letter, except "x" and a number (6inx45°,
// 10mmx20mm). A unit sign may be ("3/8\"THRU": OCR often drops that space).
const UNIT_RE = /^(\s?)((?:mm|cm|m|inches|inch|in\.?|ft\.?|feet)(?![a-wyz]|x(?!\s?\d))|"|\u201d|\u2033|'|\u2019|\u2032)/;
const UNIT_OF: Record<string, LengthUnit> = {
  mm: 'mm', cm: 'cm', m: 'm', in: 'in', 'in.': 'in', inch: 'in', inches: 'in', '"': 'in', '\u201d': 'in', '\u2033': 'in',
  ft: 'ft', 'ft.': 'ft', feet: 'ft', "'": 'ft', '\u2019': 'ft', '\u2032': 'ft',
};
const PIPE_THREAD_RE = /^\s?-?\s?(NPTF?|NPSM?|BSPP?|BSPT|UNE?F|UNC|UN|G\d)/i;
const DEGREE_RE = /^\s?(\u00b0|\u00ba|%%d|deg\b)/i;
/**
 * What may remain around the numbers of a text that is "just a dimension".
 * Diameter signs: Ø, ⌀, ∅, φ, Φ, ø and AutoCAD's %%c; after one, a fit class ("Ø30 H7").
 */
const STANDALONE_RE =
  /^(?:\s|S?R\b|S?R(?=\s|=|$)|\u00d8|\u00f8|\u2300|\u2205|\u03c6|\u03a6|%%c|DIA\.?|D(?=\s|=|:)|=|:|\uff1a|\(|\)|\[|\]|<|>|\u2264|\u2265|\u00b1|~|\u2248|X\s?\d+|\d+\s?X|\d+\s?PL(?:CS)?\.?|TYP\.?|REF\.?|MAX\.?|MIN\.?|THRU|EQ\.?\s?SP\.?|DEEP|(?<=[\u00d8\u2300\u2205\u03c6\u03a6]\s?\d*\s?)[A-HJKMNP-Za-hjkmnp-z]{1,2}\d{1,2}(?:\/[A-HJKMNP-Za-hjkmnp-z]{1,2}\d{1,2})?)*$/i;

function kindFromPrefix(before: string): DimKind {
  const tail = before.slice(-8);
  if (/(?:^|[^A-Za-z])S?R\s*[=:]?\s*$/.test(tail)) return 'radius';
  if (/(\u00d8|\u00f8|\u2300|\u2205|\u03c6|\u03a6|%%c|dia\.?|(?:^|[^A-Za-z])D)\s*[=:\uff1a]?\s*$/i.test(tail)) return 'diameter';
  return 'linear';
}

interface Candidate extends LengthToken {
  /** false = only acceptable when the text is standalone or a DIMENSION. */
  hasUnit: boolean;
}

/** A standard unit written as `suffix` ("mm", "in", '"'), or null for a suffix of the user's own. */
export function knownUnit(suffix: string): LengthUnit | null {
  const t = suffix.trim();
  return UNIT_OF[t] ?? UNIT_OF[t.toLowerCase()] ?? null;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- fractions and feet-inches

/** Fraction characters: ½ ⅓ ⅔ ¼ ¾ ⅕ ⅖ ⅗ ⅘ ⅙ ⅚ ⅛ ⅜ ⅝ ⅞. */
const VULGAR: Record<string, number> = {
  '\u00bd': 1 / 2, '\u2153': 1 / 3, '\u2154': 2 / 3, '\u00bc': 1 / 4, '\u00be': 3 / 4, '\u2155': 1 / 5, '\u2156': 2 / 5, '\u2157': 3 / 5,
  '\u2158': 4 / 5, '\u2159': 1 / 6, '\u215a': 5 / 6, '\u215b': 1 / 8, '\u215c': 3 / 8, '\u215d': 5 / 8, '\u215e': 7 / 8,
};
const VUL = `[${Object.keys(VULGAR).join('')}]`;
/** "/" and the fraction and division slashes that fonts and OCR produce. */
const SL = '[/\\u2044\\u2215]';
const FRAC = `(?:\\d+${SL}\\d+|${VUL})`;
/** A number of inches: "3 3/8", "3-3/8", "3⅜", "3/8", "3.375". */
const INCH_VAL = `(?:\\d+(?:\\s+|-|(?=${VUL}))${FRAC}|${FRAC}|\\d+(?:\\.\\d+)?)`;
const NOT_WORD = '(?![A-WYZa-wyz]|[xX](?!\\s?\\d))';
const INCH_U = `\\s?(?:"|\u201d|\u2033|''|(?:in\\.?|inch(?:es)?)${NOT_WORD})`;
const FT_U = `\\s?(?:'|\u2019|\u2032|ft\\.?|feet|foot)${NOT_WORD}`;
/** Feet and inches ("5'-3 1/2\"", "5' 6\"", "5 ft 6 in"), fractional inches ("3 3/8\""), or a bare fraction ("3 3/8"). */
const IMPERIAL_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)(${FT_U})\\s?(?:-\\s?)?(${INCH_VAL})(${INCH_U})` + // 1-4: feet-inches
    `|((?:\\d+(?:\\s+|-|(?=${VUL})))?${FRAC})(${INCH_U})?`, // 5-6: a fraction, in inches or bare
  'giu',
);

/** "3/8" -> 0.375, "⅜" -> 0.375; an OCR-merged "33/8" (no space) -> 3.375. */
function fractionValue(f: string): number {
  if (VULGAR[f] !== undefined) return VULGAR[f];
  const [ns, ds] = f.split(/[/\u2044\u2215]/);
  const den = Number(ds);
  // drawings do not write improper fractions: "33/8" is 3 3/8, "115/16" is 1 15/16
  if (ns.length >= 2 && Number(ns) >= den && (den & (den - 1)) === 0) {
    for (let k = ns.length - 1; k >= 1; k--) {
      const num = Number(ns.slice(ns.length - k));
      if (num > 0 && num < den && num % 2 === 1) return Number(ns.slice(0, ns.length - k)) + num / den;
    }
  }
  return Number(ns) / den;
}

/** "3 3/8" -> 3.375, "3-3/8", "3⅜", "3/8", "3.375". */
export function inchValue(s: string): number {
  const t = s.trim();
  const m = new RegExp(`^(\\d+)(?:\\s+|-|(?=${VUL}))(${FRAC})$`, 'u').exec(t);
  if (m) return Number(m[1]) + fractionValue(m[2]);
  if (new RegExp(`^${FRAC}$`, 'u').test(t)) return fractionValue(t);
  return parseFloat(t);
}

/** A thread or pipe size follows: 3/4"NPT, 5/8"-18UNF, 1/4-20 UNC. */
const isThread = (rest: string) => PIPE_THREAD_RE.test(rest) || /^\s?-\s?\d+\s?-?\s?(?:UNC|UNF|UNEF|UNS|UN|NC|NF)\b/i.test(rest);

/** Values written as fractions or feet and inches: the ordinary scan cannot read them. */
function imperialTokens(text: string): Candidate[] {
  const out: Candidate[] = [];
  IMPERIAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPERIAL_RE.exec(text))) {
    const s = m.index;
    const e = s + m[0].length;
    const prev = text[s - 1] ?? '';
    const rest = text.slice(e);
    // part of a longer number, a size code (#10-24) or a date (1/2/2024)
    if (/[\d.#/\u2044]/.test(prev) || /^[/\u2044]\d/.test(rest)) continue;
    const before = text.slice(0, s);
    if (/[A-Za-z]$/.test(before) && !/(?:^|[^A-Za-z])(?:S?R|dia)$/i.test(before)) continue;
    if (m[1] !== undefined) {
      // feet and inches: one length, in inches
      if (isThread(rest)) continue;
      const value = Number(m[1]) * 12 + inchValue(m[3]);
      if (!(value > 0)) continue;
      out.push({ start: s, end: e, value, unit: 'in', spaced: false, kind: kindFromPrefix(before), hasUnit: true, compound: true });
    } else {
      const value = inchValue(m[5]);
      if (!(value > 0) || !Number.isFinite(value)) continue;
      if (m[6] !== undefined) {
        if (isThread(rest)) continue; // 3/4"NPT, 5/8"-18UNF
        out.push({ start: s, end: e, value, unit: 'in', spaced: /^\s/.test(m[6]), kind: kindFromPrefix(before), hasUnit: true });
      } else {
        // a bare fraction: a length only in a text that is just a dimension (like bare numbers)
        if (/^[A-Za-z%\u00b0]/.test(rest) || /^\s?-\s?\d/.test(rest) || DEGREE_RE.test(rest) || isThread(rest)) continue; // 3/4NPT, 1/4-20, 1/2°
        out.push({ start: s, end: e, value, unit: null, spaced: false, kind: kindFromPrefix(before), hasUnit: false });
      }
    }
  }
  return out;
}

function scan(text: string, customSuffix?: string): Candidate[] {
  // a suffix of the user's own counts as a unit ("12 u", "3pt")
  const own = customSuffix?.trim() && !knownUnit(customSuffix) ? new RegExp(`^(\\s?)(${escRe(customSuffix.trim())})(?![A-Za-z])`, 'i') : null;
  const out: Candidate[] = imperialTokens(text);
  const taken = out.map((c) => [c.start, c.end]);
  const re = /\d+(?:\.\s?\d+)?|\.\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m.index;
    const e = s + m[0].length;
    // already read as part of a fraction or a feet-inch value
    if (taken.some(([a, b]) => s >= a && s < b)) continue;
    const prev = text[s - 1] ?? '';
    const prev2 = text[s - 2] ?? '';
    const before = text.slice(0, s);
    if (prev === '.' || prev === '#' || prev === '/' || text[e] === '/') continue;
    if ((prev === '-' || prev === ':') && /[\d"'\u201d]/.test(prev2)) continue;
    if (/[A-Za-z]/.test(prev)) {
      const word = /([A-Za-z]+)$/.exec(before)?.[1] ?? '';
      if (/^[xX]$/.test(word)) {
        // "100x50" is a size (both lengths); "X8" is a count.
        if (!/\d\s?$/.test(before.slice(0, -1))) continue;
      } else if (!/^(S?R|dia)$/i.test(word) && !/%%c$/i.test(before)) continue; // M6, PN12, REV3 ... (not %%c12, AutoCAD's Ø12)
    }
    if (prev === '\u00d7' && !/\d\s?$/.test(before.slice(0, -1))) continue;
    let rest = text.slice(e);
    let unit: LengthUnit | null = null;
    let spaced = false;
    let end = e;
    let suffix: string | undefined;
    const om = own?.exec(rest);
    const um = om ? null : UNIT_RE.exec(rest);
    if (om) {
      suffix = om[2];
      spaced = om[1].length > 0;
      end = e + om[0].length;
      rest = text.slice(end);
    } else if (um) {
      unit = UNIT_OF[um[2]];
      spaced = um[1].length > 0;
      end = e + um[0].length;
      rest = text.slice(end);
    }
    if (DEGREE_RE.test(rest)) continue;
    // the custom suffix with a prefix ("3.5 kV" when the unit is V) is another unit
    if (!suffix && own && new RegExp(`^\\s?[A-Za-z\u00b5]{1,2}${escRe(customSuffix!.trim())}(?![A-Za-z])`, 'i').test(rest)) continue;
    if (unit === null && !suffix) {
      if (/^[A-Za-z%]/.test(rest) && !/^[xX\u00d7]\s?\d/.test(rest)) continue; // 120V, 304SS, 18UNF, 8X
      if (/^\s?[-:/]\s?\d/.test(rest)) continue; // ranges, dates, ratios
    } else {
      if (unit === 'in' && PIPE_THREAD_RE.test(rest)) continue; // 1.5"NPT
      if (unit === 'ft' && /^\s?-\s?\d/.test(rest)) continue; // 5'-3" compound values are not parsed
    }
    const value = parseFloat(m[0].replace(/\s/g, ''));
    // a length of 0 is never a dimension (usually a circle or "O" read as a digit)
    if (!Number.isFinite(value) || value === 0) continue;
    out.push({ start: s, end, value, unit, spaced, kind: kindFromPrefix(before), hasUnit: unit !== null || !!suffix, ...(suffix ? { suffix } : {}) });
  }
  out.sort((a, b) => a.start - b.start);
  // "100x50mm": the first value of a size takes the unit of the second.
  for (let i = out.length - 2; i >= 0; i--) {
    const a = out[i];
    const b = out[i + 1];
    if (!a.hasUnit && b.hasUnit && /^\s?[xX\u00d7]\s?$/.test(text.slice(a.end, b.start))) {
      a.unit = b.unit;
      a.hasUnit = true;
      a.noLabel = true;
    }
  }
  return out;
}

export interface TokenContext {
  /** Text of a real DIMENSION entity: bare numbers are lengths. */
  isDimension?: boolean;
  dimType?: TextEntity['dimType'];
  /** The custom unit's original suffix: values written with it are lengths too. */
  customSuffix?: string;
}

export function findLengthTokens(text: string, ctx: TokenContext = {}): LengthToken[] {
  if (ctx.isDimension && ctx.dimType === 'angular') return [];
  // Decimal comma in a text that is only a number ("88,9").
  const comma = /^\s*(\d+),(\d+)\s*$/.exec(text);
  if (comma) {
    const s = text.indexOf(comma[1]);
    const kind: DimKind = ctx.dimType === 'radius' || ctx.dimType === 'diameter' ? ctx.dimType : 'linear';
    return [{ start: s, end: s + comma[1].length + 1 + comma[2].length, value: parseFloat(`${comma[1]}.${comma[2]}`), unit: null, spaced: false, kind, comma: true }];
  }
  const cands = scan(text, ctx.customSuffix);
  let leftover = '';
  let pos = 0;
  for (const c of cands) {
    leftover += text.slice(pos, c.start) + ' ';
    pos = c.end;
  }
  leftover += text.slice(pos);
  const standalone = cands.length > 0 && STANDALONE_RE.test(leftover.trim());
  return cands
    .filter((c) => c.hasUnit || standalone || ctx.isDimension)
    .map(({ hasUnit: _h, ...t }) => {
      if (ctx.isDimension && (ctx.dimType === 'radius' || ctx.dimType === 'diameter') && t.kind === 'linear') {
        return { ...t, kind: ctx.dimType };
      }
      return t;
    });
}

/** True when the text holds nothing but dimension values (it is then re-centred when it grows). */
export function isStandaloneDimension(text: string, dims: { start: number; end: number }[]): boolean {
  if (!dims.length) return false;
  let leftover = '';
  let pos = 0;
  for (const d of [...dims].sort((a, b) => a.start - b.start)) {
    leftover += text.slice(pos, d.start) + ' ';
    pos = d.end;
  }
  leftover += text.slice(pos);
  return STANDALONE_RE.test(leftover.trim());
}

let dimCounter = 0;

/** Finds every convertible length in the model-space text of a drawing. */
export function detectDimensions(drawing: Drawing, opts: { customSuffix?: string } = {}): Dimension[] {
  const dims: Dimension[] = [];
  const visit = (entities: Entity[]) => {
    for (const e of entities) {
      if (e.kind !== 'text') continue;
      for (const t of findLengthTokens(e.text, { isDimension: e.isDimension, dimType: e.dimType, customSuffix: opts.customSuffix })) {
        dimCounter += 1;
        dims.push({ ...t, id: `d${dimCounter}`, textId: e.id, original: e.text.slice(t.start, t.end) });
      }
    }
  };
  visit(drawing.entities);
  return dims;
}

/** Text that replaces dimension `d` under `settings` (its own overrides applied). */
export function replacementText(d: Dimension, fullText: string, s: ConversionSettings, defaultUnit: LengthUnit): string {
  const o = d.override ?? {};
  // the sign in front, when the user chose to add it (or keep it while it is replaced with the value)
  const sign = o.diameter === true ? (diameterSignBefore(fullText, d.start)?.sign ?? '\u00d8') : '';
  if (o.text !== undefined) return o.text.startsWith(sign.trim()) ? o.text : sign + o.text;
  let f;
  if (s.target === 'custom') {
    const v = customValue(d, s.custom);
    if (v === null) return fullText.slice(d.start, d.end); // not in the original unit: left as it is
    f = formatCustom(v, s);
  } else f = formatLength(toMm(d.value, d.unit ?? defaultUnit), s);
  let out = sign + (d.comma ? f.number.replace('.', ',') : f.number);
  if (d.noLabel) return out;
  if (f.label) {
    const sep = f.symbol ? '' : d.unit || d.suffix ? (d.spaced ? ' ' : '') : ' ';
    out += sep + f.label;
  }
  // "8mmDia" -> "0.31 in Dia", but "6\"x45°" stays "152.4mmx45°"
  if (/^[A-Za-z]/.test(fullText.slice(d.end)) && !/^[xX]\s?\d/.test(fullText.slice(d.end))) out += ' ';
  return out;
}

/**
 * A value in the custom unit: original value × factor. Values without a unit
 * and values written with the original suffix are in the original unit. When
 * that suffix is a standard unit ("mm"), values in other standard units are
 * converted to it first. Null when the value is in another unit, or the factor
 * is not a number.
 */
export function customValue(d: LengthToken, c: CustomUnit): number | null {
  const factor = parseFactor(c.factor);
  if (factor === null) return null;
  const from = knownUnit(c.from);
  if (d.suffix !== undefined || d.unit === null) return d.value * factor;
  if (from) return (toMm(d.value, d.unit) / MM_PER[from]) * factor;
  return null;
}

/** Whether `d` can be converted with `s` (in custom mode: only values in the original unit). */
export function canConvert(d: Dimension, s: ConversionSettings): boolean {
  if (d.override?.text !== undefined) return true;
  // a value in a unit of the user's own ("12 u") only converts with the custom unit
  if (s.target !== 'custom') return d.suffix === undefined;
  return customValue(d, s.custom) !== null;
}

export function convertDimension(d: Dimension, fullText: string, s: ConversionSettings, defaultUnit: LengthUnit): void {
  d.converted = { text: replacementText(d, fullText, s, defaultUnit), key: `${settingsKey(s)}|${defaultUnit}` };
}

export interface DisplayText {
  text: string;
  /** Range of each dimension in the display text. */
  ranges: Map<string, { start: number; end: number }>;
  changed: boolean;
}

/** Applies the conversions of `dims` (all belonging to one text) to its original string. */
export function displayText(original: string, dims: Dimension[]): DisplayText {
  const sorted = [...dims].sort((a, b) => a.start - b.start);
  const ranges = new Map<string, { start: number; end: number }>();
  let out = '';
  let pos = 0;
  let changed = false;
  for (const d of sorted) {
    const from = d.converted ? Math.max(pos, replaceStart(d, original)) : d.start;
    out += original.slice(pos, from);
    const rep = d.converted ? d.converted.text : original.slice(d.start, d.end);
    if (d.converted) changed = true;
    ranges.set(d.id, { start: out.length, end: out.length + rep.length });
    out += rep;
    pos = d.end;
  }
  out += original.slice(pos);
  return { text: out, ranges, changed };
}

/** Guess the unit unit-less dimensions are written in from notes like "Length in mm". */
export function guessDimensionUnit(texts: string[], fallback: LengthUnit): LengthUnit {
  const votes: Record<LengthUnit, number> = { mm: 0, cm: 0, m: 0, in: 0, ft: 0 };
  for (const t of texts) {
    const note = /(?:dimensions?|lengths?|units?|all)\b[^\n]{0,20}?\b(?:in|are)\s+(mm|millimet(?:er|re)s?|cm|inch(?:es)?|in\b|feet|ft)/i.exec(t);
    if (note) {
      const u = note[1].toLowerCase();
      const unit: LengthUnit = u.startsWith('mm') || u.startsWith('milli') ? 'mm' : u.startsWith('cm') ? 'cm' : u.startsWith('f') ? 'ft' : 'in';
      votes[unit] += 10;
    }
    for (const tok of findLengthTokens(t)) if (tok.unit) votes[tok.unit] += 1;
  }
  let best: LengthUnit = fallback;
  let max = 0;
  for (const u of Object.keys(votes) as LengthUnit[]) {
    if (votes[u] > max) {
      max = votes[u];
      best = u;
    }
  }
  return best;
}
