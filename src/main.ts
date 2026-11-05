import './styles.css';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { convertDimension, detectDimensions, findLengthTokens, replacementText, type Dimension } from './dimensions';
import { addBoxedText, textFromBox, textFromPlacement, type Placement } from './boxes';
import { apply, invert } from './geom';
import { DxfPatchError, patchDxf } from './export/dxfPatch';
import { writeDxfR12 } from './export/dxfR12';
import { exportPdfPages, exportPdfPlot } from './export/pdf';
import { importDwg } from './importers/dwg';
import { importDxf } from './importers/dxf';
import { importPdf, type PdfJs, type TextStyleHint } from './importers/pdf';
import type { Box, Drawing, Entity, LengthUnit, Pt, TextEntity } from './model';
import { dimPolygon, layoutText, renderDimensionLayer, renderGeometry } from './render/svg';
import { matchFonts, normaliseOcrText, placeFit, placeLine, preprocessPage, type PreprocessResult } from './ocr/preprocess';
import { advance, fontBytes, getFace, loadAllFaces, registerFaces, setFontBase, type Face } from './fonts/faces';
import { canvasRenderer } from './fonts/match';
import type { FoundLine, OcrRequest, OcrResponse } from './ocr/worker';
import { DEFAULT_SETTINGS, formatLength, settingsKey, TARGET_LABELS, type ConversionSettings, type TargetFormat } from './units';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const BASE = import.meta.env.BASE_URL;
setFontBase(BASE);
registerFaces();
const createCanvas = (w: number, h: number) => Object.assign(document.createElement('canvas'), { width: w, height: h });
/** Draws text in the bundled faces, to match OCR text to a font. */
const fontRenderer = canvasRenderer(createCanvas);
const PDF_PARAMS = {
  cMapUrl: `${BASE}vendor/pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${BASE}vendor/pdfjs/standard_fonts/`,
  wasmUrl: `${BASE}vendor/pdfjs/wasm/`,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const svg = $('svg') as unknown as SVGSVGElement;
const geomLayer = document.getElementById('geom') as unknown as SVGGElement;
const dimTextLayer = document.getElementById('dimtexts') as unknown as SVGGElement;
const overlayLayer = document.getElementById('overlays') as unknown as SVGGElement;

// ------------------------------------------------------------------ state

interface State {
  drawing: Drawing | null;
  file: File | null;
  dims: Dimension[];
  /** Settings used for each converted dimension (to redo them when the source unit changes). */
  used: Map<string, ConversionSettings>;
  settings: ConversionSettings;
  sourceUnit: LengthUnit;
  highlight: boolean;
}

const SETTINGS_KEY = 'duc.settings.v1';
function loadSettings(): ConversionSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const state: State = { drawing: null, file: null, dims: [], used: new Map(), settings: loadSettings(), sourceUnit: 'mm', highlight: true };
const view = { x: 0, y: 0, w: 100, h: 100 };

// ------------------------------------------------------------------ helpers

let toastTimer = 0;
function toast(msg: string, error = false, ms = 5000, action?: { label: string; run: () => void }): void {
  const t = $('toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => {
      t.hidden = true;
      action.run();
    };
    t.appendChild(b);
  }
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

function busy(text: string | null, fraction?: number): void {
  $('busy').hidden = text === null;
  if (text) $('busy-text').textContent = text;
  $('busy-progress').hidden = fraction === undefined || text === null;
  if (fraction !== undefined) $('busy-bar').style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

// ------------------------------------------------------------------ Scan & OCR before import

const OCR_KEY = 'duc.ocr.v1';
let ocrWorker: Worker | null = null;
/** "Read text with OCR first": on unless the user turned it off. */
const ocrOn = () => localStorage.getItem(OCR_KEY) !== 'off';

/** Recognises text in a page image in the OCR worker. */
function recogniseInWorker(img: { width: number; height: number; data: Uint8ClampedArray }, pxPerMm: number, regionPad?: number): Promise<FoundLine[]> {
  ocrWorker ??= new Worker(new URL('./ocr/worker.ts', import.meta.url), { type: 'module' });
  const w = ocrWorker;
  return new Promise((resolve, reject) => {
    w.onmessage = (ev: MessageEvent<OcrResponse>) => {
      const m = ev.data;
      // a box is read quickly; only the page pass (and the first model download) shows progress
      if (m.type === 'progress') busy(regionPad === undefined ? `Scan & OCR: ${m.label}…` : `Reading the text in the box: ${m.label}…`, 0.05 + m.fraction * 0.9);
      else if (m.type === 'done') resolve(m.lines);
      else reject(new Error(m.message));
    };
    w.onerror = (ev) => reject(new Error(ev.message || 'The text recognition worker failed to start.'));
    const req: OcrRequest = { base: BASE, width: img.width, height: img.height, data: img.data, pxPerMm, regionPad };
    w.postMessage(req, [img.data.buffer]);
  });
}

/** Adds an invisible text layer with the recognised text to one page of a PDF. */
async function ocrPdf(bytes: Uint8Array, pageIndex: number): Promise<PreprocessResult> {
  const task = pdfjs.getDocument({ data: bytes.slice(), ...PDF_PARAMS });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(Math.min(pageIndex, doc.numPages - 1) + 1);
    await loadAllFaces();
    return await preprocessPage(bytes, page as never, Math.min(pageIndex, doc.numPages - 1), {
      recognise: recogniseInWorker,
      createCanvas,
      render: fontRenderer,
      onProgress: (f, label) => busy(`Scan & OCR: ${label}…`, f < 1 ? 0.02 : 0.97),
    });
  } finally {
    await task.destroy();
  }
}

function download(data: Uint8Array | string, name: string, type: string): void {
  const blob = new Blob([data as BlobPart], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const baseName = () => (state.drawing?.name ?? 'drawing').replace(/\.(pdf|dxf|dwg)$/i, '');

async function encodeImage(img: any): Promise<string> {
  const w = img.width;
  const h = img.height;
  if (!w || !h) return '';
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const n = w * h;
    const src: Uint8Array = img.data;
    const rgba = new Uint8ClampedArray(n * 4);
    if (src.length >= n * 4) rgba.set(src.subarray(0, n * 4));
    else if (src.length >= n * 3) {
      for (let i = 0; i < n; i++) {
        rgba[i * 4] = src[i * 3];
        rgba[i * 4 + 1] = src[i * 3 + 1];
        rgba[i * 4 + 2] = src[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
    } else {
      const row = Math.ceil(w / 8); // 1 bit per pixel
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const bit = (src[y * row + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0;
          const i = (y * w + x) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
          rgba[i + 3] = 255;
        }
      }
    }
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  } else return '';
  return c.toDataURL('image/png');
}

// ------------------------------------------------------------------ loading

// ------------------------------------------------------------------ pages

/** Everything the user did on one page, kept while they look at other pages. */
interface PageState {
  drawing: Drawing;
  dims: Dimension[];
  used: Map<string, ConversionSettings>;
  sourceUnit: LengthUnit;
  undo: Snapshot[];
  view: { x: number; y: number; w: number; h: number };
}
const pageCache = new Map<number, PageState>();
/**
 * The PDF with the OCR text layers of every page read so far: each page is
 * read once and the layers build up, so the download keeps all of them.
 */
let docBytes: Uint8Array<ArrayBuffer> | null = null;

function savePage(): void {
  const d = state.drawing;
  if (!d?.pdf) return;
  pageCache.set(d.pdf.pageIndex, { drawing: d, dims: state.dims, used: state.used, sourceUnit: state.sourceUnit, undo: [...undoStack], view: { ...view } });
}

async function openFile(file: File, pageIndex = 0, fresh = false): Promise<void> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!['pdf', 'dxf', 'dwg'].includes(ext ?? '')) {
    toast('Please choose a .pdf, .dxf or .dwg file.', true);
    return;
  }
  const samePdf = ext === 'pdf' && file === state.file && !fresh;
  if (samePdf) savePage();
  else {
    pageCache.clear();
    docBytes = null;
  }
  const cached = samePdf ? pageCache.get(pageIndex) : undefined;
  if (cached) {
    // back to a page already worked on: no new scan, everything as it was left
    state.drawing = cached.drawing;
    state.dims = cached.dims;
    state.used = cached.used;
    state.sourceUnit = cached.sourceUnit;
    afterLoad({ undo: cached.undo, view: cached.view });
    return;
  }
  busy(ext === 'dwg' ? 'Reading DWG (the DWG reader is about 11 MB and loads once)…' : 'Reading drawing…');
  try {
    const bytes = docBytes ?? new Uint8Array(await file.arrayBuffer());
    let d: Drawing;
    let ocrNote = '';
    let pdfBytes = bytes;
    let textStyles: TextStyleHint[] | undefined;
    if (ext === 'pdf' && ocrOn()) {
      // Scan & OCR first: text drawn as outlines or scanned becomes real text
      const res = await ocrPdf(bytes, pageIndex);
      pdfBytes = res.bytes;
      docBytes = res.bytes;
      textStyles = res.styles;
      ocrNote = res.added
        ? `Scan & OCR added ${res.added} line${res.added === 1 ? '' : 's'} of text read from the page` +
          (res.alreadyText ? ` (${res.alreadyText} more were already text)` : '') +
          '. Values read by OCR can be misread: check them before relying on the result.'
        : res.alreadyText
          ? 'Scan & OCR: all text on this page was already real text, nothing was added.'
          : 'Scan & OCR found no text on this page.';
      if (res.unsupported) ocrNote += ` ${res.unsupported} line${res.unsupported === 1 ? '' : 's'} in a script the PDF font cannot hold (for example Chinese) stayed as drawn.`;
      busy('Reading drawing…');
    }
    if (ext === 'pdf') d = await importPdf(pdfjs as unknown as PdfJs, pdfBytes, file.name, { pageIndex, encodeImage, docParams: PDF_PARAMS, textStyles });
    else if (ext === 'dxf') d = importDxf(bytes, file.name);
    else d = await importDwg(bytes, file.name);
    if (ocrNote) d.warnings.unshift(ocrNote);
    if (ext === 'pdf') docBytes = pdfBytes;
    state.drawing = d;
    state.file = file;
    state.dims = detectDimensions(d);
    state.used = new Map();
    state.sourceUnit = d.detectedDimensionUnit;
    afterLoad();
  } catch (err) {
    console.error(err);
    toast(`Could not open ${file.name}: ${(err as Error).message}`, true, 9000);
  } finally {
    busy(null);
  }
}

function afterLoad(restore?: { undo: Snapshot[]; view: { x: number; y: number; w: number; h: number } }): void {
  const d = state.drawing!;
  $('empty').hidden = true;
  svg.removeAttribute('hidden');
  $('zoom-controls').hidden = false;
  $('file-name').textContent = d.name;
  const pageSel = $<HTMLSelectElement>('page-select');
  if (d.pdf && d.pdf.pageCount > 1) {
    pageSel.innerHTML = Array.from({ length: d.pdf.pageCount }, (_, i) => `<option value="${i}">Page ${i + 1} of ${d.pdf!.pageCount}</option>`).join('');
    pageSel.value = String(d.pdf.pageIndex);
    pageSel.hidden = false;
  } else pageSel.hidden = true;
  $<HTMLSelectElement>('source-unit').value = state.sourceUnit;
  $('source-hint').textContent =
    `Used for values written without a unit (detected ${d.source === 'pdf' ? "from the drawing's notes" : "from the file's settings"}: ${d.detectedDimensionUnit}). Values like "381 mm" keep their own unit.`;
  for (const id of ['export-dxf', 'export-pdf', 'convert-all', 'reset-all']) $<HTMLButtonElement>(id).disabled = false;
  $<HTMLButtonElement>('export-dxf12').disabled = d.source === 'pdf';
  $('export-dxf12').hidden = d.source === 'pdf';
  $('export-dxf').title = d.source === 'pdf' ? 'DXF (R12) with the recognised lines, arcs, circles, text and blocks' : 'DXF: the original file with only the converted texts changed';
  undoStack.length = 0;
  if (restore) undoStack.push(...restore.undo);
  setMode('convert');
  renderStatic();
  renderDynamic();
  renderReport();
  if (restore) {
    Object.assign(view, restore.view);
    applyView();
  } else fit();
  if (!state.dims.length && !restore) toast('No dimensions were found in this drawing.', false, 6000);
}

// ------------------------------------------------------------------ rendering

function textIdsWithDims(): Set<string> {
  return new Set(state.dims.map((d) => d.textId));
}

function renderStatic(): void {
  if (!state.drawing) return;
  geomLayer.innerHTML = renderGeometry(state.drawing, textIdsWithDims());
}

/** Converted texts, white-outs, highlight boxes and move handles. */
function renderLayer(): void {
  if (!state.drawing) return;
  const { texts, overlays } = renderDimensionLayer(state.drawing, state.dims, state.highlight);
  dimTextLayer.innerHTML = texts;
  overlayLayer.innerHTML = overlays;
  updateHandles();
}

// ------------------------------------------------------------------ move handles on hover

/** Where the pointer last was over the drawing (SVG coordinates), null when it left. */
let pointer: { x: number; y: number } | null = null;
/** How close (screen pixels) the pointer must be to a converted value for its handle to show. */
const NEAR_PX = 28;

/** Shows the move handles of the converted values the pointer is on or near; hides the others. */
function updateHandles(): void {
  const s = Math.max(view.w / (svg.clientWidth || 1), view.h / (svg.clientHeight || 1));
  const pad = NEAR_PX * s;
  const handles = [...overlayLayer.querySelectorAll<SVGGElement>('.handle')];
  // distance from the pointer to each value's area (0 inside); SVG y is the negated drawing y
  const dist = handles.map((h) => {
    if (!pointer) return Infinity;
    const [x0, y0, x1, y1] = (h.dataset.near ?? '').split(' ').map(Number);
    const dx = Math.max(x0 - pointer.x, 0, pointer.x - x1);
    const dy = Math.max(y0 + pointer.y, 0, -pointer.y - y1);
    return Math.hypot(dx, dy);
  });
  // only the nearest value's handle (or every value the pointer is inside)
  const best = Math.min(...dist);
  handles.forEach((h, k) => {
    const show = moving ? moving.text.id === h.dataset.handle : dist[k] <= pad && (dist[k] === 0 || dist[k] === best);
    h.classList.toggle('near', show);
  });
}

function renderDynamic(): void {
  if (!state.drawing) return;
  renderLayer();
  renderList();
}

function textOf(id: string): TextEntity | undefined {
  return state.drawing?.entities.find((e): e is TextEntity => e.kind === 'text' && e.id === id);
}

function renderList(): void {
  const list = $('dim-list');
  const n = state.dims.length;
  const done = state.dims.filter((d) => d.converted).length;
  $('dim-count').textContent = n ? `${done}/${n}` : '';
  $('dim-hint').textContent = n
    ? 'Click a dimension in the drawing or in this list to convert it. Click it again to undo. × removes a box.'
    : state.drawing
      ? 'No dimensions found. Use "Add box" to mark dimensions by hand.'
      : 'Open a drawing to list its dimensions.';
  list.innerHTML = '';
  for (const d of state.dims) {
    const li = document.createElement('li');
    li.dataset.dim = d.id;
    li.className = d.converted ? 'converted' : '';
    const t = textOf(d.textId);
    const ctx = t && t.text.trim() !== d.original.trim() ? t.text : '';
    const open = expanded.has(d.id);
    li.innerHTML =
      `<div class="dim-row"><span class="orig"></span>${d.converted ? '<span class="arrow">→</span><span class="conv"></span>' : ''}<span class="ctx"></span>` +
      `<button class="expand" title="Edit this dimension" aria-label="Edit this dimension" aria-expanded="${open}"></button>` +
      `<button class="remove" title="Remove this box" aria-label="Remove this box">×</button></div>` +
      (open ? editPanel(d, t) : '');
    if (t?.manual) li.classList.add('manual');
    if (d.override || t?.offset) li.classList.add('edited');
    if (open) li.classList.add('open');
    li.querySelector('.orig')!.textContent = d.original;
    if (d.converted) li.querySelector('.conv')!.textContent = d.converted.text;
    li.querySelector('.ctx')!.textContent = ctx;
    li.title = t?.text ?? '';
    if (open) (li.querySelector('.e-text') as HTMLInputElement).value = d.converted?.text ?? previewText(d);
    list.appendChild(li);
  }
}

// ------------------------------------------------------------------ editing one dimension

/** Dimensions whose edit panel is open in the list. */
const expanded = new Set<string>();
const SUFFIXES: [string, string][] = [['', 'None'], ['in', 'in'], ['"', '"'], ['mm', 'mm'], ['cm', 'cm'], ['m', 'm'], ['ft', 'ft'], ["'", "'"]];
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** What a dimension would read once converted with the current settings and its own. */
function previewText(d: Dimension): string {
  const t = textOf(d.textId);
  return t ? replacementText(d, t.text, state.used.get(d.id) ?? state.settings, state.sourceUnit) : d.original;
}

function editPanel(d: Dimension, t: TextEntity | undefined): string {
  const o = d.override ?? {};
  const dec = ['<option value="">Default</option>', ...[0, 1, 2, 3, 4].map((n) => `<option value="${n}"${o.decimals === n ? ' selected' : ''}>${n}</option>`)].join('');
  const suf = ['<option value="">Default</option>', ...SUFFIXES.map(([v, l]) => `<option value="${escHtml('=' + v)}"${o.suffix === v ? ' selected' : ''}>${escHtml(l)}</option>`)].join('');
  return (
    `<div class="dim-edit">` +
    `<label class="e-field e-wide"><span>Converted text</span><input class="e-text" type="text" spellcheck="false" autocomplete="off"/></label>` +
    `<label class="e-field"><span>Decimals</span><select class="e-dec">${dec}</select></label>` +
    `<label class="e-field"><span>Suffix</span><select class="e-suf">${suf}</select></label>` +
    `<div class="e-actions">${t?.offset ? '<button class="btn small e-moveback">Move text back</button>' : ''}` +
    `${d.override ? '<button class="btn small e-reset">Reset</button>' : ''}</div>` +
    `</div>`
  );
}

/** Applies an edit to one dimension and converts it with it. */
function editDimension(id: string, change: (o: NonNullable<Dimension['override']>) => void): void {
  const d = state.dims.find((x) => x.id === id);
  const t = d && textOf(d.textId);
  if (!d || !t) return;
  snapshot();
  const o = { ...(d.override ?? {}) };
  change(o);
  d.override = Object.keys(o).length ? o : undefined;
  convert(d, state.used.get(d.id) ?? state.settings);
  renderDynamic();
}

$('dim-list').addEventListener('change', (ev) => {
  const el = ev.target as HTMLInputElement | HTMLSelectElement;
  const li = el.closest('li');
  const id = li?.dataset.dim;
  if (!id) return;
  if (el.classList.contains('e-text')) {
    const v = el.value;
    editDimension(id, (o) => {
      delete o.text;
      // typed text is kept as it is, unless it is what the settings give anyway
      const d = state.dims.find((x) => x.id === id)!;
      const computed = replacementText({ ...d, override: o }, textOf(d.textId)!.text, state.used.get(d.id) ?? state.settings, state.sourceUnit);
      if (v.trim() && v !== computed) o.text = v;
    });
  } else if (el.classList.contains('e-dec')) {
    editDimension(id, (o) => {
      delete o.text;
      if (el.value === '') delete o.decimals;
      else o.decimals = Number(el.value);
    });
  } else if (el.classList.contains('e-suf')) {
    editDimension(id, (o) => {
      delete o.text;
      if (el.value === '') delete o.suffix;
      else o.suffix = el.value.slice(1);
    });
  }
});

function renderReport(): void {
  const d = state.drawing;
  if (!d) return;
  const s = d.stats;
  const rows: [string, number][] = [
    ['Lines', s.lines], ['Polylines', s.polylines], ['Circles', s.circles], ['Arcs', s.arcs], ['Curves', s.curves],
    ['Filled shapes (arrowheads)', s.solids], ['Texts', s.texts], ['Images', s.images], ['Blocks', s.blocks], ['Block inserts', s.inserts],
    ['Dimensions found', state.dims.length],
  ];
  $('stats').innerHTML = rows.filter(([, v]) => v > 0).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const w = $('warnings');
  w.innerHTML = '';
  for (const msg of d.warnings) {
    const li = document.createElement('li');
    li.textContent = msg;
    w.appendChild(li);
  }
  if (d.source === 'pdf') {
    const li = document.createElement('li');
    li.textContent = 'PDF geometry is stored in paper millimetres (1:1 with the printed sheet), not at the real object size.';
    w.appendChild(li);
  }
}

// ------------------------------------------------------------------ view (pan / zoom)

function applyView(): void {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  const px = svg.clientWidth || 1;
  const py = svg.clientHeight || 1;
  const unitsPerPx = Math.max(view.w / px, view.h / py);
  svg.style.setProperty('--hair', `${unitsPerPx}px`);
  svg.style.setProperty('--hairn', String(unitsPerPx));
}

function fit(): void {
  const b = state.drawing?.bounds;
  if (!b) return;
  const w = Math.max(b.maxX - b.minX, 1e-6);
  const h = Math.max(b.maxY - b.minY, 1e-6);
  const px = svg.clientWidth || 800;
  const py = svg.clientHeight || 600;
  const scale = Math.max(w / px, h / py) * 1.06;
  view.w = px * scale;
  view.h = py * scale;
  view.x = (b.minX + b.maxX) / 2 - view.w / 2;
  view.y = -(b.minY + b.maxY) / 2 - view.h / 2; // SVG y = -drawing y
  applyView();
}

function zoomAt(factor: number, cx: number, cy: number): void {
  // cx, cy in SVG user coordinates
  view.x = cx - (cx - view.x) * factor;
  view.y = cy - (cy - view.y) * factor;
  view.w *= factor;
  view.h *= factor;
  applyView();
}

function clientToSvg(clientX: number, clientY: number): { x: number; y: number } {
  const r = svg.getBoundingClientRect();
  const px = svg.clientWidth || 1;
  const py = svg.clientHeight || 1;
  // preserveAspectRatio xMidYMid meet
  const s = Math.max(view.w / px, view.h / py);
  const ox = view.x - (px * s - view.w) / 2;
  const oy = view.y - (py * s - view.h) / 2;
  return { x: ox + (clientX - r.left) * s, y: oy + (clientY - r.top) * s };
}

svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const p = clientToSvg(ev.clientX, ev.clientY);
  zoomAt(Math.exp(ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015)), p.x, p.y);
  pointer = clientToSvg(ev.clientX, ev.clientY);
  updateHandles();
}, { passive: false });

