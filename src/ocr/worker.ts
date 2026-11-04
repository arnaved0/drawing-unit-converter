/// <reference lib="webworker" />
// Runs text recognition off the main thread.

import * as ort from 'onnxruntime-web/wasm';
import { buildCharset, runOcr, type OcrLine, type OcrModels } from './engine';
import type { RGBAImage } from './image';
import { lineColor } from './color';

export interface OcrRequest {
  base: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;
  pxPerMm: number;
}

export interface FoundLine extends OcrLine {
  /** Ink colour, 0..1. */
  rgb: [number, number, number];
}

export type OcrResponse =
  | { type: 'progress'; fraction: number; label: string }
  | { type: 'done'; lines: FoundLine[] }
  | { type: 'error'; message: string };

const post = (m: OcrResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
let models: Promise<OcrModels> | null = null;

async function download(url: string, label: string, from: number, to: number): Promise<Uint8Array> {
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
  return out;
}

function loadModels(base: string): Promise<OcrModels> {
  if (!models) {
    models = (async () => {
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      const det = await download(`${base}models/ppocrv5/det.ort`, 'Downloading text detector', 0, 0.02);
      const rec = await download(`${base}models/ppocrv5/rec.onnx`, 'Downloading text recogniser', 0.02, 0.08);
      const dict = await (await fetch(`${base}models/ppocrv5/dict.txt`)).text();
      post({ type: 'progress', fraction: 0.08, label: 'Starting text recognition' });
      const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      const detS = await ort.InferenceSession.create(det, opts);
      const recS = await ort.InferenceSession.create(rec, opts);
      return { ort: ort as never, det: detS, rec: recS, chars: buildCharset(dict, 18385) };
    })();
    models.catch(() => (models = null));
  }
  return models;
}

self.onmessage = async (ev: MessageEvent<OcrRequest>) => {
  const msg = ev.data;
  try {
    const m = await loadModels(msg.base);
    const img: RGBAImage = { width: msg.width, height: msg.height, data: msg.data };
    const lines = await runOcr(m, img, { pxPerMm: msg.pxPerMm, onProgress: (f, label) => post({ type: 'progress', fraction: 0.1 + f * 0.9, label }) });
    post({ type: 'done', lines: lines.map((l) => ({ ...l, rgb: lineColor(img, l) })) });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
