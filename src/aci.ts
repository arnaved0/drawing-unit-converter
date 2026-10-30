// AutoCAD Color Index helpers.
import ACI from 'dxf-parser/dist/AutoCadColorIndex.js';

const table: number[] = ACI as unknown as number[];

export function aciToHex(index: number): string {
  const v = table[index] ?? 0;
  return '#' + v.toString(16).padStart(6, '0');
}

export function intToHex(v: number): string {
  return '#' + (v >>> 0 & 0xffffff).toString(16).padStart(6, '0');
}

function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Colours a drawing on white paper uses for "black"; ACI 7 shows black on white, white on black. */
export function isNearBlackOrWhite(hex: string): boolean {
  const [r, g, b] = rgb(hex);
  return (r < 40 && g < 40 && b < 40) || (r > 235 && g > 235 && b > 235);
}

const cache = new Map<string, number>();

/** Nearest ACI index (1..255) for an RGB colour. Black and white map to 7. */
export function hexToAci(hex: string): number {
  const hit = cache.get(hex);
  if (hit !== undefined) return hit;
  let best = 7;
  if (!isNearBlackOrWhite(hex)) {
    const [r, g, b] = rgb(hex);
    let bestD = Infinity;
    for (let i = 1; i <= 255; i++) {
      if (i === 7) continue;
      const v = table[i];
      const dr = ((v >> 16) & 255) - r;
      const dg = ((v >> 8) & 255) - g;
      const db = (v & 255) - b;
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  cache.set(hex, best);
  return best;
}

/** Colour to show on the white preview: AutoCAD "white" (ACI 7) is drawn black. */
export function displayColor(hex: string): string {
  const [r, g, b] = rgb(hex);
  return r > 235 && g > 235 && b > 235 ? '#000000' : hex;
}
