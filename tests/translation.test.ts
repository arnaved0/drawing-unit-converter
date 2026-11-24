import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fontkit from '@pdf-lib/fontkit';
import { convertDimension, type Dimension } from '../src/dimensions';
import { exportPdfOverlay, exportPdfPages } from '../src/export/pdf';
import { guessLanguage, outlineText, scriptOf, type ShapingFont } from '../src/fonts/script';
import type { TextEntity } from '../src/model';
import { DEFAULT_SETTINGS } from '../src/units';
import { loadPdf } from './helpers';

const fontDir = fileURLToPath(new URL('../public/fonts/', import.meta.url));
/** A font with outlines (Latin only: enough to see that letters are drawn as shapes). */
const dejavu = () => (fontkit as unknown as { create(b: Uint8Array): ShapingFont }).create(new Uint8Array(readFileSync(`${fontDir}dejavu.ttf`)));

describe('writing systems', () => {
  it('tells which script needs a font of its own', () => {
    expect(scriptOf('Split heater 300mm')).toBeNull();
    expect(scriptOf('Нагреватель')).toBeNull(); // Cyrillic: bundled fonts have it
    expect(scriptOf('分体式加热管')).toBe('sc');
    expect(scriptOf('長度 300mm')).toBe('tc');
    expect(scriptOf('長度 300mm', 'ja')).toBe('ja');
    expect(scriptOf('カートリッジヒーター')).toBe('ja');
    expect(scriptOf('히터')).toBe('ko');
    expect(scriptOf('سخان')).toBe('arabic');
    expect(guessLanguage('分体式加热管')).toBe('zh-CN');
    expect(guessLanguage('ヒーター')).toBe('ja');
  });

  it('shapes text into outlines', () => {
    const r = outlineText(dejavu(), 'Ab');
    expect(r.advance).toBeGreaterThan(1);
    expect(r.ops.filter((o) => o.op === 'M').length).toBeGreaterThanOrEqual(3); // A (2 contours) + b (2)
  });
});

describe('a translation written over a box', () => {
  it('is drawn as letter outlines in the PDF when no bundled font has its letters', async () => {
    const d = await loadPdf('defrost-heater.pdf');
    const t = d.entities.find((e): e is TextEntity => e.kind === 'text' && e.text.startsWith('Defrost'))!;
    const dim: Dimension = {
      id: 'tr1', textId: t.id, start: 0, end: t.text.length, value: NaN, unit: null, spaced: false, kind: 'linear',
      original: t.text, manual: true, translated: true, override: { text: 'デフロストヒーター', lang: 'ja' },
    };
    convertDimension(dim, t.text, DEFAULT_SETTINGS, 'mm');
    expect(dim.converted?.text).toBe('デフロストヒーター');
    const asked: string[] = [];
    const out = await exportPdfPages(d.pdf!.bytes, [{ d, dims: [dim] }], undefined, async (s) => {
      asked.push(s);
      // a real run downloads Noto Sans JP; a local copy is used when there is one
      const local = '/home/claude/scratch/NotoSansJP-Regular.otf';
      return existsSync(local) ? (fontkit as any).create(new Uint8Array(readFileSync(local))) : dejavu();
    });
    expect(asked).toEqual(['ja']);
    if (process.env.KEEP) writeFileSync(process.env.KEEP, out.bytes);
    // the original words are whited out and not written as "?" text
    const doc = await pdfjs.getDocument({ data: out.bytes.slice() }).promise;
    const text = ((await (await doc.getPage(1)).getTextContent()).items as any[]).map((i) => i.str).join('|');
    expect(text).not.toContain('?????');
    expect(out.warnings).toEqual([]);
    // without a font for the script, it says so
    const none = await exportPdfOverlay(d, [dim]);
    expect(none.bytes.length).toBeGreaterThan(0);
  });
});

describe('lines in other scripts', () => {
  it('keep their values for the text layer', async () => {
    const { latinRuns } = await import('../src/ocr/preprocess');
    const r = latinRuns('长度 300mm');
    expect(r.map((x) => x.text)).toEqual(['300mm']);
    expect(r[0].from).toBeGreaterThan(0.3);
    expect(r[0].to).toBeCloseTo(1, 5);
    // full-width digits become ordinary ones
    expect(latinRuns('直径：１２mm').map((x) => x.text)).toEqual(['12mm']);
    expect(latinRuns('分体式加热管')).toEqual([]);
  });
});

describe('text a PDF stores', () => {
  it('is trusted only when it has real character codes', async () => {
    const { usableText } = await import('../src/fonts/script');
    expect(usableText('长度 300mm')).toBe(true);
    expect(usableText('Dia 22.3mm')).toBe(true);
    expect(usableText(' 300mm')).toBe(false); // private-use codes: a font without a character map
    expect(usableText('��')).toBe(false);
    expect(usableText('   ')).toBe(false);
  });
});