let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; id: number } | null = null;
/** A box being drawn in "Add box" mode (SVG user coordinates). */
let pick: { x0: number; y0: number; x1: number; y1: number; id: number } | null = null;
const selRect = document.getElementById('selection') as unknown as SVGRectElement;

svg.addEventListener('contextmenu', (ev) => ev.preventDefault());
/** A converted text being moved with its handle. */
let moving: { text: TextEntity; x: number; y: number; from: Pt; id: number; moved: boolean } | null = null;

svg.addEventListener('pointerleave', () => {
  pointer = null;
  if (!moving) updateHandles();
});
svg.addEventListener('pointerdown', (ev) => {
  // a tap (touch screens have no hover) shows the handles near it
  pointer = clientToSvg(ev.clientX, ev.clientY);
  updateHandles();
  const handle = (ev.target as Element).closest?.('.handle.near[data-handle]') as SVGElement | null;
  if (handle && ev.button === 0) {
    const t = textOf(handle.dataset.handle!);
    if (t) {
      ev.preventDefault();
      const p = clientToSvg(ev.clientX, ev.clientY);
      moving = { text: t, x: p.x, y: p.y, from: t.offset ?? { x: 0, y: 0 }, id: ev.pointerId, moved: false };
      svg.setPointerCapture(ev.pointerId);
      svg.classList.add('moving');
      return;
    }
  }
  // right or middle button always pans; left button draws a box in "Add box" mode
  if (ev.button === 0 && mode === 'add' && state.drawing) {
    ev.preventDefault(); // no text selection while drawing a box
    const p = clientToSvg(ev.clientX, ev.clientY);
    pick = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, id: ev.pointerId };
    svg.setPointerCapture(ev.pointerId);
    return;
  }
  if (ev.button > 2) return;
  drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: ev.button !== 0, id: ev.pointerId };
  if (ev.button !== 0) svg.setPointerCapture(ev.pointerId);
});
svg.addEventListener('pointermove', (ev) => {
  pointer = clientToSvg(ev.clientX, ev.clientY);
  if (!moving && !pick && !drag?.moved) updateHandles();
  if (moving && moving.id === ev.pointerId) {
    const p = clientToSvg(ev.clientX, ev.clientY);
    if (!moving.moved) {
      snapshot();
      moving.moved = true;
    }
    // SVG y is the negated drawing y
    moving.text.offset = { x: moving.from.x + (p.x - moving.x), y: moving.from.y - (p.y - moving.y) };
    renderLayer();
    return;
  }
  if (pick && pick.id === ev.pointerId) {
    const p = clientToSvg(ev.clientX, ev.clientY);
    pick.x1 = p.x;
    pick.y1 = p.y;
    selRect.removeAttribute('hidden');
    selRect.setAttribute('x', String(Math.min(pick.x0, pick.x1)));
    selRect.setAttribute('y', String(Math.min(pick.y0, pick.y1)));
    selRect.setAttribute('width', String(Math.abs(pick.x1 - pick.x0)));
    selRect.setAttribute('height', String(Math.abs(pick.y1 - pick.y0)));
    return;
  }
  if (!drag || drag.id !== ev.pointerId) return;
  const dx = ev.clientX - drag.x;
  const dy = ev.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) {
    drag.moved = true;
    svg.setPointerCapture(ev.pointerId);
    svg.classList.add('panning');
  }
  const s = Math.max(view.w / (svg.clientWidth || 1), view.h / (svg.clientHeight || 1));
  view.x = drag.vx - dx * s;
  view.y = drag.vy - dy * s;
  applyView();
});
svg.addEventListener('pointerup', (ev) => {
  if (moving && moving.id === ev.pointerId) {
    const m = moving;
    moving = null;
    svg.classList.remove('moving');
    updateHandles();
    if (m.moved) {
      renderList();
      toast('Moved the converted text. The original stays covered.', false, 4000, { label: 'Undo', run: undo });
    }
    return;
  }
  if (pick && pick.id === ev.pointerId) {
    const p = pick;
    pick = null;
    selRect.setAttribute('hidden', '');
    // SVG y is the negated drawing y
    const box = { minX: Math.min(p.x0, p.x1), maxX: Math.max(p.x0, p.x1), minY: -Math.max(p.y0, p.y1), maxY: -Math.min(p.y0, p.y1) };
    void addBox(box);
    return;
  }
  const d = drag;
  drag = null;
  svg.classList.remove('panning');
  if (!d || d.moved) return;
  const target = (ev.target as Element).closest?.('[data-dim]') as SVGElement | null;
  if (!target?.dataset.dim) return;
  if (mode === 'remove') removeDimension(target.dataset.dim);
  else toggleDimension(target.dataset.dim);
});
svg.addEventListener('pointercancel', () => {
  moving = null;
  pointer = null;
  updateHandles();
  svg.classList.remove('moving');
  drag = null;
  pick = null;
  selRect.setAttribute('hidden', '');
  svg.classList.remove('panning');
});
window.addEventListener('resize', () => applyView());
$('zoom-in').addEventListener('click', () => zoomAt(1 / 1.4, view.x + view.w / 2, view.y + view.h / 2));
$('zoom-out').addEventListener('click', () => zoomAt(1.4, view.x + view.w / 2, view.y + view.h / 2));
$('zoom-fit').addEventListener('click', fit);

