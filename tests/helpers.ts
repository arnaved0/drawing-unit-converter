import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { importPdf } from '../src/importers/pdf';
import type { PdfJs } from '../src/importers/pdf';

export const samplePath = (name: string) => fileURLToPath(new URL(`../samples/${name}`, import.meta.url));
export const readSample = (name: string) => new Uint8Array(readFileSync(samplePath(name)));

const pdfjsDir = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));

export function loadPdf(name: string, opts: Parameters<typeof importPdf>[3] = {}) {
  return importPdf(pdfjs as unknown as PdfJs, readSample(name), name, {
    ...opts,
    docParams: { cMapUrl: `${pdfjsDir}cmaps/`, cMapPacked: true, standardFontDataUrl: `${pdfjsDir}standard_fonts/` },
  });
}
