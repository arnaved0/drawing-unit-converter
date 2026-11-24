import './styles.css';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { canConvert, convertDimension, detectDimensions, diameterSignBefore, findLengthTokens, hasDiameterSign, manualTokens, replacementText, settingsFor, valueRank, type Dimension } from './dimensions';
import { addBoxedText, boxPoly, outlineFrame, polyArea, textFromBox, textFromPlacement, type Placement } from './boxes';
import { apply, invert, pointInPoly, textCorners, type Mat } from './geom';
import { measureInk, pageToImage, renderPageImage } from './ink';
import { DxfPatchError, patchDxf } from './export/dxfPatch';
import { writeDxfR12 } from './export/dxfR12';
import { exportPdfPages, exportPdfPlot } from './export/pdf';
import { importDwg } from './importers/dwg';
import { importDxf } from './importers/dxf';
import { importPdf, type PdfJs, type TextStyleHint } from './importers/pdf';
import { IMAGE_EXTENSIONS, imageToPdf, pdfToImage } from './importers/image';
import type { Box, Drawing, Entity, LengthUnit, Pt, TextEntity } from './model';
import { dimPolygon, layoutText, renderDimensionLayer, renderGeometry } from './render/svg';
import { PageBackground } from './render/page';
import { matchFonts, normaliseOcrText, placeFit, placeLine, preprocessPage, type PreprocessResult } from './ocr/preprocess';
import { advance, fontBytes, getFace, loadAllFaces, registerFaces, setFontBase, type Face } from './fonts/faces';
import { canvasRenderer } from './fonts/match';
import { fixDiameters } from './ocr/diameter';
import type { FoundLine, OcrRequest, OcrResponse } from './ocr/worker';
import { LANGUAGES, languageName, translate } from './translate';
import { usableText, webScriptFont } from './fonts/script';
import { DEFAULT_SETTINGS, formatCustom, formatLength, parseFactor, settingsKey, TARGET_LABELS, type ConversionSettings, type TargetFormat } from './units';

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
/** The PDF page (or image) as rendered, behind the converted values. */
const pageBg = new PageBackground($<HTMLCanvasElement>('page-bg'));
/** The pdf.js document the page background is rendered from. */
let bgDoc: { destroy(): Promise<void> } | null = null;

/** Shows the page of a PDF drawing as rendered; a DXF or DWG is drawn from its shapes. */
async function showPageBackground(d: Drawing): Promise<void> {
  const old = bgDoc;
  bgDoc = null;
  pageBg.clear();
  void old?.destroy();
  if (!d.pdf) return;
  try {
    const task = pdfjs.getDocument({ data: d.pdf.bytes.slice(), ...PDF_PARAMS });
    bgDoc = task;
    const doc = await task.promise;
    const page = await doc.getPage(d.pdf.pageIndex + 1);
    await pageBg.show(page as never, d.pdf.userToDrawing);
  } catch (err) {
    // the shapes read from the PDF are drawn instead
    console.warn('The page could not be rendered; showing the shapes read from it.', err);
    pageBg.clear();
  }
}

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
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return { ...DEFAULT_SETTINGS, ...saved, custom: { ...DEFAULT_SETTINGS.custom, ...saved.custom } };
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

