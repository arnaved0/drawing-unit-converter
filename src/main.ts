import './styles.css';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { convertDimension, detectDimensions, type Dimension } from './dimensions';
import { DxfPatchError, patchDxf } from './export/dxfPatch';
import { writeDxfR12 } from './export/dxfR12';
import { exportPdfOverlay, exportPdfPlot } from './export/pdf';
import { importDwg } from './importers/dwg';
import { importDxf } from './importers/dxf';
import { importPdf, type PdfJs } from './importers/pdf';
import type { Drawing, LengthUnit, TextEntity } from './model';
import { dimPolygon, layoutText, renderDimensionLayer, renderGeometry } from './render/svg';
import { preprocessPage, type PreprocessResult } from './ocr/preprocess';
import type { FoundLine, OcrRequest, OcrResponse } from './ocr/worker';
import { DEFAULT_SETTINGS, formatLength, settingsKey, TARGET_LABELS, type ConversionSettings, type TargetFormat } from './units';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const BASE = import.meta.env.BASE_URL;
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
function toast(msg: string, error = false, ms = 5000): void {
  const t = $('toast');
  t.textContent = msg;
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
function recogniseInWorker(img: { width: number; height: number; data: Uint8ClampedArray }, pxPerMm: number): Promise<FoundLine[]> {
  ocrWorker ??= new Worker(new URL('./ocr/worker.ts', import.meta.url), { type: 'module' });
  const w = ocrWorker;
  return new Promise((resolve, reject) => {
    w.onmessage = (ev: MessageEvent<OcrResponse>) => {
      const m = ev.data;
      if (m.type === 'progress') busy(`Scan & OCR: ${m.label}…`, 0.05 + m.fraction * 0.9);
      else if (m.type === 'done') resolve(m.lines);
      else reject(new Error(m.message));
    };
    w.onerror = (ev) => reject(new Error(ev.message || 'The text recognition worker failed to start.'));
    const req: OcrRequest = { base: BASE, width: img.width, height: img.height, data: img.data, pxPerMm };
    w.postMessage(req, [img.data.buffer]);
  });
}

/** Adds an invisible text layer with the recognised text to one page of a PDF. */
async function ocrPdf(bytes: Uint8Array, pageIndex: number): Promise<PreprocessResult> {
  const task = pdfjs.getDocument({ data: bytes.slice(), ...PDF_PARAMS });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(Math.min(pageIndex, doc.numPages - 1) + 1);
    return await preprocessPage(bytes, page as never, Math.min(pageIndex, doc.numPages - 1), {
      recognise: recogniseInWorker,
      createCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
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

async function openFile(file: File, pageIndex = 0): Promise<void> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!['pdf', 'dxf', 'dwg'].includes(ext ?? '')) {
    toast('Please choose a .pdf, .dxf or .dwg file.', true);
    return;
  }
  busy(ext === 'dwg' ? 'Reading DWG (the DWG reader is about 11 MB and loads once)…' : 'Reading drawing…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let d: Drawing;
    let ocrNote = '';
    let pdfBytes = bytes;
    if (ext === 'pdf' && ocrOn()) {
      // Scan & OCR first: text drawn as outlines or scanned becomes real text
      const res = await ocrPdf(bytes, pageIndex);
      pdfBytes = res.bytes;
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
    if (ext === 'pdf') d = await importPdf(pdfjs as unknown as PdfJs, pdfBytes, file.name, { pageIndex, encodeImage, docParams: PDF_PARAMS });
    else if (ext === 'dxf') d = importDxf(bytes, file.name);
    else d = await importDwg(bytes, file.name);
    if (ocrNote) d.warnings.unshift(ocrNote);
    state.drawing = d;
    state.file = file;
    state.dims = detectDimensions(d);
    state.used.clear();
    state.sourceUnit = d.detectedDimensionUnit;
    afterLoad();
  } catch (err) {
    console.error(err);
    toast(`Could not open ${file.name}: ${(err as Error).message}`, true, 9000);
  } finally {
    busy(null);
  }
}

function afterLoad(): void {
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
    d.source === 'pdf' ? `Detected from the drawing's notes and labels: ${d.detectedDimensionUnit}.` : `From the file's unit setting and labels: ${d.detectedDimensionUnit}.`;
  for (const id of ['export-dxf', 'export-pdf', 'convert-all', 'reset-all']) $<HTMLButtonElement>(id).disabled = false;
  $<HTMLButtonElement>('export-dxf12').disabled = d.source === 'pdf';
  $('export-dxf12').hidden = d.source === 'pdf';
  $('export-dxf').title = d.source === 'pdf' ? 'DXF (R12) with the recognised lines, arcs, circles, text and blocks' : 'DXF: the original file with only the converted texts changed';
  renderStatic();
  renderDynamic();
  renderReport();
  fit();
  if (!state.dims.length) toast('No dimensions were found in this drawing.', false, 6000);
}

// ------------------------------------------------------------------ rendering

function textIdsWithDims(): Set<string> {
  return new Set(state.dims.map((d) => d.textId));
}

function renderStatic(): void {
  if (!state.drawing) return;
  geomLayer.innerHTML = renderGeometry(state.drawing, textIdsWithDims());
}

function renderDynamic(): void {
  if (!state.drawing) return;
  const { texts, overlays } = renderDimensionLayer(state.drawing, state.dims, state.highlight);
  dimTextLayer.innerHTML = texts;
  overlayLayer.innerHTML = overlays;
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
    ? 'Click a dimension in the drawing or in this list to convert it. Click it again to undo.'
    : state.drawing
      ? 'No dimensions found. Dimensions must be text (not outlines or a scan).'
      : 'Open a drawing to list its dimensions.';
  list.innerHTML = '';
  for (const d of state.dims) {
    const li = document.createElement('li');
    li.dataset.dim = d.id;
    li.className = d.converted ? 'converted' : '';
    const t = textOf(d.textId);
    const ctx = t && t.text.trim() !== d.original.trim() ? t.text : '';
    li.innerHTML = `<span class="orig"></span>${d.converted ? '<span class="arrow">→</span><span class="conv"></span>' : ''}<span class="ctx"></span>`;
    li.querySelector('.orig')!.textContent = d.original;
    if (d.converted) li.querySelector('.conv')!.textContent = d.converted.text;
    li.querySelector('.ctx')!.textContent = ctx;
    li.title = t?.text ?? '';
    list.appendChild(li);
  }
}

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
}, { passive: false });

let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; id: number } | null = null;
svg.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false, id: ev.pointerId };
});
svg.addEventListener('pointermove', (ev) => {
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
  const d = drag;
  drag = null;
  svg.classList.remove('panning');
  if (!d || d.moved) return;
  const target = (ev.target as Element).closest?.('[data-dim]') as SVGElement | null;
  if (target?.dataset.dim) toggleDimension(target.dataset.dim);
});
svg.addEventListener('pointercancel', () => {
  drag = null;
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
  if (ev.detail >= 2) return;
  toggleDimension(li.dataset.dim);
  locate(li.dataset.dim);
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
$('ocr-again').addEventListener('click', () => {
  $('ocr-again').hidden = true;
  if (state.file) void openFile(state.file, state.drawing?.pdf?.pageIndex ?? 0);
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
  if (d.source !== 'pdf' && d.dxf?.hasHandles) {
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
    const res = d.source === 'pdf' ? await exportPdfOverlay(d, state.dims) : await exportPdfPlot(d, state.dims);
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
