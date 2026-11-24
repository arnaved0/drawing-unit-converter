import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { imageDpi } from '../src/importers/image';

/** A PNG with a pHYs chunk inserted after IHDR (pixels per metre). */
function pngWithDpi(dpi: number): Uint8Array {
  const png = new Uint8Array(createCanvas(4, 4).toBuffer('image/png'));
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // per metre
  const ihdrEnd = 8 + 12 + 13;
  return new Uint8Array([...png.subarray(0, ihdrEnd), ...chunk, ...png.subarray(ihdrEnd)]);
}

describe('pictures', () => {
  it('reads the resolution a PNG or JPEG states', () => {
    expect(imageDpi(pngWithDpi(300))).toBe(300);
    // 72 and 96 dpi are what programs write when they do not know: ignored
    expect(imageDpi(pngWithDpi(72))).toBeNull();
    const jfif = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0xc8, 0x00, 0xc8, 0x00, 0x00, 0xff, 0xd9]);
    expect(imageDpi(jfif)).toBe(200);
    expect(imageDpi(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
