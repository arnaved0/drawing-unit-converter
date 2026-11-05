// The fonts converted values are written in (public/fonts, made by
// scripts/make_fonts.py), chosen to look like the text they replace.

import { METRICS, type FaceMetrics } from './metrics';

export type FaceId = 'sans' | 'sans-bold' | 'serif' | 'serif-bold' | 'mono' | 'mono-bold' | 'dejavu' | 'dejavu-bold' | 'iso';

export interface Face {
  id: FaceId;
  /** Family group: matching picks a group for a page, then the weight per line. */
  family: 'sans' | 'serif' | 'mono' | 'dejavu' | 'iso';
  bold: boolean;
  /** CSS font-family name the preview registers the font under. */
  css: string;
  /** Generic CSS fallback. */
  generic: string;
  m: FaceMetrics;
}

const face = (id: FaceId, family: Face['family'], bold: boolean, css: string, generic: string): Face => ({ id, family, bold, css, generic, m: METRICS[id] });

export const FACES: Face[] = [
  face('sans', 'sans', false, 'DUC Sans', 'Arial, Helvetica, sans-serif'),
  face('sans-bold', 'sans', true, 'DUC Sans Bold', 'Arial, Helvetica, sans-serif'),
  face('serif', 'serif', false, 'DUC Serif', "'Times New Roman', serif"),
  face('serif-bold', 'serif', true, 'DUC Serif Bold', "'Times New Roman', serif"),
  face('mono', 'mono', false, 'DUC Mono', "'Courier New', monospace"),
  face('mono-bold', 'mono', true, 'DUC Mono Bold', "'Courier New', monospace"),
  face('dejavu', 'dejavu', false, 'DUC DejaVu', 'Verdana, sans-serif'),
  face('dejavu-bold', 'dejavu', true, 'DUC DejaVu Bold', 'Verdana, sans-serif'),
  face('iso', 'iso', false, 'DUC ISO', 'sans-serif'),
];

const BY_ID = new Map(FACES.map((f) => [f.id, f]));
export const getFace = (id: FaceId | undefined): Face => BY_ID.get(id ?? 'sans') ?? BY_ID.get('sans')!;

/** The face of a family with the given weight (the ISO font has one weight). */
export function familyFace(family: Face['family'], bold: boolean): Face {
  return FACES.find((f) => f.family === family && f.bold === bold) ?? FACES.find((f) => f.family === family)!;
}

const advCache = new Map<string, Map<string, number>>();
function advances(f: Face): Map<string, number> {
  let m = advCache.get(f.id);
  if (!m) {
    m = new Map();
    const chars = [...f.m.chars];
    chars.forEach((c, i) => m!.set(c, f.m.adv[i]));
    advCache.set(f.id, m);
  }
  return m;
}

/** Characters the face can draw, after the usual drawing substitutions. */
export function faceChar(f: Face, ch: string): string | null {
  const a = advances(f);
  if (a.has(ch)) return ch;
  const alt = ch === '\u2300' || ch === '\u03a6' ? '\u00d8' : ch === '\u2033' ? '"' : ch === '\u2032' ? "'" : ch === '\u2212' ? '-' : null;
  return alt && a.has(alt) ? alt : null;
}

/** Advance width of `text` at em size 1 (no width factor). Missing characters count as "0". */
export function advance(f: Face, text: string): number {
  const a = advances(f);
  const zero = a.get('0') ?? f.m.upem * 0.55;
  let w = 0;
  for (const ch of text) {
    const c = faceChar(f, ch);
    w += c ? a.get(c)! : zero;
  }
  return w / f.m.upem;
}

/** Cap height as a fraction of the em size. */
export const capRatio = (f: Face) => f.m.cap / f.m.upem;

/**
 * The face for a font named in a PDF or DXF ("ABCDEF+Arial-BoldMT",
 * "Times New Roman", "isocpeur.ttf", "romans.shx" ...).
 */
export function faceForFontName(name: string | undefined, flags: { bold?: boolean; serif?: boolean; mono?: boolean } = {}): FaceId {
  const n = (name ?? '').replace(/^[A-Z]{6}\+/, '').toLowerCase();
  const bold = !!flags.bold || /bold|black|heavy|semibold|demi|\bbd\b|-bd/.test(n);
  let family: Face['family'];
  if (/isoc|iso.?3098|osifont|romans|romand|romant|simplex|complex|\btxt\b|^txt|gdt|isoc[pt]|monotxt|gost|cad/.test(n)) family = 'iso';
  else if (/courier|mono|consol|lucida ?console|cousine|typewriter/.test(n)) family = 'mono';
  else if (/dejavu|vera|verdana|tahoma|noto ?sans|open ?sans|segoe|frutiger|myriad/.test(n)) family = 'dejavu';
  else if (/times|tinos|serif|roman|georgia|cambria|garamond|minion|book ?antiqua|palatino|century/.test(n) && !/sans/.test(n)) family = 'serif';
  else if (/arial|helvetica|arimo|liberation ?sans|nimbus ?sans|swiss|calibri|sans/.test(n)) family = 'sans';
  else family = flags.mono ? 'mono' : flags.serif ? 'serif' : 'sans';
  return familyFace(family, bold).id;
}

// ---------------------------------------------------------------- loading (browser)

let base = '/';
/** Where public/fonts is served from (Vite's BASE_URL). */
export function setFontBase(b: string): void {
  base = b.endsWith('/') ? b : b + '/';
}
export const fontUrl = (id: FaceId) => `${base}fonts/${id}.ttf`;

const bytesCache = new Map<FaceId, Promise<Uint8Array>>();
/** The font file, for embedding in a PDF. */
export function fontBytes(id: FaceId): Promise<Uint8Array> {
  let p = bytesCache.get(id);
  if (!p) {
    p = fetch(fontUrl(id)).then(async (r) => {
      if (!r.ok) throw new Error(`Could not load font ${id} (${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    });
    p.catch(() => bytesCache.delete(id));
    bytesCache.set(id, p);
  }
  return p;
}

let registered = false;
/** Registers every face with the document; a font is only downloaded when text uses it. */
export function registerFaces(): void {
  if (registered || typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  registered = true;
  for (const f of FACES) document.fonts.add(new FontFace(f.css, `url(${fontUrl(f.id)})`));
}

/** Loads every face (needed before drawing them on a canvas to compare with a drawing). */
export async function loadAllFaces(): Promise<void> {
  registerFaces();
  if (typeof document === 'undefined') return;
  await Promise.all(FACES.map((f) => document.fonts.load(`32px "${f.css}"`).catch(() => [])));
}