// ------------------------------------------------------------------ conversion

function convert(d: Dimension, s: ConversionSettings): void {
  const t = textOf(d.textId);
  if (!t) return;
  convertDimension(d, t.text, s, state.sourceUnit);
  state.used.set(d.id, { ...s });
}

function toggleDimension(id: string): void {
  const d = state.dims.find((x) => x.id === id);
  if (!d) return;
  const key = `${settingsKey(state.settings)}|${state.sourceUnit}`;
  if (d.converted && d.converted.key === key) {
    d.converted = undefined;
    state.used.delete(d.id);
  } else convert(d, state.settings);
  renderDynamic();
}

function locate(id: string): void {
  const d = state.dims.find((x) => x.id === id);
  const t = d && textOf(d.textId);
  if (!d || !t) return;
  const poly = dimPolygon(t, layoutText(t, state.dims.filter((x) => x.textId === t.id)), d.id);
  const cx = poly.reduce((a, p) => a + p.x, 0) / poly.length;
  const cy = -poly.reduce((a, p) => a + p.y, 0) / poly.length;
  const minW = t.fontSize * 40;
  if (view.w > minW * 4 || view.w < minW / 4) {
    const k = minW / view.w;
    view.w *= k;
    view.h *= k;
  }
  view.x = cx - view.w / 2;
  view.y = cy - view.h / 2;
  applyView();
  const el = overlayLayer.querySelector(`[data-dim="${id}"]`);
  el?.classList.remove('flash');
  void (el as SVGElement | null)?.getBoundingClientRect();
  el?.classList.add('flash');
}

