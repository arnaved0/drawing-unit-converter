// DWG -> DXF (LibreDWG compiled to WebAssembly) -> drawing model.
// The 11 MB WebAssembly module is only downloaded when a DWG file is opened.

import type { Drawing } from '../model';
import { importDxf } from './dxf';

let libPromise: Promise<any> | null = null;

/**
 * wasmDir: folder that holds libredwg-web.wasm (no trailing slash). In the
 * browser leave it undefined: the bundler emits the file next to the module.
 */
async function getLib(wasmDir?: string): Promise<any> {
  if (!libPromise) {
    libPromise = import('@mlightcad/libredwg-web').then((m) => m.LibreDwg.create(wasmDir));
    libPromise.catch(() => (libPromise = null));
  }
  return libPromise;
}

export async function dwgToDxfBytes(bytes: Uint8Array, wasmDir?: string): Promise<Uint8Array> {
  const lib = await getLib(wasmDir);
  const copy = bytes.slice().buffer;
  const dxf: Uint8Array | null = lib.dwg_write_dxf(copy);
  if (!dxf || !dxf.length) throw new Error('LibreDWG could not convert this DWG file. It may be a version or feature LibreDWG does not support yet.');
  return new Uint8Array(dxf);
}

export async function importDwg(bytes: Uint8Array, name: string, wasmDir?: string): Promise<Drawing> {
  const dxfBytes = await dwgToDxfBytes(bytes, wasmDir);
  const drawing = importDxf(dxfBytes, name, 'dwg');
  drawing.warnings.unshift('DWG files are read with LibreDWG (open-source). Check the preview against the original before relying on it.');
  return drawing;
}
