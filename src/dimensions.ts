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
import { formatLength, settingsKey, toMm, type ConversionSettings } from './units';

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
  /** Decimal places for this dimension. */
  decimals?: number;
  /** Unit label for this dimension ('' = none), replacing the general one. */
  suffix?: string;
  /** Text typed by the user: used as the converted text as it is. */
  text?: string;
}

const UNIT_RE = /^(\s?)(mm|cm|m|inches|inch|in\.?|"|\u201d|\u2033|ft\.?|feet|'|\u2019|\u2032)(?![a-z])/;
const UNIT_OF: Record<string, LengthUnit> = {
  mm: 'mm', cm: 'cm', m: 'm', in: 'in', 'in.': 'in', inch: 'in', inches: 'in', '"': 'in', '\u201d': 'in', '\u2033': 'in',
  ft: 'ft', 'ft.': 'ft', feet: 'ft', "'": 'ft', '\u2019': 'ft', '\u2032': 'ft',
};
const PIPE_THREAD_RE = /^\s?-?\s?(NPTF?|NPSM?|BSPP?|BSPT|UNE?F|UNC|UN|G\d)/i;
const DEGREE_RE = /^\s?(\u00b0|\u00ba|%%d|deg\b)/i;
/** What may remain around the numbers of a text that is "just a dimension". */
const STANDALONE_RE =
  /^(?:\s|S?R\b|S?R(?=\s|=|$)|\u00d8|\u2300|\u03c6|\u03a6|%%c|DIA\.?|D(?=\s|=|:)|=|:|\uff1a|\(|\)|\[|\]|<|>|\u2264|\u2265|\u00b1|~|\u2248|X\s?\d+|\d+\s?X|\d+\s?PL(?:CS)?\.?|TYP\.?|REF\.?|MAX\.?|MIN\.?|THRU|EQ\.?\s?SP\.?)*$/i;

function kindFromPrefix(before: string): DimKind {
  const tail = before.slice(-8);
  if (/(?:^|[^A-Za-z])S?R\s*[=:]?\s*$/.test(tail)) return 'radius';
  if (/(\u00d8|\u2300|\u03c6|\u03a6|%%c|dia\.?|(?:^|[^A-Za-z])D)\s*[=:\uff1a]?\s*$/i.test(tail)) return 'diameter';
  return 'linear';
}

interface Candidate extends LengthToken {
  /** false = only acceptable when the text is standalone or a DIMENSION. */
  hasUnit: boolean;
}

function scan(text: string): Candidate[] {
  const out: Candidate[] = [];
  const re = /\d+(?:\.\s?\d+)?|\.\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m.index;
    const e = s + m[0].length;
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
      } else if (!/^(S?R|dia)$/i.test(word)) continue; // M6, PN12, REV3 ...
    }
    if (prev === '\u00d7' && !/\d\s?$/.test(before.slice(0, -1))) continue;
    let rest = text.slice(e);
    let unit: LengthUnit | null = null;
    let spaced = false;
    let end = e;
    const um = UNIT_RE.exec(rest);
    if (um) {
      unit = UNIT_OF[um[2]];
      spaced = um[1].length > 0;
      end = e + um[0].length;
      rest = text.slice(end);
    }
    if (DEGREE_RE.test(rest)) continue;
    if (unit === null) {
      if (/^[A-Za-z%]/.test(rest) && !/^[xX\u00d7]\s?\d/.test(rest)) continue; // 120V, 304SS, 18UNF, 8X
      if (/^\s?[-:/]\s?\d/.test(rest)) continue; // ranges, dates, ratios
    } else {
      if (unit === 'in' && PIPE_THREAD_RE.test(rest)) continue; // 1.5"NPT
      if (unit === 'ft' && /^\s?-\s?\d/.test(rest)) continue; // 5'-3" compound values are not parsed
    }
    const value = parseFloat(m[0].replace(/\s/g, ''));
    // a length of 0 is never a dimension (usually a circle or "O" read as a digit)
    if (!Number.isFinite(value) || value === 0) continue;
    out.push({ start: s, end, value, unit, spaced, kind: kindFromPrefix(before), hasUnit: unit !== null });
  }
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
  const cands = scan(text);
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
export function detectDimensions(drawing: Drawing): Dimension[] {
  const dims: Dimension[] = [];
  const visit = (entities: Entity[]) => {
    for (const e of entities) {
      if (e.kind !== 'text') continue;
      for (const t of findLengthTokens(e.text, { isDimension: e.isDimension, dimType: e.dimType })) {
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
  if (o.text !== undefined) return o.text;
  const settings = o.decimals !== undefined ? { ...s, decimals: o.decimals } : s;
  const mm = toMm(d.value, d.unit ?? defaultUnit);
  const f = formatLength(mm, settings);
  let out = d.comma ? f.number.replace('.', ',') : f.number;
  if (d.noLabel && o.suffix === undefined) return out;
  // a suffix chosen for this dimension replaces the label ('' = none)
  const label = o.suffix !== undefined ? o.suffix : f.label;
  const symbol = o.suffix !== undefined ? /^["'\u2033\u2032]$/.test(o.suffix) : f.symbol;
  if (label) {
    const sep = symbol ? '' : d.unit ? (d.spaced ? ' ' : '') : ' ';
    out += sep + label;
  }
  if (/^[A-Za-z]/.test(fullText.slice(d.end))) out += ' '; // "8mmDia" -> "0.31 in Dia"
  return out;
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
    out += original.slice(pos, d.start);
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