$('dim-list').addEventListener('click', (ev) => {
  const li = (ev.target as HTMLElement).closest('li');
  if (!li?.dataset.dim) return;
  const id = li.dataset.dim;
  const target = ev.target as HTMLElement;
  if (target.closest('.expand')) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    renderList();
    return;
  }
  if (target.closest('.e-moveback')) {
    const t = textOf(state.dims.find((x) => x.id === id)?.textId ?? '');
    if (t) {
      snapshot();
      t.offset = undefined;
      renderDynamic();
    }
    return;
  }
  if (target.closest('.e-reset')) {
    editDimension(id, (o) => {
      delete o.text;
      delete o.decimals;
      delete o.suffix;
    });
    return;
  }
  if (target.closest('.dim-edit')) return; // clicks in the edit panel do not convert
  if ((ev.target as HTMLElement).closest('.remove')) {
    removeDimension(li.dataset.dim);
    return;
  }
  if (ev.detail >= 2) return;
  if (mode === 'remove') {
    removeDimension(li.dataset.dim);
    return;
  }
  toggleDimension(li.dataset.dim);
  locate(li.dataset.dim);
});

// ------------------------------------------------------------------ boxes: add, remove, undo

type Mode = 'convert' | 'add' | 'remove';
let mode: Mode = 'convert';
const MODE_HINTS: Record<Mode, string> = {
  convert: 'Click a box to convert its value. Right-drag to pan.',
  add: 'Drag a box around a dimension that was missed. Its text is read for you to check. Right-drag to pan, Esc to stop.',
  remove: 'Click a box to remove it (it was not a dimension, or was read wrongly). Esc to stop.',
};

