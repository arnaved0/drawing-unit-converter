// Minimal DXF group-code tokenizer that keeps the original lines, so a file
// can be edited in place and written back unchanged everywhere else.

export interface Pair {
  code: number;
  value: string;
}

export function splitLines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, eol };
}

export function toPairs(lines: string[]): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push({ code: parseInt(lines[i].trim(), 10), value: lines[i + 1] });
  }
  return pairs;
}

export function fromPairs(pairs: Pair[], eol: string): string {
  const out: string[] = [];
  for (const p of pairs) {
    out.push(String(p.code).padStart(3, ' '), p.value);
  }
  return out.join(eol) + eol;
}

/** Entity type names that appear in the ENTITIES section. */
export function entityTypesInEntitiesSection(text: string): Set<string> {
  const pairs = toPairs(splitLines(text).lines);
  const types = new Set<string>();
  let inEntities = false;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (p.code !== 0) continue;
    const v = p.value.trim();
    if (v === 'SECTION') {
      inEntities = pairs[i + 1]?.code === 2 && pairs[i + 1].value.trim() === 'ENTITIES';
      continue;
    }
    if (v === 'ENDSEC') {
      inEntities = false;
      continue;
    }
    if (inEntities) types.add(v);
  }
  return types;
}
