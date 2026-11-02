import './styles.css';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { convertDimension, detectDimensions, findLengthTokens, type Dimension } from './dimensions';
import { DxfPatchError, patchDxf } from './export/dxfPatch';
import { writeDxfR12 } from './export/dxfR12';
import { exportPdfOverlay, exportPdfPlot } from './export/pdf';
import { importDwg } from './importers/dwg';
import { importDxf } from './importers/dxf';
import { importPdf, type PdfJs } from './importers/pdf';
import { countEntities, emptyStats, newId, type Drawing, type Entity, type LengthUnit, type TextEntity } from './model';
import { dimPolygon, layoutText, renderDimensionLayer, renderGeometry } from './render/svg';
import type { ScanRequest, ScanResponse } from './scan/worker';
import { scanResolution } from './scan/resolution';
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
    if (ext === 'pdf') d = await importPdf(pdfjs as unknown as PdfJs, bytes, file.name, { pageIndex, encodeImage, docParams: PDF_PARAMS });
    else if (ext === 'dxf') d = importDxf(bytes, file.name);
    else d = await importDwg(bytes, file.name);
    if (d.scan) await processScanned(d);
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

// ------------------------------------------------------------------ scanned pages

let scanWorker: Worker | null = null;
function getScanWorker(): Worker {
  scanWorker ??= new Worker(new URL('./scan/worker.ts', import.meta.url), { type: 'module' });
  return scanWorker;
}

const PT_TO_MM = 25.4 / 72;

/** Renders the scanned page, then reads its text and traces its lines in a worker. */
async function processScanned(d: Drawing): Promise<void> {
  const pdf = d.pdf!;
  busy('Preparing the scanned page…', 0);
  const wMm = pdf.widthPt * PT_TO_MM;
  const hMm = pdf.heightPt * PT_TO_MM;
  const pxPerMm = scanResolution(pdf.imagePx, wMm, hMm);
  const task = pdfjs.getDocument({ data: pdf.bytes.slice(), ...PDF_PARAMS });
  const doc = await task.promise;
  const page = await doc.getPage(pdf.pageIndex + 1);
  const vp = page.getViewport({ scale: (pxPerMm * 25.4) / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas } as never).promise;
  await task.destroy();
  const exact = canvas.width / wMm;
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const href = canvas.toDataURL('image/jpeg', 0.85);

  const result = await new Promise<Extract<ScanResponse, { type: 'done' }>['result']>((resolve, reject) => {
    const w = getScanWorker();
    w.onmessage = (ev: MessageEvent<ScanResponse>) => {
      const m = ev.data;
      if (m.type === 'progress') busy(`Scanned drawing: ${m.label}…`, m.fraction);
      else if (m.type === 'done') resolve(m.result);
      else if (m.type === 'error') reject(new Error(m.message));
    };
    w.onerror = (ev) => reject(new Error(ev.message || 'The scan worker failed to start.'));
    const req: ScanRequest = { type: 'process', base: BASE, width: pixels.width, height: pixels.height, data: pixels.data, pxPerMm: exact, pageHeightMm: canvas.height / exact };
    w.postMessage(req, [pixels.data.buffer]);
  });

  const underlay: Entity = {
    kind: 'image',
    id: newId('img'),
    style: { layer: 'SCAN', color: '#808080' },
    href,
    p00: { x: 0, y: 0 },
    p10: { x: wMm, y: 0 },
    p01: { x: 0, y: hMm },
    pxW: canvas.width,
    pxH: canvas.height,
  };
  d.entities = [underlay, ...result.entities];
  d.blocks = {};
  d.bounds = { minX: 0, minY: 0, maxX: wMm, maxY: hMm };
  d.detectedDimensionUnit = result.detectedUnit;
  d.scan = { href, pxPerMm: exact, processed: true, ocrLines: result.ocrLines, traced: result.traced, skewDeg: result.skewDeg };
  const stats = emptyStats();
  countEntities(result.entities, stats);
  d.stats = stats;
  d.warnings = d.warnings.filter((w) => !/Images were found/.test(w));
  d.warnings.unshift(
    `Scanned page: ${result.ocrLines} text lines were read and ${result.traced} lines, arcs, circles and arrowheads were traced. ` +
      'Text recognition can misread characters: check values marked "?" and use the pencil button in the list to correct them before converting.',
  );
  if (Math.abs(result.skewDeg) > 0.2) d.warnings.push(`The scan is tilted by about ${result.skewDeg.toFixed(1)}°; traced lines keep that tilt.`);
}

