// Writes conversions back into the original DXF file in place: only the text
// of converted TEXT/MTEXT entities and the text override of converted
// DIMENSION entities change. Every other byte of the file stays as it was.

import { replaceStart, type Dimension } from '../dimensions';
import type { Drawing, TextEntity } from '../model';
import { encodeDxfText } from '../textcodes';

interface ByteLine {
  /** Line content without the line ending. */
  bytes: Uint8Array;
  /** Original line ending bytes ('\r\n', '\n' or ''). */
  eol: Uint8Array;
}

function splitByteLines(buf: Uint8Array): ByteLine[] {
  const out: ByteLine[] = [];
  let s = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      const cr = i > s && buf[i - 1] === 0x0d;
      out.push({ bytes: buf.subarray(s, cr ? i - 1 : i), eol: buf.subarray(cr ? i - 1 : i, i + 1) });
      s = i + 1;
    }
  }
  if (s < buf.length) out.push({ bytes: buf.subarray(s), eol: new Uint8Array(0) });
  return out;
}

const latin1 = new TextDecoder('latin1');
const ascii = (b: Uint8Array) => latin1.decode(b).trim();

interface EntitySpan {
  type: string;
  /** Index of the first pair (the "0 / TYPE" pair). */
  first: number;
  /** Index after the last pair. */
  end: number;
  handle?: string;
}

interface PairRef {
  code: number;
  line: number; // index of the code line; value is line + 1
}

export class DxfPatchError extends Error {}

