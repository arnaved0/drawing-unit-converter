// Copies pdf.js runtime data from node_modules into public/vendor so Vite
// serves it in development and includes it in the build: CMaps (needed for
// CJK and other CID-keyed fonts), standard font data and image decoders.
// (The LibreDWG and ONNX Runtime WebAssembly files are bundled by Vite.)
// (The LibreDWG WebAssembly file is bundled by Vite automatically.)
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const out = join(root, 'public', 'vendor', 'pdfjs');

rmSync(join(root, 'public', 'vendor'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  if (existsSync(join(src, dir))) cpSync(join(src, dir), join(out, dir), { recursive: true });
}
console.log('Copied pdf.js assets to public/vendor');