let viewMode: 'scan' | 'traced' | 'both' = 'scan';
function setViewMode(mode: typeof viewMode): void {
  viewMode = mode;
  svg.classList.remove('mode-scan', 'mode-traced', 'mode-both');
  if (state.drawing?.scan) svg.classList.add(`mode-${mode}`);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#view-mode button')) b.classList.toggle('on', b.dataset.mode === mode);
}
$('view-mode').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest('button');
  if (b?.dataset.mode) setViewMode(b.dataset.mode as typeof viewMode);
});

/** Reads the text inside a box drawn on the scan (SVG coordinates: x, -y of the drawing). */
async function readArea(sx: number, sy: number, sw: number, sh: number): Promise<void> {
  const d = state.drawing;
  if (!d?.scan || sw <= 0 || sh <= 0) return;
  const px = d.scan.pxPerMm;
  const pageH = d.bounds.maxY;
  if (sw * px < 6 || sh * px < 6) {
    toast('Drag a larger box around the text.', false, 3000);
    return;
  }
  busy('Reading the selected area…');
  try {
    const texts = await new Promise<TextEntity[]>((resolve, reject) => {
      const w = getScanWorker();
      w.onmessage = (ev: MessageEvent<ScanResponse>) => {
        if (ev.data.type === 'region-done') resolve(ev.data.texts);
        else if (ev.data.type === 'error') reject(new Error(ev.data.message));
      };
      const req: ScanRequest = { type: 'region', x: sx * px, y: (pageH + sy) * px, w: sw * px, h: sh * px };
      w.postMessage(req);
    });
    if (!texts.length) {
      toast('No text was found in that area.', false, 4000);
      return;
    }
    // replace texts that were read before inside the box
    const inBox = (t: TextEntity) => {
      const cx = t.pos.x + (Math.cos(t.rotation) * t.width) / 2;
      const cy = -(t.pos.y + (Math.sin(t.rotation) * t.width) / 2);
      return cx >= sx && cx <= sx + sw && cy >= sy && cy <= sy + sh;
    };
    const old = new Set(d.entities.filter((e): e is TextEntity => e.kind === 'text' && inBox(e)).map((e) => e.id));
    d.entities = d.entities.filter((e) => !old.has(e.id)).concat(texts);
    state.dims = state.dims.filter((x) => !old.has(x.textId));
    for (const t of texts) {
      findLengthTokens(t.text).forEach((tok, i) =>
        state.dims.push({ ...tok, id: `${t.id}-r${i}`, textId: t.id, original: t.text.slice(tok.start, tok.end) }),
      );
    }
    d.stats.texts = d.entities.filter((e) => e.kind === 'text').length;
    renderStatic();
    renderDynamic();
    renderReport();
    toast(`Read: ${texts.map((t) => `"${t.text}"`).join(', ')}`, false, 5000);
  } catch (err) {
    toast(`Could not read the area: ${(err as Error).message}`, true);
  } finally {
    busy(null);
  }
}

