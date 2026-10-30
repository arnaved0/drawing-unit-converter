/**
 * Pixels per mm to render a scanned page at: the scan's own resolution, but at
 * least ~200 dpi (small drawing text needs the pixels, even upsampled) and at
 * most ~300 dpi / 24 megapixels.
 */
export function scanResolution(nativePxPerMm: number, widthMm: number, heightMm: number): number {
  let px = Math.min(12, Math.max(8, nativePxPerMm || 8));
  const maxPx = 24e6;
  if (widthMm * heightMm * px * px > maxPx) px = Math.sqrt(maxPx / (widthMm * heightMm));
  return px;
}
