/// <reference lib="webworker" />
// Runs OCR and line tracing for scanned pages off the main thread.

import * as ort from 'onnxruntime-web/wasm';
import { setIdScope, type TextEntity } from '../model';
import type { RGBAImage } from './image';
import { buildCharset, readRegion, type OcrModels } from './ocr';
import { ocrLineToText, processScan } from './pipeline';

export type ScanRequest =
  | { type: 'process'; base: string; width: number; height: number; data: Uint8ClampedArray; pxPerMm: number; pageHeightMm: number }
  /** Read the text inside a rectangle of the last processed page (image pixels). */
  | { type: 'region'; x: number; y: number; w: number; h: number };

export type ScanResponse =
  | { type: 'progress'; fraction: number; label: string }
  | { type: 'done'; result: Awaited<ReturnType<typeof processScan>> }
  | { type: 'region-done'; texts: TextEntity[] }
  | { type: 'error'; message: string };

setIdScope('s');
const post = (m: ScanResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

let models: Promise<OcrModels> | null = null;
let page: { img: RGBAImage; pxPerMm: number; pageHeightMm: number } | null = null;

async function download(url: string, label: string, from: number, to: number): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Could not download ${url} (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) post({ type: 'progress', fraction: from + ((to - from) * got) / total, label: `${label} (${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB, downloaded once)` });
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}

function loadModels(base: string): Promise<OcrModels> {
  if (!models) {
    models = (async () => {
      // the WebAssembly file is bundled by Vite next to this worker
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      const det = await download(`${base}models/ppocrv5/det.ort`, 'Downloading text detector', 0, 0.02);
      const rec = await download(`${base}models/ppocrv5/rec.onnx`, 'Downloading text recogniser', 0.02, 0.08);
      const dict = await (await fetch(`${base}models/ppocrv5/dict.txt`)).text();
      post({ type: 'progress', fraction: 0.08, label: 'Starting text recognition' });
      const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      const detS = await ort.InferenceSession.create(new Uint8Array(det), opts);
      const recS = await ort.InferenceSession.create(new Uint8Array(rec), opts);
      const classes = Number((recS.outputMetadata as unknown as { shape?: unknown[] }[])?.[0]?.shape?.[2]) || dict.split('\n').length + 1;
      return { ort: ort as never, det: detS, rec: recS, chars: buildCharset(dict, classes) };
    })();
    models.catch(() => (models = null));
  }
  return models;
}

let lastBase = '';

self.onmessage = async (ev: MessageEvent<ScanRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'process') {
      lastBase = msg.base;
      const m = await loadModels(msg.base);
      const img = { width: msg.width, height: msg.height, data: msg.data };
      page = { img, pxPerMm: msg.pxPerMm, pageHeightMm: msg.pageHeightMm };
      const result = await processScan(m, img, {
        pxPerMm: msg.pxPerMm,
        pageHeightMm: msg.pageHeightMm,
        onProgress: (f, label) => post({ type: 'progress', fraction: 0.1 + f * 0.9, label }),
      });
      post({ type: 'done', result });
    } else if (msg.type === 'region') {
      if (!page) throw new Error('No scanned page is loaded.');
      const m = await loadModels(lastBase);
      const lines = await readRegion(m, page.img, msg.x, msg.y, msg.w, msg.h);
      post({ type: 'region-done', texts: lines.map((l) => ocrLineToText(l, page!.img, page!.pxPerMm, page!.pageHeightMm)) });
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