/** Lets the user fix a text the scan reader got wrong; its dimensions are found again. */
function editText(textId: string): void {
  const t = textOf(textId);
  if (!t) return;
  const next = window.prompt('Correct the text read from the scan (leave it empty to remove it):', t.text);
  if (next === null || next === t.text) return;
  if (next.trim() === '') {
    // not text at all (a misread mark): drop it and its values
    const d = state.drawing!;
    d.entities = d.entities.filter((e) => e.id !== textId);
    for (const x of state.dims) if (x.textId === textId) state.used.delete(x.id);
    state.dims = state.dims.filter((x) => x.textId !== textId);
    d.stats.texts = d.entities.filter((e) => e.kind === 'text').length;
    renderStatic();
    renderDynamic();
    renderReport();
    return;
  }
  const scale = [...next].length / Math.max(1, [...t.text].length);
  t.text = next.trim();
  t.width *= scale;
  t.ocrConfidence = 1;
  const others = state.dims.filter((x) => x.textId !== textId);
  for (const x of state.dims) if (x.textId === textId) state.used.delete(x.id);
  const fresh = findLengthTokens(t.text, { isDimension: t.isDimension, dimType: t.dimType }).map((tok, i) => ({
    ...tok,
    id: `${textId}-e${Date.now()}-${i}`,
    textId,
    original: t.text.slice(tok.start, tok.end),
  }));
  // keep list order: put the corrected text's dimensions where the old ones were
  const at = state.dims.findIndex((x) => x.textId === textId);
  state.dims = at < 0 ? [...others, ...fresh] : [...others.slice(0, at), ...fresh, ...others.slice(at)];
  renderStatic();
  renderDynamic();
  renderReport();
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
  $('export-dxf').title = d.scan
    ? 'DXF (R12) traced from the scan: lines, arcs, circles, arrowheads and the text that was read'
    : d.source === 'pdf'
      ? 'DXF (R12) with the recognised lines, arcs, circles, text and blocks'
      : 'DXF: the original file with only the converted texts changed';
  $('view-mode').hidden = !d.scan;
  $('read-area').hidden = !d.scan;
  setPicking(false);
  setViewMode(d.scan ? viewMode : 'scan');
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

const PENCIL =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M11.5 2.5l2 2L6 12l-3 1 1-3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

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
    const unsure = t?.ocrConfidence !== undefined && t.ocrConfidence < 0.9;
    li.innerHTML =
      `${unsure ? '<span class="flag" title="Read from the scan with low confidence: please check">?</span>' : ''}<span class="orig"></span>` +
      `${d.converted ? '<span class="arrow">→</span><span class="conv"></span>' : ''}<span class="ctx"></span>` +
      `${t?.ocrConfidence !== undefined ? `<button class="edit" title="Correct the text read from the scan" aria-label="Correct text">${PENCIL}</button>` : ''}`;
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
    if (d.scan) $('report').setAttribute('open', '');
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
let picking = false;
let pick: { x0: number; y0: number; x1: number; y1: number; id: number } | null = null;
const selRect = document.getElementById('selection') as unknown as SVGRectElement;

function setPicking(on: boolean): void {
  picking = on;
  svg.classList.toggle('picking', on);
  $('read-area').classList.toggle('on', on);
  if (!on) selRect.setAttribute('hidden', '');
}
$('read-area').addEventListener('click', () => {
  setPicking(!picking);
  if (picking) toast('Drag a box around the text to read.', false, 4000);
});

svg.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  if (picking) {
    const p = clientToSvg(ev.clientX, ev.clientY);
    pick = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, id: ev.pointerId };
    svg.setPointerCapture(ev.pointerId);
    return;
  }
  drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false, id: ev.pointerId };
});
svg.addEventListener('pointermove', (ev) => {
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
  if (pick && pick.id === ev.pointerId) {
    const p = pick;
    pick = null;
    setPicking(false);
    void readArea(Math.min(p.x0, p.x1), Math.min(p.y0, p.y1), Math.abs(p.x1 - p.x0), Math.abs(p.y1 - p.y0));
    return;
  }
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
  if ((ev.target as HTMLElement).closest('.edit')) {
    const dim = state.dims.find((x) => x.id === li.dataset.dim);
    if (dim) editText(dim.textId);
    return;
  }
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
