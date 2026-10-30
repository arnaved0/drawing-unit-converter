// Decoding and encoding of AutoCAD TEXT / MTEXT strings.
// Decoding keeps a map from each display character back to the raw string so
// that a converted value can be patched into the original file in place,
// keeping all surrounding formatting codes.

export interface DecodedLine {
  text: string;
  /** Raw index where each display character starts. */
  starts: number[];
  /** Raw index just after each display character. */
  ends: number[];
}

const SPECIAL: Record<string, string> = { c: '\u00d8', d: '\u00b0', p: '\u00b1', '%': '%' };

export function decodeDxfText(raw: string, mtext: boolean): DecodedLine[] {
  const lines: DecodedLine[] = [];
  let cur: DecodedLine = { text: '', starts: [], ends: [] };
  const push = (ch: string, s: number, e: number) => {
    cur.text += ch;
    for (let k = 0; k < ch.length; k++) {
      cur.starts.push(s);
      cur.ends.push(e);
    }
  };
  const newline = () => {
    lines.push(cur);
    cur = { text: '', starts: [], ends: [] };
  };
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '%' && raw[i + 1] === '%' && i + 2 < raw.length) {
      const code = raw[i + 2].toLowerCase();
      if (SPECIAL[code]) {
        push(SPECIAL[code], i, i + 3);
        i += 3;
        continue;
      }
      if (code === 'u' || code === 'o' || code === 'k') {
        i += 3;
        continue;
      }
      const num = /^\d{3}/.exec(raw.slice(i + 2));
      if (num) {
        push(String.fromCharCode(parseInt(num[0], 10)), i, i + 5);
        i += 5;
        continue;
      }
    }
    if (ch === '\\') {
      const next = raw[i + 1] ?? '';
      const uni = /^\\U\+([0-9A-Fa-f]{4})/.exec(raw.slice(i, i + 7));
      if (uni) {
        push(String.fromCharCode(parseInt(uni[1], 16)), i, i + 7);
        i += 7;
        continue;
      }
      if (/^\\M\+[0-9A-Fa-f]{5}/.test(raw.slice(i, i + 8))) {
        push('?', i, i + 8);
        i += 8;
        continue;
      }
      if (mtext) {
        if (next === 'P' || next === 'N') {
          newline();
          i += 2;
          continue;
        }
        if (next === '~') {
          push(' ', i, i + 2);
          i += 2;
          continue;
        }
        if (next === '\\' || next === '{' || next === '}') {
          push(next, i, i + 2);
          i += 2;
          continue;
        }
        if ('LlOoKk'.includes(next)) {
          i += 2;
          continue;
        }
        if ('ACcFfHQTWp'.includes(next)) {
          const semi = raw.indexOf(';', i);
          i = semi < 0 ? raw.length : semi + 1;
          continue;
        }
        if (next === 'S') {
          // Stacked fraction \Sa^b; \Sa/b; \Sa#b;
          const semi = raw.indexOf(';', i);
          const end = semi < 0 ? raw.length : semi;
          for (let k = i + 2; k < end; k++) {
            const c = raw[k];
            push(c === '^' || c === '#' ? '/' : c, k, k + 1);
          }
          i = semi < 0 ? raw.length : semi + 1;
          continue;
        }
      }
      push(ch, i, i + 1);
      i += 1;
      continue;
    }
    if (mtext && (ch === '{' || ch === '}')) {
      i += 1;
      continue;
    }
    push(ch, i, i + 1);
    i += 1;
  }
  lines.push(cur);
  return lines;
}

/** Escapes a plain string for a DXF TEXT/MTEXT value. */
export function encodeDxfText(s: string, utf8: boolean, mtext: boolean): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 63;
    if (mtext && (ch === '\\' || ch === '{' || ch === '}')) out += '\\' + ch;
    else if (code < 128 || utf8) out += ch;
    else if (code <= 0xffff) out += `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += '?';
  }
  return out;
}

/** Encoding used by the R12 writer: AutoCAD's %% codes where they exist. */
export function encodeR12Text(s: string): string {
  let out = '';
  // NFKC turns full-width punctuation and digits ("Dia：") into ASCII.
  for (const ch of s.normalize('NFKC')) {
    if (ch === '\u00d8' || ch === '\u2300') out += '%%c';
    else if (ch === '\u00b0') out += '%%d';
    else if (ch === '\u00b1') out += '%%p';
    else if (ch === '%') out += '%%%';
    else out += encodeDxfText(ch, false, false);
  }
  return out;
}