/** Finds the letters of every text on a PDF page (from the scan's render, or a new one). */
async function measurePdfInk(d: Drawing, image?: PreprocessResult['image']): Promise<void> {
  if (!d.pdf) return;
  if (image) {
    measureInk(d, { width: image.width, height: image.height, data: image.data, toImage: pageToImage(image.transform as Mat, d.pdf.userToDrawing) });
    return;
  }
  const task = pdfjs.getDocument({ data: d.pdf.bytes.slice(), ...PDF_PARAMS });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(d.pdf.pageIndex + 1);
    measureInk(d, await renderPageImage(page as never, d.pdf.userToDrawing, createCanvas));
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

const baseName = () => (state.drawing?.name ?? 'drawing').replace(/\.(pdf|dxf|dwg|png|jpe?g|webp|bmp|gif)$/i, '');

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

/** The picture the open drawing came from, put on a PDF page (see importers/image.ts). */
let picture: Drawing['picture'];

async function openFile(file: File, pageIndex = 0, fresh = false): Promise<void> {
  const rawExt = file.name.split('.').pop()?.toLowerCase() ?? '';
  const isPicture = IMAGE_EXTENSIONS.includes(rawExt) || /^image\/(png|jpeg|webp|bmp|gif)$/.test(file.type);
  // a picture is read like a scanned one-page PDF
  const ext = isPicture ? 'pdf' : rawExt;
  if (!['pdf', 'dxf', 'dwg'].includes(ext)) {
    toast('Please choose a PDF, DXF, DWG, PNG or JPEG file.', true);
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
    busy('Drawing the page…');
    await showPageBackground(cached.drawing);
    busy(null);
    afterLoad({ undo: cached.undo, view: cached.view });
    return;
  }
  busy(ext === 'dwg' ? 'Reading DWG (the DWG reader is about 11 MB and loads once)…' : 'Reading drawing…');
  try {
    let bytes = docBytes ?? new Uint8Array(await file.arrayBuffer());
    let pictureNote = '';
    if (isPicture && !docBytes) {
      busy('Reading the picture…');
      const pic = await imageToPdf(file, bytes);
      bytes = pic.bytes;
      picture = { mime: pic.mime, width: pic.width, height: pic.height, dpi: pic.dpi };
      pictureNote = pic.assumedDpi
        ? `The picture does not say its resolution; ${Math.round(pic.dpi)} dpi was assumed (this only sets the paper size of PDF and DXF downloads).`
        : '';
    } else if (!isPicture && !samePdf) picture = undefined;
    let d: Drawing;
    let ocrNote = '';
    let pdfBytes = bytes;
    let textStyles: TextStyleHint[] | undefined;
    let pageImage: PreprocessResult['image'];
    // a picture holds no text of its own: it is always scanned
    if (ext === 'pdf' && (ocrOn() || isPicture)) {
      // Scan & OCR first: text drawn as outlines or scanned becomes real text
      const res = await ocrPdf(bytes, pageIndex);
      pdfBytes = res.bytes;
      docBytes = res.bytes;
      textStyles = res.styles;
      pageImage = res.image;
      ocrNote = res.added
        ? `Scan & OCR added ${res.added} line${res.added === 1 ? '' : 's'} of text read from the page` +
          (res.alreadyText ? ` (${res.alreadyText} more were already text)` : '') +
          '. Values read by OCR can be misread: check them before relying on the result.'
        : res.alreadyText
          ? 'Scan & OCR: all text on this page was already real text, nothing was added.'
          : 'Scan & OCR found no text on this page.';
      if (res.unsupported) ocrNote += ` ${res.unsupported} line${res.unsupported === 1 ? ' is' : 's are'} in another script (for example Chinese): ${res.unsupported === 1 ? 'its' : 'their'} values are found, and "+ Add box" around the text reads or translates it.`;
      busy('Reading drawing…');
    }
    if (ext === 'pdf') d = await importPdf(pdfjs as unknown as PdfJs, pdfBytes, file.name, { pageIndex, encodeImage, docParams: PDF_PARAMS, textStyles });
    else if (ext === 'dxf') d = importDxf(bytes, file.name);
    else d = await importDwg(bytes, file.name);
    if (ocrNote) d.warnings.unshift(ocrNote);
    if (pictureNote) d.warnings.push(pictureNote);
    if (isPicture && picture) d.picture = picture;
    // where each letter is on the page, so a conversion whites out only the letters it replaces
    if (d.pdf) {
      busy('Measuring the text…');
      try {
        await measurePdfInk(d, pageImage);
      } catch (err) {
        console.warn('Could not measure the text; converted values are covered with a band instead.', err);
      }
    }
    if (ext === 'pdf') docBytes = pdfBytes;
    state.drawing = d;
    state.file = file;
    state.dims = detectDimensions(d, { customSuffix: customSuffix() });
    state.used = new Map();
    state.sourceUnit = d.detectedDimensionUnit;
    busy('Drawing the page…');
    await showPageBackground(d);
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
  // page arrows under the drawing, for PDFs with more than one page
  const multi = !!d.pdf && d.pdf.pageCount > 1;
  $('pager').hidden = !multi;
  $('pager').parentElement!.classList.toggle('has-pager', multi);
  if (d.pdf && multi) {
    $('page-num').textContent = `Page ${d.pdf.pageIndex + 1} of ${d.pdf.pageCount}`;
    $<HTMLButtonElement>('page-prev').disabled = d.pdf.pageIndex === 0;
    $<HTMLButtonElement>('page-next').disabled = d.pdf.pageIndex >= d.pdf.pageCount - 1;
  }
  $<HTMLSelectElement>('source-unit').value = state.sourceUnit;
  $('source-hint').textContent =
    `Used for values written without a unit (detected ${d.source === 'pdf' ? "from the drawing's notes" : "from the file's settings"}: ${d.detectedDimensionUnit}). Values like "381 mm" keep their own unit.`;
  for (const id of ['export-dxf', 'export-pdf', 'convert-all', 'reset-all']) $<HTMLButtonElement>(id).disabled = false;
  // a picture downloads as a picture too
  $('export-image').hidden = !d.picture;
  $<HTMLButtonElement>('export-image').disabled = !d.picture;
  if (d.picture) $('export-image').textContent = d.picture.mime === 'image/jpeg' ? 'JPEG' : 'PNG';
  $<HTMLButtonElement>('export-dxf12').disabled = d.source === 'pdf';
  $('export-dxf12').hidden = d.source === 'pdf';
  $('export-dxf').title = d.source === 'pdf' ? 'DXF (R12) with the recognised lines, arcs, circles, text and blocks' : 'DXF: the original file with only the converted texts changed';
  undoStack.length = 0;
  if (restore) undoStack.push(...restore.undo);
  addCustomDimensions();
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
  // the page as rendered shows everything; the shapes read from it are not drawn again
  geomLayer.innerHTML = pageBg.active ? '' : renderGeometry(state.drawing, textIdsWithDims());
}

/** Converted texts, white-outs, highlight boxes and move handles. */
function renderLayer(): void {
  if (!state.drawing) return;
  const { texts, overlays } = renderDimensionLayer(state.drawing, state.dims, state.highlight, pageBg.active);
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
    if (t?.manual && !d.translated) li.classList.add('manual');
    if (d.translated) li.classList.add('translated');
    if (d.override || t?.offset || (t?.sizeScale ?? 1) !== 1 || t?.turn) li.classList.add('edited');
    if (open) li.classList.add('open');
    // the diameter sign belongs to the value, even though only the number is replaced
    const sign = t ? (diameterSignBefore(t.text, d.start)?.sign.trim() ?? '') : '';
    li.querySelector('.orig')!.textContent = sign + d.original;
    if (d.converted) li.querySelector('.conv')!.textContent = (sign && d.override?.diameter === undefined ? sign : '') + d.converted.text;
    li.querySelector('.ctx')!.textContent = ctx;
    li.title = t?.text ?? '';
    if (open) (li.querySelector('.e-text') as HTMLInputElement).value = d.converted?.text ?? previewText(d);
    list.appendChild(li);
  }
}

// ------------------------------------------------------------------ editing one dimension

/** Dimensions whose edit panel is open in the list. */
const expanded = new Set<string>();

/** What a dimension would read once converted with the current settings and its own. */
function previewText(d: Dimension): string {
  const t = textOf(d.textId);
  return t ? replacementText(d, t.text, state.used.get(d.id) ?? state.settings, state.sourceUnit) : d.original;
}

function editPanel(d: Dimension, t: TextEntity | undefined): string {
  const o = d.override ?? {};
  // ticked when the converted value has the sign: the drawing's own, or one the user added
  const dia = o.diameter ?? (!!t && hasDiameterSign(d, t.text));
  const size = t?.sizeScale ?? 1;
  const turnDeg = Math.round(((t?.turn ?? 0) * 180) / Math.PI);
  const eff = settingsFor(d, state.used.get(d.id) ?? state.settings);
  const frac = eff.target === 'in-frac' || eff.target === 'ft-in';
  const dec = eff.decimals;
  const den = eff.denominator;
  return (
    `<div class="dim-edit">` +
    `<label class="e-field e-wide"><span>${d.translated ? 'Translation' : 'Converted text'}</span><input class="e-text" type="text" spellcheck="false" autocomplete="off"/></label>` +
    `<div class="e-size e-wide"><span>Text size</span>` +
    `<button type="button" class="btn small e-size-dn" title="Smaller" aria-label="Smaller text"${size <= SIZE_MIN ? ' disabled' : ''}>−</button>` +
    `<span class="e-size-val">${Math.round(size * 100)}%</span>` +
    `<button type="button" class="btn small e-size-up" title="Larger" aria-label="Larger text"${size >= SIZE_MAX ? ' disabled' : ''}>+</button></div>` +
    `<div class="e-size e-wide"><span>Rotation</span>` +
    `<button type="button" class="btn small e-turn" data-step="90" title="Turn 90° anticlockwise" aria-label="Turn 90 degrees anticlockwise">⟲</button>` +
    `<button type="button" class="btn small e-turn" data-step="-15" title="Turn 15° clockwise" aria-label="Turn 15 degrees clockwise">−</button>` +
    `<input class="e-turn-val" type="number" step="1" min="-180" max="180" value="${turnDeg}" aria-label="Rotation in degrees"/>` +
    `<button type="button" class="btn small e-turn" data-step="15" title="Turn 15° anticlockwise" aria-label="Turn 15 degrees anticlockwise">+</button>` +
    `<button type="button" class="btn small e-turn" data-step="-90" title="Turn 90° clockwise" aria-label="Turn 90 degrees clockwise">⟳</button></div>` +
    (d.translated
      ? ''
      : frac
      ? `<label class="e-field e-wide e-inline"><span>Round to</span><select class="e-den">${[2, 4, 8, 16, 32, 64].map((n) => `<option value="${n}"${n === den ? ' selected' : ''}>1/${n}"</option>`).join('')}</select></label>`
      : `<div class="e-size e-wide"><span>Decimal places</span>` +
        `<button type="button" class="btn small e-dec-dn" title="Fewer" aria-label="Fewer decimal places"${dec <= 0 ? ' disabled' : ''}>−</button>` +
        `<span class="e-size-val">${dec}</span>` +
        `<button type="button" class="btn small e-dec-up" title="More" aria-label="More decimal places"${dec >= 6 ? ' disabled' : ''}>+</button></div>`) +
    (d.translated
      ? ''
      : `<label class="e-check e-wide"><input class="e-dia" type="checkbox"${dia ? ' checked' : ''}/> Diameter sign (Ø)</label>`) +
    `<div class="e-actions">${t?.offset ? '<button class="btn small e-moveback">Move text back</button>' : ''}` +
    `${d.override || size !== 1 || t?.turn ? '<button class="btn small e-reset">Reset</button>' : ''}</div>` +
    `</div>`
  );
}


/** Turns the converted text of dimension `id` to `deg` degrees (or by `step`), and converts it if it is not yet. */
function setTurn(id: string, deg: number | null, step = 0): void {
  const d = state.dims.find((x) => x.id === id);
  const t = d && textOf(d.textId);
  if (!d || !t) return;
  let v = deg ?? Math.round(((t.turn ?? 0) * 180) / Math.PI) + step;
  if (!Number.isFinite(v)) return;
  v = ((((v + 180) % 360) + 360) % 360) - 180; // -180 .. 179
  snapshot();
  t.turn = v ? (v * Math.PI) / 180 : undefined;
  if (!d.converted) convert(d, state.settings);
  renderDynamic();
}

/** Text size steps in the dimension list (10% each, 50% to 300%). */
const SIZE_MIN = 0.5;
const SIZE_MAX = 3;

/**
 * Makes the converted text holding dimension `id` larger or smaller by one
 * step, and converts the dimension if it is not yet.
 */
function stepSize(id: string, dir: 1 | -1): void {
  const d = state.dims.find((x) => x.id === id);
  const t = d && textOf(d.textId);
  if (!d || !t) return;
  const next = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(((t.sizeScale ?? 1) + dir * 0.1) * 10) / 10));
  snapshot();
  t.sizeScale = next === 1 ? undefined : next;
  if (!d.converted) convert(d, state.settings);
  renderDynamic();
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
    if (state.dims.find((x) => x.id === id)?.translated) {
      // a translation is the text as typed (an empty field keeps it)
      if (v.trim()) editDimension(id, (o) => (o.text = v));
      else renderList();
      return;
    }
    editDimension(id, (o) => {
      delete o.text;
      // typed text is kept as it is, unless it is what the settings give anyway
      const d = state.dims.find((x) => x.id === id)!;
      const computed = replacementText({ ...d, override: o }, textOf(d.textId)!.text, state.used.get(d.id) ?? state.settings, state.sourceUnit);
      if (v.trim() && v !== computed) o.text = v;
    });
  } else if (el.classList.contains('e-turn-val')) {
    setTurn(id, Number(el.value));
  } else if (el.classList.contains('e-den')) {
    const n = Number(el.value);
    const d = state.dims.find((x) => x.id === id)!;
    editDimension(id, (o) => {
      if (n === (state.used.get(d.id) ?? state.settings).denominator) delete o.denominator;
      else o.denominator = n;
    });
  } else if (el.classList.contains('e-dia')) {
    const on = (el as HTMLInputElement).checked;
    const d = state.dims.find((x) => x.id === id)!;
    const t = textOf(d.textId);
    const own = !!t && hasDiameterSign(d, t.text);
    editDimension(id, (o) => {
      // back to how the drawing writes it: no override
      if (on === own) delete o.diameter;
      else o.diameter = on;
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
  pageBg.draw(view, px, py);
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
/** An outline being traced with the right button in "Add box" mode (SVG user coordinates). */
let trace: { pts: { x: number; y: number }[]; id: number } | null = null;
const lassoEl = document.getElementById('lasso') as unknown as SVGPolygonElement;

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
  // In "Add box" mode the right button traces an outline of any shape around a value
  if (ev.button === 2 && mode === 'add' && state.drawing) {
    ev.preventDefault();
    trace = { pts: [clientToSvg(ev.clientX, ev.clientY)], id: ev.pointerId };
    svg.setPointerCapture(ev.pointerId);
    return;
  }
  // right or middle button pans; left button draws a box in "Add box" mode
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
  if (trace && trace.id === ev.pointerId) {
    const p = clientToSvg(ev.clientX, ev.clientY);
    const last = trace.pts[trace.pts.length - 1];
    const s = Math.max(view.w / (svg.clientWidth || 1), view.h / (svg.clientHeight || 1));
    // a point every 3 screen pixels is smooth enough
    if (Math.hypot(p.x - last.x, p.y - last.y) >= 3 * s && trace.pts.length < 2000) {
      trace.pts.push(p);
      lassoEl.removeAttribute('hidden');
      lassoEl.setAttribute('points', trace.pts.map((q) => `${q.x},${q.y}`).join(' '));
    }
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
  if (trace && trace.id === ev.pointerId) {
    const t = trace;
    trace = null;
    lassoEl.setAttribute('hidden', '');
    // SVG y is the negated drawing y
    const outline = t.pts.map((q) => ({ x: q.x, y: -q.y }));
    const s = Math.max(view.w / (svg.clientWidth || 1), view.h / (svg.clientHeight || 1));
    if (outline.length < 3 || polyArea(outline) < 150 * s * s) {
      toast('Hold the right button and trace all the way around the dimension (the shape was too small).', false, 4500);
      return;
    }
    void placeBox(outline, outlineFrame(outline));
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
  trace = null;
  lassoEl.setAttribute('hidden', '');
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

/** Converts `d`; false when the custom unit does not apply to it (it is in another unit). */
function convert(d: Dimension, s: ConversionSettings): boolean {
  const t = textOf(d.textId);
  if (!t || !canConvert(d, s)) return false;
  convertDimension(d, t.text, s, state.sourceUnit);
  state.used.set(d.id, { ...s, custom: { ...s.custom } });
  return true;
}

/** The custom unit's original suffix, while the custom unit is chosen. */
const customSuffix = () => (state.settings.target === 'custom' ? state.settings.custom.from.trim() || undefined : undefined);

/** Why the custom unit leaves a value alone. */
function customSkipReason(): string {
  const c = state.settings.custom;
  if (state.settings.target !== 'custom') return 'it is in the custom unit; choose "Custom…" as the new unit to convert it';
  return parseFactor(c.factor) === null
    ? 'Enter a conversion factor for the custom unit (a number like 39.37, or a fraction like 1/25.4).'
    : `it is not in the original unit${c.from.trim() ? ` (${c.from.trim()})` : ''}`;
}

/**
 * Values written with the custom unit's original suffix ("12 u") become
 * dimensions. Run when that suffix changes; nothing found before is removed.
 */
function addCustomDimensions(): void {
  const d = state.drawing;
  const suffix = customSuffix();
  if (!d || !suffix) return;
  for (const nd of detectDimensions(d, { customSuffix: suffix })) {
    if (nd.suffix === undefined) continue;
    const old = state.dims.find((x) => x.textId === nd.textId && x.start === nd.start);
    if (!old) state.dims.push(nd);
    else if (!old.converted && old.suffix === undefined) Object.assign(old, { end: nd.end, unit: nd.unit, spaced: nd.spaced, suffix: nd.suffix, original: nd.original });
  }
  state.dims.sort((a, b) => (a.textId === b.textId ? a.start - b.start : 0));
}

function toggleDimension(id: string): void {
  const d = state.dims.find((x) => x.id === id);
  if (!d) return;
  const key = `${settingsKey(state.settings)}|${state.sourceUnit}`;
  if (d.converted && d.converted.key === key) {
    d.converted = undefined;
    state.used.delete(d.id);
  } else if (!convert(d, state.settings)) {
    const why = customSkipReason();
    toast(why.startsWith('Enter') ? why : `"${d.original}" was left as it is: ${why}.`, true, 6000);
    return;
  }
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
  if (target.closest('.e-size-up, .e-size-dn')) {
    stepSize(id, target.closest('.e-size-up') ? 1 : -1);
    return;
  }
  const turnBtn = target.closest<HTMLElement>('.e-turn');
  if (turnBtn) {
    setTurn(id, null, Number(turnBtn.dataset.step));
    return;
  }
  if (target.closest('.e-dec-up, .e-dec-dn')) {
    const d = state.dims.find((x) => x.id === id)!;
    const cur = settingsFor(d, state.used.get(d.id) ?? state.settings).decimals;
    const next = Math.max(0, Math.min(6, cur + (target.closest('.e-dec-up') ? 1 : -1)));
    editDimension(id, (o) => {
      if (next === (state.used.get(d.id) ?? state.settings).decimals) delete o.decimals;
      else o.decimals = next;
    });
    return;
  }
  if (target.closest('.e-reset')) {
    const t = textOf(state.dims.find((x) => x.id === id)?.textId ?? '');
    // editDimension takes the undo snapshot before calling this
    const isTr = !!state.dims.find((x) => x.id === id)?.translated;
    editDimension(id, (o) => {
      // a translation keeps its text: Reset undoes the size, turn and position only
      for (const k of Object.keys(o)) if (!(isTr && (k === 'text' || k === 'lang'))) delete o[k as keyof typeof o];
      if (t) {
        t.sizeScale = undefined;
        t.turn = undefined;
      }
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
  add: 'Drag a box around a dimension that was missed, or hold the right button and trace around it for any shape. Its text is read for you to check. Middle-drag pans, Esc to stop.',
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
  /** Where converted texts had been moved to, and their size. */
  offsets: Map<TextEntity, { offset: Pt | undefined; sizeScale: number | undefined; turn: number | undefined }>;
}
const undoStack: Snapshot[] = [];
function snapshot(): void {
  const d = state.drawing;
  if (!d) return;
  const offsets = new Map<TextEntity, { offset: Pt | undefined; sizeScale: number | undefined; turn: number | undefined }>();
  for (const e of d.entities) if (e.kind === 'text') offsets.set(e, { offset: e.offset, sizeScale: e.sizeScale, turn: e.turn });
  undoStack.push({ entities: [...d.entities], dims: state.dims.map((x) => ({ ...x })), used: new Map(state.used), offsets });
  if (undoStack.length > 50) undoStack.shift();
}
function undo(): void {
  const s = undoStack.pop();
  const d = state.drawing;
  if (!s || !d) return;
  for (const [t, o] of s.offsets) {
    t.offset = o.offset;
    t.sizeScale = o.sizeScale;
    t.turn = o.turn;
  }
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

/**
 * Whites out everything outside a traced outline (image pixels), so only what
 * the user traced around is read. `grow` pixels around the line are kept, for
 * letters the trace just touches.
 */
function maskOutside(img: ImageData, outline: { x: number; y: number }[], grow: number): void {
  const m = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  const c = m.getContext('2d', { willReadFrequently: true })!;
  c.beginPath();
  outline.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  c.closePath();
  c.fillStyle = '#000';
  c.strokeStyle = '#000';
  c.lineWidth = 2 * grow;
  c.lineJoin = 'round';
  c.fill();
  c.stroke();
  const W = img.width;
  const H = img.height;
  const alpha = c.getImageData(0, 0, W, H).data;
  const inside = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) inside[k] = alpha[k * 4 + 3] >= 128 ? 1 : 0;
  const px = img.data;
  const dark = (k: number) => Math.min(px[k * 4], px[k * 4 + 1], px[k * 4 + 2]) < 200;
  // Pieces of ink the outline crosses: a letter it only clips is kept whole;
  // one that lies more than a quarter outside (a neighbour's letter, a line) goes.
  const keep = inside.slice();
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!inside[s0] || seen[s0] || !dark(s0)) continue;
    const comp: number[] = [];
    let out = 0;
    seen[s0] = 1;
    stack.push(s0);
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      if (!inside[k]) out++;
      const x = k % W;
      const y = (k - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (!seen[n] && dark(n)) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    const v = out > 0.25 * comp.length ? 0 : 1;
    for (const k of comp) keep[k] = v;
  }
  for (let k = 0; k < W * H; k++) if (!keep[k]) px[k * 4] = px[k * 4 + 1] = px[k * 4 + 2] = 255;
}

interface BoxRead {
  /** The line best read as a value (for converting). */
  text: string;
  /** Everything read in the box, line by line (for translating). */
  allText: string;
  placement: Placement;
  color: string;
  style?: BoxStyle;
}

/**
 * Text the file itself holds inside a region: real PDF text, the Scan & OCR
 * text layer, DXF/DWG text. In reading order (top line first).
 */
function fileTextIn(d: Drawing, poly: Pt[]): TextEntity[] {
  const inside = d.entities.filter((e): e is TextEntity => {
    if (e.kind !== 'text' || e.manual) return false;
    const c = textCorners(e);
    const mid = { x: (c[0].x + c[2].x) / 2, y: (c[0].y + c[2].y) / 2 };
    return pointInPoly(mid, poly);
  });
  // top to bottom along the box's "up", then along the line
  const ang = Math.atan2(poly[1].y - poly[0].y, poly[1].x - poly[0].x);
  const along = (p: Pt) => p.x * Math.cos(ang) + p.y * Math.sin(ang);
  const up = (p: Pt) => -p.x * Math.sin(ang) + p.y * Math.cos(ang);
  return inside.sort((a, b) => up(b.pos) - up(a.pos) > a.fontSize * 0.5 ? 1 : up(a.pos) - up(b.pos) > a.fontSize * 0.5 ? -1 : along(a.pos) - along(b.pos));
}

/** A box read from the text the file holds there (no OCR). */
function readFileText(d: Drawing, poly: Pt[]): BoxRead | null {
  const found = fileTextIn(d, poly);
  if (!found.length) return null;
  const first = found[0];
  const allText = found.map((t) => t.text).join('\n');
  const suffix = customSuffix();
  // the line that most clearly holds a dimension
  const best = [...found].sort((a, b) => valueRank(b.text, suffix) - valueRank(a.text, suffix))[0] ?? first;
  const dir = { x: Math.cos(best.rotation), y: Math.sin(best.rotation) };
  const shift = best.align === 'center' ? -best.width / 2 : best.align === 'right' ? -best.width : 0;
  return {
    text: best.text,
    allText,
    placement: {
      origin: { x: best.pos.x + dir.x * shift, y: best.pos.y + dir.y * shift },
      across: { x: dir.x * best.width, y: dir.y * best.width },
      up: { x: -dir.y * best.fontSize, y: dir.x * best.fontSize },
    },
    color: best.style.color,
    style: { face: best.face, hscale: best.hscale, slant: best.slant },
  };
}

/** OCR lines of one box, without the repeated readings of the same words, in reading order. */
function distinctLines(lines: FoundLine[]): FoundLine[] {
  const kept: FoundLine[] = [];
  for (const l of [...lines].sort((a, b) => b.confidence - a.confidence)) {
    const overlaps = kept.some((k) => {
      // centres within each other's box
      const inK = Math.abs((l.c.x - k.c.x) * k.u.x + (l.c.y - k.c.y) * k.u.y) < k.len / 2 && Math.abs(-(l.c.x - k.c.x) * k.u.y + (l.c.y - k.c.y) * k.u.x) < k.hgt / 2;
      const kInL = Math.abs((k.c.x - l.c.x) * l.u.x + (k.c.y - l.c.y) * l.u.y) < l.len / 2 && Math.abs(-(k.c.x - l.c.x) * l.u.y + (k.c.y - l.c.y) * l.u.x) < l.hgt / 2;
      return inK || kInL;
    });
    if (!overlaps) kept.push(l);
  }
  // image y is down: top line first; within a line, along its direction
  return kept.sort((a, b) => (Math.abs(a.c.y - b.c.y) > Math.min(a.hgt, b.hgt) * 0.5 ? a.c.y - b.c.y : a.c.x - b.c.x));
}

/**
 * The text in a box: read with OCR on the rendered page (any script the
 * recogniser knows, Chinese and Japanese included), and from the text the
 * file holds there. Null when nothing could be read.
 */
async function readBoxText(d: Drawing, poly: Pt[], outline?: Pt[]): Promise<BoxRead | null> {
  const fromFile = readFileText(d, outline ?? poly);
  if (!d.pdf) {
    // a DXF or DWG: its own text, or (text exploded into lines) what the drawn shapes read as
    if (fromFile && usableText(fromFile.allText)) return fromFile;
    try {
      return (await ocrDrawnRegion(d, outline ?? poly)) ?? fromFile;
    } catch (err) {
      console.warn(err);
      return fromFile;
    }
  }
  let ocr: BoxRead | null = null;
  try {
    ocr = await ocrBoxText(d, poly, outline);
  } catch (err) {
    console.warn(err);
  }
  if (!ocr) return fromFile && usableText(fromFile.allText) ? fromFile : fromFile && { ...fromFile, text: '', allText: '' };
  if (!fromFile) return ocr;
  // Real text is exact; the OCR reading gives the look of the letters. A text
  // layer (OCR) was read at page scale: the box reading is closer.
  const real = fileTextIn(d, outline ?? poly).filter((t) => !t.ocr);
  if (!real.length) return ocr;
  // The file's own text, unless it is unusable: Chinese and Japanese PDFs often
  // store their characters with private or missing codes, which come out blank
  // or garbled. What the letters on the page read as is then the text.
  if (!usableText(fromFile.allText) || (CJK.test(ocr.allText) && !CJK.test(fromFile.allText))) return ocr;
  return { ...ocr, text: fromFile.text, allText: fromFile.allText, placement: fromFile.placement };
}

/** Chinese, Japanese and Korean characters. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/**
 * OCR of a region of a CAD drawing as it is drawn on screen (text exploded
 * into lines and arcs, or in a font the file does not name). The SVG of the
 * region is drawn into a picture and read like a scan.
 */
async function ocrDrawnRegion(d: Drawing, poly: Pt[]): Promise<BoxRead | null> {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 0 && h > 0)) return null;
  // about 48 px for the short side's worth of text, at most 2400 px across
  const scale = Math.min(2400 / Math.max(w, h), Math.max(8, 120 / Math.min(w, h)));
  const pad = 16;
  const W = Math.round(w * scale) + 2 * pad;
  const H = Math.round(h * scale) + 2 * pad;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelector('#overlays')?.remove();
  clone.querySelector('#selection')?.remove();
  clone.querySelector('#lasso')?.remove();
  clone.removeAttribute('hidden');
  const u = 1 / scale; // drawing units per pixel
  clone.setAttribute('viewBox', `${minX - pad * u} ${-maxY - pad * u} ${W * u} ${H * u}`);
  clone.setAttribute('width', String(W));
  clone.setAttribute('height', String(H));
  clone.setAttribute('style', `--hair:${u}px;--hairn:${u};background:#fff`);
  const st = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  st.textContent = 'polygon.mask{fill:#fff;stroke:none}.handle{display:none}text{white-space:pre}';
  clone.insertBefore(st, clone.firstChild);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('The drawing could not be drawn for reading.'));
      img.src = url;
    });
    const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H);
    const lines = await recogniseInWorker({ width: W, height: H, data: data.data.slice() }, scale, pad);
    if (!lines.length) return null;
    const suffix = customSuffix();
    const best = [...lines].sort((a, b) => valueRank(b.text, suffix) - valueRank(a.text, suffix) || b.confidence - a.confidence)[0];
    const map = (x: number, y: number): [number, number] => [minX + (x - pad) * u, maxY - (y - pad) * u];
    const pl = placeLine(best, map);
    const allText = distinctLines(lines).map((l) => normaliseOcrText(l.text) ?? l.text.trim()).filter(Boolean).join('\n');
    return {
      text: normaliseOcrText(best.text) ?? best.text.trim(),
      allText: allText || best.text,
      placement: { origin: { x: pl.origin[0], y: pl.origin[1] }, across: { x: pl.across[0], y: pl.across[1] }, up: { x: pl.up[0], y: pl.up[1] } },
      color: '#' + best.rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join(''),
      style: pageStyle(d),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The text in a box on a PDF page, read with OCR; null when nothing could be read. */
async function ocrBoxText(d: Drawing, poly: Pt[], outline?: Pt[]): Promise<BoxRead | null> {
  if (!d.pdf) return null;
  const toUser = invert(d.pdf.userToDrawing);
  const task = pdfjs.getDocument({ data: d.pdf.bytes.slice(), ...PDF_PARAMS });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(d.pdf.pageIndex + 1);
    // 200 dpi like the page pass; small boxes are rendered finer
    const side = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
    const boxMm = Math.min(side(poly[0], poly[1]), side(poly[0], poly[3]));
    const pxPerMm = Math.min(24, Math.max(200 / 25.4, 40 / Math.max(boxMm, 0.5)));
    const vp = page.getViewport({ scale: (pxPerMm * 25.4) / 72 });
    // corners in page pixels (y down): bottom-left, bottom-right, top-right, top-left
    const q = poly.map((p) => {
      const u = apply(toUser, p);
      const [x, y] = vp.convertToViewportPoint(u.x, u.y) as number[];
      return { x, y };
    });
    // The box is rendered upright, whatever its angle: its own frame becomes the
    // image's (ex along the bottom edge, ey from the top edge down).
    const W = side(q[0], q[1]);
    const H = side(q[3], q[0]);
    const ex = { x: (q[1].x - q[0].x) / W, y: (q[1].y - q[0].y) / W };
    const ey = { x: (q[0].x - q[3].x) / H, y: (q[0].y - q[3].y) / H };
    const pad = Math.round(Math.max(8, Math.min(W, H) * 0.2));
    const w = Math.ceil(W) + 2 * pad;
    const h = Math.ceil(H) + 2 * pad;
    if (w * h > 16e6) return null;
    const tl = q[3];
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    const transform = [ex.x, ey.x, ex.y, ey.y, pad - (ex.x * tl.x + ex.y * tl.y), pad - (ey.x * tl.x + ey.y * tl.y)];
    await page.render({ canvasContext: ctx, viewport: vp, canvas, transform } as never).promise;
    const img = ctx.getImageData(0, 0, w, h);
    if (outline) maskOutside(img, outline.map((p) => {
      // drawing -> page pixels -> image pixels
      const u = apply(toUser, p);
      const [x, y] = vp.convertToViewportPoint(u.x, u.y) as number[];
      return { x: pad + ex.x * (x - tl.x) + ex.y * (y - tl.y), y: pad + ey.x * (x - tl.x) + ey.y * (y - tl.y) };
    }), Math.max(2, Math.min(W, H) * 0.04));
    const lines = await recogniseInWorker({ width: w, height: h, data: img.data.slice() }, pxPerMm, pad);
    if (!lines.length) return null;
    // prefer a line that holds a length (or a value in the custom unit), then the most confident one
    const suffix = customSuffix();
    const holds = (text: string) => {
      const toks = findLengthTokens(text, { isDimension: true, customSuffix: suffix });
      return toks.some((t) => t.suffix !== undefined) ? 2 : toks.length ? 1 : 0;
    };
    const scored = lines
      .map((l) => ({ l, text: normaliseOcrText(l.text) ?? l.text }))
      .sort((a, b) => holds(b.text) - holds(a.text) || b.l.confidence - a.l.confidence);
    const best = { ...scored[0] };
    // image pixels -> page pixels -> drawing
    const map = (x: number, y: number): [number, number] => {
      const px = tl.x + ex.x * (x - pad) + ey.x * (y - pad);
      const py = tl.y + ex.y * (x - pad) + ey.y * (y - pad);
      const [ux, uy] = vp.convertToPdfPoint(px, py) as number[];
      const p = apply(d.pdf!.userToDrawing, { x: ux, y: uy });
      return [p.x, p.y];
    };
    // the font, size and width of the letters in the box, preferring the page's font
    await loadAllFaces();
    let fit = matchFonts(img, [{ l: best.l, text: best.text }], fontRenderer, pageFamily(d))[0];
    // the recogniser has no Ø: put it back where the letters show one
    const fix = fixDiameters(img, { l: best.l, text: best.text }, fit, pageFamily(d) ?? null, fontRenderer);
    if (fix) {
      best.text = fix.text;
      best.l = { ...best.l, u: fix.box.u, len: fix.box.len, hgt: fix.box.hgt };
      fit = fix.fit;
    }
    const pl = fit ? placeFit(fit, map) : placeLine(best.l, map);
    const hex = '#' + best.l.rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    const allText = distinctLines(lines)
      .map((l) => normaliseOcrText(l.text) ?? l.text.trim())
      .filter(Boolean)
      .join('\n');
    return {
      text: best.text,
      allText: allText || best.text,
      placement: { origin: { x: pl.origin[0], y: pl.origin[1] }, across: { x: pl.across[0], y: pl.across[1] }, up: { x: pl.up[0], y: pl.up[1] } },
      color: hex,
      style: fit ? { face: fit.face, hscale: fit.hscale, slant: fit.slant } : pageStyle(d),
    };
  } finally {
    await task.destroy();
  }
}

type BoxAnswer = { action: 'convert'; text: string; partial: boolean } | { action: 'translate'; source: string; translation: string; lang: string };

const TR_TO_KEY = 'duc.translate.to.v1';
{
  $('tr-to').innerHTML = LANGUAGES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  const nav = (navigator.language || 'en').toLowerCase();
  const pref = localStorage.getItem(TR_TO_KEY) ?? (LANGUAGES.find(([c]) => c.toLowerCase() === nav) ?? LANGUAGES.find(([c]) => nav.startsWith(c.split('-')[0])) ?? ['en'])[0];
  $<HTMLSelectElement>('tr-to').value = pref;
}

/** The lines of `text` that hold a value to convert, on one line (all of it when none do). */
function valueLines(text: string): string {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  // the lines that most clearly hold a dimension ("电热管直径Ø12" before "数量：12个")
  const rank = lines.map((l) => valueRank(l, customSuffix()));
  const top = Math.max(0, ...rank);
  return (top ? lines.filter((_, i) => rank[i] === top) : lines).join(' ');
}

/**
 * Shows what was read in a box. "Convert values" converts the values in it
 * (and is only offered when there are some); "Translate" shows a translation,
 * which "Write translation" writes over the box. Resolves null on cancel.
 */
function askBoxText(read: BoxRead | null): Promise<BoxAnswer | null> {
  const dlg = $<HTMLDialogElement>('box-dialog');
  const input = $<HTMLTextAreaElement>('box-text');
  const out = $<HTMLTextAreaElement>('tr-out');
  const status = $('tr-status');
  const note = $('box-note');
  const ok = $<HTMLButtonElement>('box-ok');
  const tr = $<HTMLButtonElement>('box-translate');
  const useTr = $<HTMLButtonElement>('box-use-tr');
  const back = $<HTMLButtonElement>('box-back');
  $('box-read').textContent = read === null ? 'Nothing could be read here. Type what the box says.' : 'Read from the drawing. Correct it if needed.';
  input.value = read?.allText ?? read?.text ?? '';
  const fit = () => {
    input.rows = Math.min(5, Math.max(1, input.value.split('\n').length));
  };
  fit();
  out.value = '';
  status.textContent = '';

  /** Convert or translate, depending on what the text holds. */
  const refresh = () => {
    fit();
    const text = input.value.trim();
    const values = text ? manualTokens(text.replace(/\s*\n\s*/g, ' '), customSuffix()) : [];
    ok.disabled = !values.length;
    // nothing to convert: only the translation is offered
    ok.hidden = !values.length;
    tr.disabled = !text;
    note.classList.toggle('warn', !!text && !values.length);
    note.textContent = !text
      ? ''
      : values.length
        ? `Converts ${values.map((v) => `"${text.replace(/\s*\n\s*/g, ' ').slice(v.start, v.end)}"`).join(', ')}.`
        : 'There are no values to convert in this text. You can translate it.';
    // text with nothing to convert: translating is what is left to do
    ok.classList.toggle('primary', values.length > 0);
    tr.classList.toggle('primary', !values.length && !!text);
  };
  const showTranslate = (on: boolean) => {
    $('box-convert').hidden = on;
    $('box-tr').hidden = !on;
    $('box-title').textContent = on ? 'Translate the text' : 'Text in the box';
    ok.hidden = on;
    tr.hidden = on;
    back.hidden = !on;
    useTr.hidden = !on;
    useTr.disabled = !out.value.trim();
  };
  showTranslate(false);
  refresh();
  input.oninput = refresh;
  // Ø is not on most keyboards
  $('box-dia').onclick = () => {
    const a = input.selectionStart ?? input.value.length;
    const b = input.selectionEnd ?? a;
    input.value = input.value.slice(0, a) + '\u00d8' + input.value.slice(b);
    input.focus();
    input.setSelectionRange(a + 1, a + 1);
    refresh();
  };
  let detected = '';
  let runId = 0;
  const run = async () => {
    const text = input.value.trim();
    $('tr-source').textContent = text;
    if (!text) return;
    const id = ++runId;
    const to = $<HTMLSelectElement>('tr-to').value;
    out.value = '';
    useTr.disabled = true;
    status.textContent = 'Translating…';
    try {
      const res = await translate(text, '', to, (m) => id === runId && (status.textContent = m));
      if (id !== runId) return;
      out.value = res.text;
      detected = res.from;
      status.textContent = `${res.from ? `From ${languageName(res.from)}, by` : 'By'} ${res.engine}. You can edit it.`;
    } catch (err) {
      if (id !== runId) return;
      status.textContent = (err as Error).message;
    }
    useTr.disabled = !out.value.trim();
  };
  tr.onclick = () => {
    showTranslate(true);
    void run();
  };
  back.onclick = () => {
    runId++;
    showTranslate(false);
    refresh();
  };
  $<HTMLSelectElement>('tr-to').onchange = () => {
    localStorage.setItem(TR_TO_KEY, $<HTMLSelectElement>('tr-to').value);
    void run();
  };
  out.oninput = () => (useTr.disabled = !out.value.trim());
  // Enter converts (Shift+Enter starts a new line)
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      if (!ok.disabled) dlg.close('ok');
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
  input.focus();
  input.select();
  return new Promise((resolve) => {
    dlg.onclose = () => {
      runId++;
      const text = input.value.trim();
      if (dlg.returnValue === 'translation' && out.value.trim()) {
        resolve({ action: 'translate', source: text, translation: out.value.trim(), lang: $<HTMLSelectElement>('tr-to').value || detected });
      } else if (dlg.returnValue === 'ok' && text) {
        const v = valueLines(text);
        // other lines in the box (a note around the value) stay as they are
        resolve({ action: 'convert', text: v, partial: v !== text.replace(/\s*\n\s*/g, ' ').trim() });
      }
      else resolve(null);
    };
  });
}

async function addBox(box: Box): Promise<void> {
  if (box.maxX - box.minX < 0.3 || box.maxY - box.minY < 0.3) {
    toast('Drag a box around the dimension (the box was too small).', false, 3500);
    return;
  }
  await placeBox(boxPoly(box));
}

/**
 * Reads the text in a box, asks the user to confirm it and adds it. `poly` is
 * what is whited out and replaced: a rectangle, or an outline the user traced.
 * `frame` is the rectangle the text is read in (the traced outline's smallest
 * rectangle, at its angle); only what lies inside `poly` is read.
 */
async function placeBox(poly: Pt[], frame: Pt[] = poly): Promise<void> {
  const d = state.drawing;
  if (!d) return;
  let read: Awaited<ReturnType<typeof readBoxText>> = null;
  busy('Reading the text in the box…');
  try {
    read = await readBoxText(d, frame, frame === poly ? undefined : poly);
  } catch (err) {
    console.warn(err);
  } finally {
    busy(null);
  }
  const answer = await askBoxText(read);
  if (answer === null) return;
  if (answer.action === 'translate') {
    placeTranslation(d, poly, frame, read, answer);
    return;
  }
  // AutoCAD's code for the diameter sign, as some users type it
  const text = answer.text.replace(/%%c/gi, '\u00d8');
  const t = read ? textFromPlacement(text, read.placement, read.color, read.text) : textFromBox(text, frame);
  // written like the letters in the box (or, when none were read, like the page's other text)
  Object.assign(t, read?.style ?? pageStyle(d) ?? {});
  if (t.face) t.width = advance(getFace(t.face), text) * t.fontSize * (t.hscale ?? 1);
  // only the line with the value is covered when the box holds more (the rest of a note stays)
  const edit = addBoxedText(d, state.dims, answer.partial && read ? lineRect(read.placement) : poly, t, customSuffix());
  const added = edit.dims.filter((x) => x.textId === t.id);
  if (!added.length) {
    toast(`"${text}" holds no number, so there is nothing to convert. Type the value as the drawing shows it, or translate the text instead.`, true, 7000);
    return;
  }
  snapshot();
  d.entities = edit.entities;
  state.dims = edit.dims;
  for (const id of edit.replaced) state.used.delete(id);
  addCustomDimensions(); // "12 u" boxed: the custom suffix belongs to the value
  d.stats.texts = d.entities.filter((e) => e.kind === 'text').length;
  renderStatic();
  renderDynamic();
  // a box goes before the rules: say how a value in an unknown unit was taken
  const odd = added.filter((x) => x.suffix !== undefined && state.settings.target !== 'custom');
  const oddNote = odd.length
    ? ` "${odd[0].original}" has a unit the converter does not know, so it is read as ${state.sourceUnit} (the Original unit).`
    : '';
  const replaced = edit.replaced.length ? ` It replaces ${edit.replaced.length} box${edit.replaced.length === 1 ? '' : 'es'} that ${edit.replaced.length === 1 ? 'was' : 'were'} there.` : '';
  toast(`Added "${added.map((x) => x.original).join('", "')}".${replaced}${oddNote}`, false, oddNote ? 9000 : 6000, { label: 'Undo', run: undo });
}

/**
 * Writes a translation over a box: the box is whited out and the translated
 * text written in its place, made smaller if it would not fit. It is listed
 * with the dimensions, so it can be undone, moved, resized and turned.
 */
function placeTranslation(d: Drawing, poly: Pt[], frame: Pt[], read: BoxRead | null, a: Extract<BoxAnswer, { action: 'translate' }>): void {
  const srcLines = a.source.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const trLines = a.translation.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!trLines.length) return;
  // reading direction: the text read in the box, else the box's longer side
  const base = textFromBox(a.source.replace(/\s*\n\s*/g, ' '), frame, read?.color ?? '#000000');
  const angle = read ? Math.atan2(read.placement.across.y, read.placement.across.x) : base.rotation;
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const up = { x: -dir.y, y: dir.x };
  const o = frame[0];
  const along = frame.map((p) => (p.x - o.x) * dir.x + (p.y - o.y) * dir.y);
  const across = frame.map((p) => (p.x - o.x) * up.x + (p.y - o.y) * up.y);
  const [a0, a1, b0, b1] = [Math.min(...along), Math.max(...along), Math.min(...across), Math.max(...across)];
  const at = (u: number, v: number): Pt => ({ x: o.x + dir.x * u + up.x * v, y: o.y + dir.y * u + up.y * v });
  // one band of the box per line of the translation, top to bottom
  const n = trLines.length;
  const band = (b1 - b0) / n;
  const readSize = read ? Math.hypot(read.placement.up.x, read.placement.up.y) : Infinity;
  const size = Math.min(readSize, band * 0.8, base.fontSize);
  const margin = Math.min(0.3 * size, (a1 - a0) * 0.05);
  const room = a1 - a0 - 2 * margin;
  snapshot();
  const added: Dimension[] = [];
  trLines.forEach((line, i) => {
    const hi = b1 - i * band;
    const lo = hi - band;
    const mid = (hi + lo) / 2;
    const original = n === srcLines.length ? srcLines[i] : i === 0 ? srcLines.join(' ') : '';
    const t: TextEntity = {
      ...base,
      id: `${base.id}-${i}`,
      text: original || line,
      pos: at(a0 + margin, mid - 0.36 * size),
      fontSize: size,
      rotation: angle,
      width: room,
    };
    Object.assign(t, read?.style ?? pageStyle(d) ?? {});
    t.fontSize = size;
    // a single line covers what the user drew; several share the box in bands
    const cover = n === 1 ? poly : [at(a0, lo), at(a1, lo), at(a1, hi), at(a0, hi)];
    const edit = addBoxedText(d, state.dims, cover, t, customSuffix());
    counterTr += 1;
    const dim: Dimension = {
      id: `tr${counterTr}`, textId: t.id, start: 0, end: t.text.length, value: NaN, unit: null, spaced: false, kind: 'linear',
      original: t.text, manual: true, translated: true, override: { text: line, lang: a.lang },
    };
    // a line longer than the box is written smaller
    const placed = edit.entities.find((e): e is TextEntity => e.kind === 'text' && e.id === t.id);
    const need = advanceOf(t, line);
    if (placed && need > room * 1.02) placed.sizeScale = Math.max(0.3, Math.floor((room / need) * 20) / 20);
    d.entities = edit.entities;
    state.dims = [...edit.dims.filter((x) => x.textId !== t.id), dim];
    for (const id of edit.replaced) state.used.delete(id);
    added.push(dim);
  });
  for (const dim of added) convert(dim, state.settings);
  d.stats.texts = d.entities.filter((e) => e.kind === 'text').length;
  renderStatic();
  renderDynamic();
  toast(`Wrote the ${languageName(a.lang)} translation over the box.`, false, 6000, { label: 'Undo', run: undo });
}
let counterTr = 0;

/** The area of one line of text placed by `p`, with a little room around its letters. */
function lineRect(p: Placement): Pt[] {
  const at = (a: number, u: number): Pt => ({ x: p.origin.x + p.across.x * a + p.up.x * u, y: p.origin.y + p.across.y * a + p.up.y * u });
  const len = Math.hypot(p.across.x, p.across.y) || 1;
  const em = Math.hypot(p.up.x, p.up.y);
  const m = (0.15 * em) / len;
  return [at(-m, -0.3), at(1 + m, -0.3), at(1 + m, 1.05), at(-m, 1.05)];
}

/** Width of `s` written like text `t`: its face, or an even width per character. */
function advanceOf(t: TextEntity, s: string): number {
  if (t.face) return advance(getFace(t.face), s) * t.fontSize * (t.hscale ?? 1);
  return s.length * t.fontSize * 0.55;
}

window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).closest?.('input, select, textarea, dialog')) return;
  if (ev.key === 'Escape') setMode('convert');
  else if (ev.key === 'PageDown' || ev.key === 'PageUp') {
    ev.preventDefault();
    turnPage(ev.key === 'PageDown' ? 1 : -1);
  }
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    undo();
  }
});

