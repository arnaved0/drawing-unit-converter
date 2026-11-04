import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import * as ort from 'onnxruntime-web';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildCharset, runOcr, type OcrModels } from '../src/ocr/engine';
import { preprocessPage } from '../src/ocr/preprocess';
import { lineColor } from '../src/ocr/color';
import { importPdf, type PdfJs } from '../src/importers/pdf';
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

/** Runs the OCR preprocessing on page 1 of a sample, the way the app does (minus the worker). */
export async function ocrSample(name: string) {
  const m = await loadModels();
  const bytes = readSample(name);
  const task = pdfjs.getDocument({ data: bytes.slice(), ...docParams });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const res = await preprocessPage(bytes, page as never, 0, {
    createCanvas: (w, h) => createCanvas(w, h) as never,
    recognise: async (img, pxPerMm) => (await runOcr(m, img, { pxPerMm })).map((l) => ({ ...l, rgb: lineColor(img, l) })),
  });
  await task.destroy();
  return res;
}

export function importBytes(bytes: Uint8Array, name: string) {
  return importPdf(pdfjs as unknown as PdfJs, bytes, name, { docParams });
}
