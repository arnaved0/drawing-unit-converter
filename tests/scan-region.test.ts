import { describe, expect, it } from 'vitest';
import { readRegion } from '../src/scan/ocr';
import { loadModels, renderSample } from './scan-helpers';

describe('reading a user-selected area of a scan', () => {
  it('reads a vertical single-digit dimension in a box around it', async () => {
    const m = await loadModels();
    const img = await renderSample('scanned/defrost-heater-scan.pdf', 200);
    // the "8" next to the top tube of the defrost heater (image pixels at 200 dpi)
    const lines = await readRegion(m, img, 1270, 1240, 60, 90);
    expect(lines.map((l) => l.text)).toContain('8');
  }, 120000);

  it('reads slanted stacked text', async () => {
    const m = await loadModels();
    const img = await renderSample('scanned/arc-element-scan.pdf', 200);
    const lines = await readRegion(m, img, 2840, 1200, 130, 110);
    expect(lines.some((l) => l.text.replace(/\s/g, '') === '11.2mm')).toBe(true);
  }, 120000);
});