function setMode(m: Mode): void {
  mode = m;
  svg.classList.toggle('mode-add', m === 'add');
  svg.classList.toggle('mode-remove', m === 'remove');
  for (const b of document.querySelectorAll<HTMLButtonElement>('#box-mode button')) b.classList.toggle('on', b.dataset.mode === m);
  $('box-hint').textContent = MODE_HINTS[m];
}
$('box-mode').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest('button');
  if (b?.dataset.mode) setMode(b.dataset.mode === mode ? 'convert' : (b.dataset.mode as Mode));
});

interface Snapshot {
  entities: Entity[];
  dims: Dimension[];
  used: Map<string, ConversionSettings>;
  /** Where converted texts had been moved to. */
  offsets: Map<TextEntity, Pt | undefined>;
}
const undoStack: Snapshot[] = [];
function snapshot(): void {
  const d = state.drawing;
  if (!d) return;
  const offsets = new Map<TextEntity, Pt | undefined>();
  for (const e of d.entities) if (e.kind === 'text') offsets.set(e, e.offset);
  undoStack.push({ entities: [...d.entities], dims: state.dims.map((x) => ({ ...x })), used: new Map(state.used), offsets });
  if (undoStack.length > 50) undoStack.shift();
}
function undo(): void {
  const s = undoStack.pop();
  const d = state.drawing;
  if (!s || !d) return;
  for (const [t, o] of s.offsets) t.offset = o;
  d.entities = s.entities;
  state.dims = s.dims;
  state.used = s.used;
  d.stats.texts = d.entities.filter((e) => e.kind === 'text').length;
  renderStatic();
  renderDynamic();
  toast('Undone.', false, 2000);
}