$('convert-all').addEventListener('click', () => {
  let skipped = 0;
  for (const d of state.dims) if (!convert(d, state.settings)) skipped++;
  renderDynamic();
  if (skipped) {
    const why = customSkipReason();
    toast(why.startsWith('Enter') ? why : `${skipped} value${skipped === 1 ? ' was' : 's were'} left as ${skipped === 1 ? 'it is' : 'they are'}: ${why}.`, true, 6000);
  }
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
  // custom: "1 [from] = [factor] [to]" replaces the original unit
  const custom = s.target === 'custom';
  $('custom-unit').hidden = !custom;
  $('source-field').hidden = custom;
  $('to-sep').hidden = custom;
  $('source-hint').hidden = custom;
  $<HTMLInputElement>('custom-from').value = s.custom.from;
  $<HTMLInputElement>('custom-factor').value = s.custom.factor;
  $<HTMLInputElement>('custom-to').value = s.custom.to;
  const factor = parseFactor(s.custom.factor);
  $('custom-factor').setAttribute('aria-invalid', String(custom && factor === null));
  if (custom) {
    const from = s.custom.from.trim();
    const ex = formatCustom(10 * (factor ?? NaN), s);
    $('example').textContent =
      factor === null
        ? 'Enter a factor: a number like 39.37, or a fraction like 1/25.4.'
        : `Example: 10${from ? ' ' + from : ''} → ${ex.number}${ex.label ? (ex.symbol ? '' : ' ') + ex.label : ''}. Values without a unit count as the original unit.`;
  } else {
    const ex = formatLength(152.4, s);
    const sep = ex.label && !ex.symbol ? ' ' : '';
    $('example').textContent = `Example: 152.4 mm → ${ex.number}${ex.label ? sep + ex.label : ''}`;
  }
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
  s.custom = { from: $<HTMLInputElement>('custom-from').value, factor: $<HTMLInputElement>('custom-factor').value, to: $<HTMLInputElement>('custom-to').value };
  syncSettingsUi();
}
/** Values written with the original suffix become dimensions (once the suffix is entered, not while it is typed). */
function onCustomCommitted(): void {
  onSettings();
  if (state.drawing && customSuffix()) {
    const before = state.dims.length;
    addCustomDimensions();
    if (state.dims.length !== before || state.dims.some((x) => x.suffix !== undefined)) renderDynamic();
  }
}
for (const id of ['decimals', 'denominator', 'show-unit', 'inch-label', 'trim-zeros']) $(id).addEventListener('change', onSettings);
$('target').addEventListener('change', onCustomCommitted);
for (const id of ['custom-from', 'custom-factor', 'custom-to']) {
  // the example follows the typing; the drawing is searched when the field is left or Enter pressed
  $(id).addEventListener('input', onSettings);
  $(id).addEventListener('change', onCustomCommitted);
}

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

/** Goes to the page `step` pages on (−1 back, 1 on). */
function turnPage(step: number): void {
  const p = state.drawing?.pdf;
  if (!state.file || !p) return;
  const next = p.pageIndex + step;
  if (next < 0 || next >= p.pageCount) return;
  void openFile(state.file, next);
}
$('page-prev').addEventListener('click', () => turnPage(-1));
$('page-next').addEventListener('click', () => turnPage(1));

// ------------------------------------------------------------------ export

$('export-dxf').addEventListener('click', () => {
  const d = state.drawing;
  if (!d) return;
  const moved = d.entities.some((e) => e.kind === 'text' && (!!e.offset || (e.sizeScale ?? 1) !== 1 || !!e.turn));
  if (d.source !== 'pdf' && d.dxf?.hasHandles && moved) toast('Converted text was moved, resized or turned, so a simplified DXF R12 was written (the original file can only have its text changed in place).', false, 7000);
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

/** The converted drawing as a PDF. */
async function convertedPdf(d: Drawing): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  if (d.source === 'pdf' && d.pdf) {
    // every page worked on goes into the one download
    const pages = [...pageCache.values()].filter((p) => p.drawing.pdf!.pageIndex !== d.pdf!.pageIndex).map((p) => ({ d: p.drawing, dims: p.dims }));
    pages.push({ d, dims: state.dims });
    return exportPdfPages(docBytes ?? d.pdf.bytes, pages, fontBytes, webScriptFont);
  }
  return exportPdfPlot(d, state.dims, fontBytes);
}

$('export-image').addEventListener('click', async () => {
  const d = state.drawing;
  if (!d?.picture) return;
  busy('Writing the picture…');
  try {
    const res = await convertedPdf(d);
    const task = pdfjs.getDocument({ data: res.bytes.slice(), ...PDF_PARAMS });
    try {
      const page = await (await task.promise).getPage(1);
      const blob = await pdfToImage(page as never, d.picture.width, d.picture.mime);
      const jpeg = d.picture.mime === 'image/jpeg';
      download(new Uint8Array(await blob.arrayBuffer()), `${baseName()}-converted.${jpeg ? 'jpg' : 'png'}`, d.picture.mime);
    } finally {
      await task.destroy();
    }
    if (res.warnings.length) toast(res.warnings.join(' '), false, 7000);
  } catch (err) {
    console.error(err);
    toast(`Picture export failed: ${(err as Error).message}`, true);
  } finally {
    busy(null);
  }
});

$('export-pdf').addEventListener('click', async () => {
  const d = state.drawing;
  if (!d) return;
  busy('Writing PDF…');
  try {
    const res = await convertedPdf(d);
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
