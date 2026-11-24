import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';
import { convertDimension, detectDimensions } from '../src/dimensions';
import { exportPdfOverlay } from '../src/export/pdf';
import { importPdf, uncoveredParts, type PdfJs } from '../src/importers/pdf';
import { renderGeometry } from '../src/render/svg';
import type { TextEntity } from '../src/model';
import { DEFAULT_SETTINGS } from '../src/units';
import { loadPdf } from './helpers';

const pdfjsDir = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));
const docParams = { cMapUrl: `${pdfjsDir}cmaps/`, cMapPacked: true, standardFontDataUrl: `${pdfjsDir}standard_fonts/` };
const IN2 = { ...DEFAULT_SETTINGS, target: 'in' as const, decimals: 2 };

describe('opening a drawing that was converted before', () => {
  it('leaves out the old values under the white patches and shows the patches white', async () => {
    const d = await loadPdf('defrost-heater.pdf');
    const dims = detectDimensions(d);
    const texts = new Map(d.entities.filter((e): e is TextEntity => e.kind === 'text').map((t) => [t.id, t]));
    for (const dim of dims) convertDimension(dim, texts.get(dim.textId)!.text, IN2, 'mm');
    const out = await exportPdfOverlay(d, dims);

    const again = await importPdf(pdfjs as unknown as PdfJs, out.bytes, 'converted.pdf', { docParams });
    const found = detectDimensions(again).map((x) => x.original);
    // the new values are there, the old ones (whited out) are not
    expect(found).toEqual(expect.arrayContaining(['3.50 in', '12.01in']));
    for (const old of ['88.9', '152.4', '305mm', '127']) expect(found).not.toContain(old);
    // the words next to a replaced value stay
    const all = again.entities.filter((e): e is TextEntity => e.kind === 'text').map((t) => t.text).join('|');
    expect(all).toContain('Silicone wire');
    expect(again.warnings.join(' ')).toMatch(/white patches/);
    // a PDF's white is paper: never drawn as black boxes
    const svg = renderGeometry(again, new Set());
    expect(svg).toMatch(/fill:#ffffff/);
  });

  it('cuts covered characters out of a line', () => {
    const t: TextEntity = {
      kind: 'text', id: 't', style: { layer: 'TEXT', color: '#000' }, text: 'Tube 8mm Dia', pos: { x: 0, y: 0 },
      fontSize: 2, rotation: 0, width: 12, widthExact: true, align: 'left',
    };
    // a patch over characters 5..7 ("8mm"): even widths, 1 unit per character
    const poly = [{ x: 5, y: -0.5 }, { x: 8, y: -0.5 }, { x: 8, y: 2 }, { x: 5, y: 2 }];
    const parts = uncoveredParts(t, [{ poly, box: { minX: 5, minY: -0.5, maxX: 8, maxY: 2 } }]);
    expect(parts.map((p) => p.text)).toEqual(['Tube', 'Dia']);
    expect(parts[1].pos.x).toBeCloseTo(9, 5);
  });
});