/** Returns the patched DXF, or throws DxfPatchError when the file cannot be patched in place. */
export function patchDxf(d: Drawing, dims: Dimension[]): Uint8Array {
  if (!d.dxf) throw new DxfPatchError('No DXF source.');
  const { utf8 } = d.dxf;
  const enc = new TextEncoder();
  // `s` is already a raw DXF string (formatting codes intact); only non-ASCII
  // characters need escaping for files that are not UTF-8.
  const encodeValue = (s: string, _mtext: boolean) => enc.encode(encodeDxfText(s, utf8, false));

  // 1. new raw strings per entity handle
  const textEdits = new Map<string, { raw: string; mtext: boolean; edits: { s: number; e: number; text: string }[] }>();
  const dimOverrides = new Map<string, string>();
  const byText = new Map<string, Dimension[]>();
  for (const dim of dims) if (dim.converted) (byText.get(dim.textId) ?? byText.set(dim.textId, []).get(dim.textId)!).push(dim);
  const texts = new Map(d.entities.filter((e): e is TextEntity => e.kind === 'text').map((t) => [t.id, t]));

  const rawAfter = new Map<string, string>(); // per text entity id: raw string after its own edits (for dimension overrides)
  for (const [textId, list] of byText) {
    const t = texts.get(textId);
    if (!t?.dxf) throw new DxfPatchError('A converted text has no link to the DXF file.');
    const key = t.dxf.handle ?? `dim:${t.dxf.dimHandle}`;
    let entry = textEdits.get(key);
    if (!entry) textEdits.set(key, (entry = { raw: t.dxf.raw, mtext: t.dxf.mtext, edits: [] }));
    for (const dim of list) {
      const s = t.dxf.starts[replaceStart(dim, t.text)];
      const e = t.dxf.ends[dim.end - 1];
      if (s === undefined || e === undefined) throw new DxfPatchError('Text mapping is out of range.');
      entry.edits.push({ s, e, text: dim.converted!.text });
    }
  }
  const applyEdits = (raw: string, edits: { s: number; e: number; text: string }[], mtext: boolean) => {
    let out = raw;
    for (const ed of [...edits].sort((a, b) => b.s - a.s)) {
      out = out.slice(0, ed.s) + encodeDxfText(ed.text, true, mtext) + out.slice(ed.e);
    }
    return out;
  };
  for (const [key, entry] of textEdits) rawAfter.set(key, applyEdits(entry.raw, entry.edits, entry.mtext));
  for (const [textId] of byText) {
    const t = texts.get(textId)!;
    if (t.dxf?.dimHandle) dimOverrides.set(t.dxf.dimHandle, rawAfter.get(t.dxf.handle ?? `dim:${t.dxf.dimHandle}`)!);
  }

  // 2. index the file
  const lines = splitByteLines(d.dxf.bytes);
  const spans: EntitySpan[] = [];
  let cur: EntitySpan | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(ascii(lines[i].bytes), 10);
    if (code === 0) {
      if (cur) cur.end = i;
      cur = { type: ascii(lines[i + 1].bytes), first: i, end: lines.length };
      spans.push(cur);
    } else if (code === 5 && cur && cur.handle === undefined) cur.handle = ascii(lines[i + 1].bytes).toUpperCase();
  }
  const byHandle = new Map<string, EntitySpan>();
  for (const s of spans) if (s.handle) byHandle.set(s.handle, s);

  // 3. collect replacements: line index -> new lines (code/value pairs) replacing [from, to)
  const replacements: { from: number; to: number; pairs: [number, Uint8Array][] }[] = [];
  const pairsOf = (span: EntitySpan): PairRef[] => {
    const out: PairRef[] = [];
    for (let i = span.first; i + 1 < span.end; i += 2) out.push({ code: parseInt(ascii(lines[i].bytes), 10), line: i });
    return out;
  };
  const chunked = (value: Uint8Array): [number, Uint8Array][] => {
    // MTEXT: 250-byte chunks in group 3, last chunk in group 1 (do not split UTF-8 sequences)
    const out: [number, Uint8Array][] = [];
    let s = 0;
    while (value.length - s > 250) {
      let e = s + 250;
      while (e > s && (value[e] & 0xc0) === 0x80) e--;
      out.push([3, value.subarray(s, e)]);
      s = e;
    }
    out.push([1, value.subarray(s)]);
    return out;
  };

  for (const [handle, entry] of textEdits) {
    if (handle.startsWith('dim:')) continue; // synthesized dimension text: only the override changes
    const span = byHandle.get(handle.toUpperCase());
    if (!span) throw new DxfPatchError(`Entity ${handle} not found in the DXF file.`);
    const pairs = pairsOf(span).filter((p) => p.code === 1 || p.code === 3);
    if (!pairs.length) throw new DxfPatchError(`Entity ${handle} has no text value.`);
    const value = encodeValue(rawAfter.get(handle)!, entry.mtext);
    if (entry.mtext) {
      // replace all 3/1 pairs (they are consecutive in valid files) with new chunks
      const first = pairs[0].line;
      const last = pairs[pairs.length - 1].line + 2;
      const between = pairsOf(span).filter((p) => p.line >= first && p.line < last && p.code !== 1 && p.code !== 3);
      replacements.push({ from: first, to: last, pairs: [...chunked(value), ...between.map((p) => [p.code, lines[p.line + 1].bytes] as [number, Uint8Array])] });
    } else {
      const p = pairs.find((x) => x.code === 1)!;
      replacements.push({ from: p.line, to: p.line + 2, pairs: [[1, value]] });
    }
  }

  for (const [dimHandle, raw] of dimOverrides) {
    const span = byHandle.get(dimHandle.toUpperCase());
    if (!span || span.type !== 'DIMENSION') throw new DxfPatchError(`Dimension ${dimHandle} not found in the DXF file.`);
    const value = encodeValue(raw, true);
    const pairs = pairsOf(span);
    // group 1 of the AcDbDimension subclass
    const subStart = pairs.findIndex((p) => p.code === 100 && ascii(lines[p.line + 1].bytes) === 'AcDbDimension');
    const scope = subStart >= 0 ? pairs.slice(subStart + 1, (() => {
      const n = pairs.findIndex((p, i) => i > subStart && p.code === 100);
      return n < 0 ? pairs.length : n;
    })()) : pairs;
    const existing = scope.find((p) => p.code === 1);
    if (existing) replacements.push({ from: existing.line, to: existing.line + 2, pairs: [[1, value]] });
    else {
      const after = [42, 72, 71, 70].map((c) => scope.find((p) => p.code === c)).find(Boolean) ?? scope[scope.length - 1] ?? pairs[0];
      replacements.push({ from: after.line + 2, to: after.line + 2, pairs: [[1, value]] });
    }
  }

  // 4. rebuild
  replacements.sort((a, b) => a.from - b.from);
  const eolDefault = lines[0]?.eol.length ? lines[0].eol : enc.encode('\r\n');
  const chunks: Uint8Array[] = [];
  let li = 0;
  for (const r of replacements) {
    for (; li < r.from; li++) chunks.push(lines[li].bytes, lines[li].eol);
    for (const [code, val] of r.pairs) chunks.push(enc.encode(String(code).padStart(3, ' ')), eolDefault, val, eolDefault);
    li = Math.max(li, r.to);
  }
  for (; li < lines.length; li++) chunks.push(lines[li].bytes, lines[li].eol);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
