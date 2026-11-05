import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { FACES } from '../src/fonts/faces';
import { canvasRenderer } from '../src/fonts/match';
import * as ort from 'onnxruntime-web';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildCharset, runOcr, type OcrModels } from '../src/ocr/engine';
import { preprocessPage } from '../src/ocr/preprocess';
import { lineColor } from '../src/ocr/color';
import { importPdf, type PdfJs, type TextStyleHint } from '../src/importers/pdf';
import { readSample } from './helpers';

const modelDir = fileURLToPath(new URL('../public/models/ppocrv5/', import.meta.url));
const pdfjsDir = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));
const docParams = { cMapUrl: `${pdfjsDir}cmaps/`, cMapPacked: true, standardFontDataUrl: `${pdfjsDir}standard_fonts/` };

let models: Promise<OcrModels> | null = null;
export function loadModels(): Promise<OcrModels> {
  if (!models) {
    models = (async () => {
      ort.env.wasm.numThreads = 1;
      const det = await ort.InferenceSession.create(readFileSync(modelDir + 'det.ort'));
      const rec = await ort.InferenceSession.create(readFileSync(modelDir + 'rec.onnx'));
      const dict = readFileSync(modelDir + 'dict.txt', 'utf8');
      return { ort, det, rec, chars: buildCharset(dict, 18385) };
    })();
  }
  return models;
}

const fontDir = fileURLToPath(new URL('../public/fonts/', import.meta.url));
let fontsRegistered = false;
/** The bundled faces, registered with @napi-rs/canvas under their CSS names. */
export function nodeRenderer() {
  if (!fontsRegistered) {
    for (const f of FACES) GlobalFonts.registerFromPath(`${fontDir}${f.id}.ttf`, f.css);
    fontsRegistered = true;
  }
  return canvasRenderer((w, h) => createCanvas(w, h) as never);
}

/** Runs the OCR preprocessing on a page of a sample, the way the app does (minus the worker). */
export async function ocrSample(name: string, pageIndex = 0) {
  const m = await loadModels();
  const bytes = readSample(name);
  // pdf.js's own copies of the standard fonts: system fonts would differ between machines
  const task = pdfjs.getDocument({ data: bytes.slice(), ...docParams, useSystemFonts: false });
  const doc = await task.promise;
  const page = await doc.getPage(pageIndex + 1);
  const res = await preprocessPage(bytes, page as never, pageIndex, {
    createCanvas: (w, h) => createCanvas(w, h) as never,
    recognise: async (img, pxPerMm) => (await runOcr(m, img, { pxPerMm })).map((l) => ({ ...l, rgb: lineColor(img, l) })),
    render: nodeRenderer(),
  });
  await task.destroy();
  return res;
}

export function importBytes(bytes: Uint8Array, name: string, textStyles?: TextStyleHint[], pageIndex = 0) {
  return importPdf(pdfjs as unknown as PdfJs, bytes, name, { docParams, textStyles, pageIndex });
}

/** Scan & OCR, then import, with the matched fonts. */
export async function ocrImport(name: string, pageIndex = 0) {
  const res = await ocrSample(name, pageIndex);
  return { res, d: await importBytes(res.bytes, name, res.styles, pageIndex) };
}