function removeDimension(id: string): void {
  const dim = state.dims.find((x) => x.id === id);
  if (!dim) return;
  snapshot();
  state.dims = state.dims.filter((x) => x.id !== id);
  state.used.delete(id);
  const d = state.drawing!;
  // a text the user boxed has no other use: drop it with its last value
  const t = textOf(dim.textId);
  if (t?.manual && !state.dims.some((x) => x.textId === t.id)) d.entities = d.entities.filter((e) => e.id !== t.id);
  renderStatic();
  renderDynamic();
  toast(`Removed "${dim.original}".`, false, 6000, { label: 'Undo', run: undo });
}

type BoxStyle = Pick<TextEntity, 'face' | 'hscale' | 'slant'>;

/** The face family most OCR text on the page was matched to. */
function pageFamily(d: Drawing): Face['family'] | undefined {
  const st = pageStyle(d);
  return st?.face ? getFace(st.face).family : undefined;
}

/** The look most OCR text on the page has (weighted by length): for boxes whose letters could not be measured. */
function pageStyle(d: Drawing): BoxStyle | undefined {
  const count = new Map<string, { n: number; st: BoxStyle }>();
  for (const e of d.entities) {
    if (e.kind !== 'text' || !e.ocr || !e.face) continue;
    const key = e.face;
    const c = count.get(key) ?? { n: 0, st: { face: e.face, hscale: e.hscale, slant: e.slant } };
    c.n += e.text.length;
    count.set(key, c);
  }
  let best: { n: number; st: BoxStyle } | undefined;
  for (const c of count.values()) if (!best || c.n > best.n) best = c;
  return best?.st;
}

