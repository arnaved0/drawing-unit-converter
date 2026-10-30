import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import * as ort from 'onnxruntime-web';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildCharset, type OcrModels } from '../src/scan/ocr';
import type { RGBAImage } from '../src/scan/image';
import { readSample } from './helpers';

const modelDir = fileURLToPath(new URL('../public/models/ppocrv5/', import.meta.url));
const pdfjsDir = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));

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

/** Renders page 1 of a sample PDF to RGBA at the given resolution. */
export async function renderSample(name: string, dpi: number): Promise<RGBAImage> {
  const task = pdfjs.getDocument({ data: readSample(name), cMapUrl: `${pdfjsDir}cmaps/`, cMapPacked: true, standardFontDataUrl: `${pdfjsDir}standard_fonts/` });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: dpi / 72 });
  const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx as never, viewport: vp, canvas: canvas as never } as never).promise;
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  await task.destroy();
  return { width: id.width, height: id.height, data: id.data };
}
