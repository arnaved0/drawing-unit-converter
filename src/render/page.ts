// The page of a PDF (or an opened image) drawn exactly as a PDF viewer shows
// it, behind the SVG of the converted values. The vector shapes read from the
// PDF are used for DXF export and for finding text, but on screen nothing is
// rebuilt from them: clipping, patterns, shadings, images and colours appear
// as they are in the file.
//
// A whole-page picture is drawn first (fast to pan and zoom); once the view
// settles, the visible part is rendered again at screen resolution, so the
// drawing stays sharp at any zoom.

import { invert, mul, type Mat } from '../geom';

/** The parts of a pdf.js page used here. */
export interface RenderablePage {
  getViewport(o: { scale: number }): { width: number; height: number; transform: number[] };
  render(o: unknown): { promise: Promise<void>; cancel(): void };
}

export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layer {
  source: CanvasImageSource;
  /** Pixels of `source` -> drawing coordinates. */
  toDrawing: Mat;
  /** Drawing units per pixel of the source. */
  unitsPerPx: number;
}

/** Most pixels for the whole-page picture. */
const BASE_PIXELS = 12e6;
/** Pixels per mm of the whole-page picture, at most (about 200 dpi). */
const BASE_PX_PER_MM = 8;

export class PageBackground {
  private base: Layer | null = null;
  private detail: (Layer & { view: View }) | null = null;
  private page: RenderablePage | null = null;
  private userToDrawing: Mat = [1, 0, 0, 1, 0, 0];
  private task: { cancel(): void } | null = null;
  private timer = 0;
  private generation = 0;

  constructor(private canvas: HTMLCanvasElement) {}

  /** Nothing drawn (a DXF or DWG is drawn from its shapes). */
  clear(): void {
    this.generation++;
    this.task?.cancel();
    this.task = null;
    this.base = null;
    this.detail = null;
    this.page = null;
    this.canvas.hidden = true;
  }

  get active(): boolean {
    return !!this.base;
  }

  /**
   * Shows a PDF page. `userToDrawing` maps PDF user space to drawing
   * coordinates. Resolves once the whole-page picture is ready.
   */
  async show(page: RenderablePage, userToDrawing: Mat): Promise<void> {
    this.clear();
    const gen = this.generation;
    this.page = page;
    this.userToDrawing = userToDrawing;
    const one = page.getViewport({ scale: 1 });
    const mmPerPt = Math.sqrt(Math.abs(userToDrawing[0] * userToDrawing[3] - userToDrawing[1] * userToDrawing[2]));
    let scale = BASE_PX_PER_MM * mmPerPt;
    if (one.width * one.height * scale * scale > BASE_PIXELS) scale = Math.sqrt(BASE_PIXELS / (one.width * one.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(vp.width));
    c.height = Math.max(1, Math.round(vp.height));
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    const task = page.render({ canvasContext: ctx, viewport: vp, canvas: c });
    this.task = task;
    await task.promise;
    if (gen !== this.generation) return;
    this.task = null;
    // pixels -> PDF user space -> drawing
    const toDrawing = mul(userToDrawing, invert(vp.transform as Mat));
    this.base = { source: c, toDrawing, unitsPerPx: mmPerPt / scale };
    this.canvas.hidden = false;
  }

  /** Draws the page for the current view; renders the visible part sharper when the view settles. */
  draw(view: View, svgW: number, svgH: number): void {
    if (!this.base) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(svgW * dpr));
    const H = Math.max(1, Math.round(svgH * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    const screen = drawingToScreen(view, svgW, svgH, dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (const layer of [this.base, this.detail]) {
      if (!layer) continue;
      const m = mul(screen, layer.toDrawing);
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.drawImage(layer.source, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // sharper picture of what is on screen, when the whole-page one is coarser than the screen
    clearTimeout(this.timer);
    const unitsPerScreenPx = Math.max(view.w / svgW, view.h / svgH) / dpr;
    const sharp = this.detail && same(this.detail.view, view) ? this.detail : null;
    if (!sharp && this.base.unitsPerPx > unitsPerScreenPx * 1.15) {
      this.timer = window.setTimeout(() => void this.renderDetail({ ...view }, svgW, svgH), 180);
    }
  }

  private async renderDetail(view: View, svgW: number, svgH: number): Promise<void> {
    const page = this.page;
    if (!page) return;
    this.task?.cancel();
    const gen = this.generation;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(svgW * dpr));
    const H = Math.max(1, Math.round(svgH * dpr));
    if (W * H > 40e6) return;
    // PDF user space -> screen pixels; the render draws the page through it
    const screen = drawingToScreen(view, svgW, svgH, dpr);
    const userToScreen = mul(screen, this.userToDrawing);
    const vp = page.getViewport({ scale: 1 });
    // pdf.js applies `transform` before its viewport transform: undo the viewport's
    const transform = mul(userToScreen, invert(vp.transform as Mat));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    const task = page.render({ canvasContext: ctx, viewport: vp, canvas: c, transform });
    this.task = task;
    try {
      await task.promise;
    } catch {
      return; // cancelled by a newer view
    }
    if (gen !== this.generation) return;
    this.task = null;
    this.detail = { source: c, toDrawing: invert(screen), unitsPerPx: Math.max(view.w / svgW, view.h / svgH) / dpr, view };
    this.draw(view, svgW, svgH);
  }
}

const same = (a: View, b: View) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.w - b.w) < 1e-9 && Math.abs(a.h - b.h) < 1e-9;

/**
 * Drawing coordinates -> device pixels of the viewer, as the SVG shows them
 * (viewBox `view`, preserveAspectRatio xMidYMid meet, SVG y = -drawing y).
 */
export function drawingToScreen(view: View, svgW: number, svgH: number, dpr = 1): Mat {
  const s = Math.max(view.w / svgW, view.h / svgH);
  const ox = view.x - (svgW * s - view.w) / 2;
  const oy = view.y - (svgH * s - view.h) / 2;
  return [dpr / s, 0, 0, -dpr / s, (-ox * dpr) / s, (-oy * dpr) / s];
}