/** The text in a box on a PDF page, read with OCR; null when nothing could be read. */
async function readBoxText(d: Drawing, box: Box): Promise<{ text: string; placement: Placement; color: string; style?: BoxStyle } | null> {
  if (!d.pdf) return null;
  const toUser = invert(d.pdf.userToDrawing);
  const task = pdfjs.getDocument({ data: d.pdf.bytes.slice(), ...PDF_PARAMS });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(d.pdf.pageIndex + 1);
    // 200 dpi like the page pass; small boxes are rendered finer
    const boxMm = Math.min(box.maxX - box.minX, box.maxY - box.minY);
    const pxPerMm = Math.min(24, Math.max(200 / 25.4, 40 / Math.max(boxMm, 0.5)));
    const vp = page.getViewport({ scale: (pxPerMm * 25.4) / 72 });
    const corners = [
      { x: box.minX, y: box.minY },
      { x: box.maxX, y: box.maxY },
      { x: box.minX, y: box.maxY },
      { x: box.maxX, y: box.minY },
    ].map((p) => {
      const u = apply(toUser, p);
      return vp.convertToViewportPoint(u.x, u.y) as number[];
    });
    const pad = Math.round(Math.max(8, Math.min(...[0, 1].map((k) => Math.max(...corners.map((c) => c[k])) - Math.min(...corners.map((c) => c[k])))) * 0.2));
    const x0 = Math.floor(Math.min(...corners.map((c) => c[0]))) - pad;
    const y0 = Math.floor(Math.min(...corners.map((c) => c[1]))) - pad;
    const w = Math.ceil(Math.max(...corners.map((c) => c[0]))) + pad - x0;
    const h = Math.ceil(Math.max(...corners.map((c) => c[1]))) + pad - y0;
    if (w * h > 16e6) return null;
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp, canvas, transform: [1, 0, 0, 1, -x0, -y0] } as never).promise;
    const img = ctx.getImageData(0, 0, w, h);
    const lines = await recogniseInWorker({ width: w, height: h, data: img.data.slice() }, pxPerMm, pad);
    if (!lines.length) return null;
    // prefer a line that holds a length, then the most confident one
    const scored = lines
      .map((l) => ({ l, text: normaliseOcrText(l.text) ?? l.text }))
      .sort((a, b) => Number(findLengthTokens(b.text, { isDimension: true }).length > 0) - Number(findLengthTokens(a.text, { isDimension: true }).length > 0) || b.l.confidence - a.l.confidence);
    const best = scored[0];
    const map = (x: number, y: number): [number, number] => {
      const [ux, uy] = vp.convertToPdfPoint(x + x0, y + y0) as number[];
      const p = apply(d.pdf!.userToDrawing, { x: ux, y: uy });
      return [p.x, p.y];
    };
    // the font, size and width of the letters in the box, preferring the page's font
    await loadAllFaces();
    const fit = matchFonts(img, [{ l: best.l, text: best.text }], fontRenderer, pageFamily(d))[0];
    const pl = fit ? placeFit(fit, map) : placeLine(best.l, map);
    const hex = '#' + best.l.rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    return {
      text: best.text,
      placement: { origin: { x: pl.origin[0], y: pl.origin[1] }, across: { x: pl.across[0], y: pl.across[1] }, up: { x: pl.up[0], y: pl.up[1] } },
      color: hex,
      style: fit ? { face: fit.face, hscale: fit.hscale, slant: fit.slant } : pageStyle(d),
    };
  } finally {
    await task.destroy();
  }
}

/** Asks the user to confirm or type the text of a box. Resolves null on cancel. */
function askBoxText(read: string | null): Promise<string | null> {
  const dlg = $<HTMLDialogElement>('box-dialog');
  const input = $<HTMLInputElement>('box-text');
  $('box-read').textContent =
    read === null ? 'Nothing could be read in the box. Type the value as it appears on the drawing.' : 'Read from the drawing. Correct it if needed.';
  input.value = read ?? '';
  // Enter means "Add box" (the form's first button is Cancel)
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      dlg.close('ok');
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
  input.focus();
  input.select();
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null);
  });
}

async function addBox(box: Box): Promise<void> {
  const d = state.drawing;
  if (!d) return;
  if (box.maxX - box.minX < 0.3 || box.maxY - box.minY < 0.3) {
    toast('Drag a box around the dimension (the box was too small).', false, 3500);
    return;
  }
  let read: Awaited<ReturnType<typeof readBoxText>> = null;
  if (d.pdf) {
    busy('Reading the text in the box…');
    try {
      read = await readBoxText(d, box);
    } catch (err) {
      console.warn(err);
    } finally {
      busy(null);
    }
  }
  const text = await askBoxText(read?.text ?? null);
  if (text === null) return;
  const t = read ? textFromPlacement(text, read.placement, read.color, read.text) : textFromBox(text, box);
  // written like the letters in the box (or, when none were read, like the page's other text)
  Object.assign(t, read?.style ?? pageStyle(d) ?? {});
  if (t.face) t.width = advance(getFace(t.face), text) * t.fontSize * (t.hscale ?? 1);
  const edit = addBoxedText(d, state.dims, box, t);
  const added = edit.dims.filter((x) => x.textId === t.id);
  if (!added.length) {
    toast(`"${text}" holds no length to convert (angles and counts are left alone).`, true, 6000);
    return;
  }
  snapshot();
  d.entities = edit.entities;
  state.dims = edit.dims;
  for (const id of edit.replaced) state.used.delete(id);
  d.stats.texts = d.entities.filter((e) => e.kind === 'text').length;
  renderStatic();
  renderDynamic();
  const replaced = edit.replaced.length ? ` It replaces ${edit.replaced.length} box${edit.replaced.length === 1 ? '' : 'es'} that ${edit.replaced.length === 1 ? 'was' : 'were'} there.` : '';
  toast(`Added "${added.map((x) => x.original).join('", "')}".${replaced}`, false, 6000, { label: 'Undo', run: undo });
}

window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).closest?.('input, select, textarea, dialog')) return;
  if (ev.key === 'Escape') setMode('convert');
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    undo();
  }
});

$('convert-all').addEventListener('click', () => {
  for (const d of state.dims) convert(d, state.settings);
  renderDynamic();
});
$('reset-all').addEventListener('click', () => {
  for (const d of state.dims) d.converted = undefined;
  state.used.clear();
  renderDynamic();
});

// ------------------------------------------------------------------ settings panel

const targetSel = $<HTMLSelectElement>('target');
targetSel.innerHTML = (Object.keys(TARGET_LABELS) as TargetFormat[]).map((k) => `<option value="${k}">${TARGET_LABELS[k]}</option>`).join('');

function syncSettingsUi(): void {
  const s = state.settings;
  targetSel.value = s.target;
  $<HTMLSelectElement>('decimals').value = String(s.decimals);
  $<HTMLSelectElement>('denominator').value = String(s.denominator);
  $<HTMLInputElement>('show-unit').checked = s.showUnit;
  $<HTMLSelectElement>('inch-label').value = s.inchLabel;
  $<HTMLInputElement>('trim-zeros').checked = s.trimZeros;
  const frac = s.target === 'in-frac' || s.target === 'ft-in';
  $('decimals-field').hidden = frac;
  $('denominator-field').hidden = !frac;
  $('inch-field').hidden = !(s.target === 'in' || s.target === 'in-frac') || !s.showUnit;
  $('trim-zeros').parentElement!.hidden = frac;
  $('show-unit').parentElement!.hidden = s.target === 'ft-in';
  const ex = formatLength(152.4, s);
  const sep = ex.label && !ex.symbol ? ' ' : '';
  $('example').textContent = `Example: 152.4 mm → ${ex.number}${ex.label ? sep + ex.label : ''}`;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function onSettings(): void {
  const s = state.settings;
  s.target = targetSel.value as TargetFormat;
  s.decimals = Number($<HTMLSelectElement>('decimals').value);
  s.denominator = Number($<HTMLSelectElement>('denominator').value);
  s.showUnit = $<HTMLInputElement>('show-unit').checked;
  s.inchLabel = $<HTMLSelectElement>('inch-label').value as ConversionSettings['inchLabel'];
  s.trimZeros = $<HTMLInputElement>('trim-zeros').checked;
  syncSettingsUi();
}
for (const id of ['target', 'decimals', 'denominator', 'show-unit', 'inch-label', 'trim-zeros']) $(id).addEventListener('change', onSettings);

$('source-unit').addEventListener('change', () => {
  state.sourceUnit = $<HTMLSelectElement>('source-unit').value as LengthUnit;
  // redo existing conversions with the new interpretation
  for (const d of state.dims) {
    const s = state.used.get(d.id);
    if (d.converted && s && !d.unit) convert(d, s);
  }
  renderDynamic();
});

const ocrBox = $<HTMLInputElement>('ocr-first');
ocrBox.checked = ocrOn();
ocrBox.addEventListener('change', () => {
  localStorage.setItem(OCR_KEY, ocrBox.checked ? 'on' : 'off');
  // offer to apply the new setting to the PDF that is open
  $('ocr-again').hidden = !(state.file && state.drawing?.source === 'pdf');
});
$('open-settings').addEventListener('click', () => $<HTMLDialogElement>('settings-dialog').showModal());
$('ocr-again').addEventListener('click', () => {
  $<HTMLDialogElement>('settings-dialog').close();
  $('ocr-again').hidden = true;
  if (state.file) void openFile(state.file, state.drawing?.pdf?.pageIndex ?? 0, true);
});

$<HTMLInputElement>('highlight').addEventListener('change', (ev) => {
  state.highlight = (ev.target as HTMLInputElement).checked;
  renderDynamic();
});

$<HTMLSelectElement>('page-select').addEventListener('change', (ev) => {
  if (state.file) void openFile(state.file, Number((ev.target as HTMLSelectElement).value));
});

// ------------------------------------------------------------------ export

$('export-dxf').addEventListener('click', () => {
  const d = state.drawing;
  if (!d) return;
  const moved = d.entities.some((e) => e.kind === 'text' && !!e.offset);
  if (d.source !== 'pdf' && d.dxf?.hasHandles && moved) toast('Converted text was moved, so a simplified DXF R12 was written (the original file can only have its text changed in place).', false, 7000);
  else if (d.source !== 'pdf' && d.dxf?.hasHandles) {
    try {
      download(patchDxf(d, state.dims), `${baseName()}-converted.dxf`, 'application/dxf');
      return;
    } catch (err) {
      if (!(err instanceof DxfPatchError)) throw err;
      console.warn(err);
      toast('The original DXF could not be edited in place, so a simplified DXF R12 was written instead.', false, 7000);
    }
  }
  download(writeDxfR12(d, state.dims), `${baseName()}-converted.dxf`, 'application/dxf');
});

$('export-dxf12').addEventListener('click', () => {
  const d = state.drawing;
  if (d) download(writeDxfR12(d, state.dims), `${baseName()}-converted-R12.dxf`, 'application/dxf');
});

$('export-pdf').addEventListener('click', async () => {
  const d = state.drawing;
  if (!d) return;
  busy('Writing PDF…');
  try {
    let res;
    if (d.source === 'pdf' && d.pdf) {
      // every page worked on goes into the one download
      const pages = [...pageCache.values()].filter((p) => p.drawing.pdf!.pageIndex !== d.pdf!.pageIndex).map((p) => ({ d: p.drawing, dims: p.dims }));
      pages.push({ d, dims: state.dims });
      res = await exportPdfPages(docBytes ?? d.pdf.bytes, pages, fontBytes);
    } else res = await exportPdfPlot(d, state.dims, fontBytes);
    download(res.bytes, `${baseName()}-converted.pdf`, 'application/pdf');
    if (res.warnings.length) toast(res.warnings.join(' '), false, 7000);
  } catch (err) {
    console.error(err);
    toast(`PDF export failed: ${(err as Error).message}`, true);
  } finally {
    busy(null);
  }
});

// ------------------------------------------------------------------ file input / drag & drop

$<HTMLInputElement>('file-input').addEventListener('change', (ev) => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (f) void openFile(f);
  (ev.target as HTMLInputElement).value = '';
});

const viewer = $('viewer');
viewer.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  viewer.classList.add('dragover');
});
viewer.addEventListener('dragleave', () => viewer.classList.remove('dragover'));
viewer.addEventListener('drop', (ev) => {
  ev.preventDefault();
  viewer.classList.remove('dragover');
  const f = ev.dataTransfer?.files?.[0];
  if (f) void openFile(f);
});

syncSettingsUi();
