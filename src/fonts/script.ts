// Writing systems the bundled fonts do not cover (Chinese, Japanese, Korean,
// Arabic, Hebrew, Thai, Devanagari), for translated text.
//
// The preview uses the browser's own fonts. A PDF gets the letters as filled
// outlines from a Noto font, fetched once when it is first needed (a few MB,
// from GitHub). The font is shaped by fontkit, so joined scripts (Arabic) and
// combining marks come out right; nothing is embedded, so the PDF stays small.

export type Script = 'sc' | 'tc' | 'ja' | 'ko' | 'arabic' | 'hebrew' | 'thai' | 'devanagari';

const RAW = 'https://raw.githubusercontent.com/';
export const SCRIPT_FONT_URLS: Record<Script, string> = {
  sc: `${RAW}notofonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf`,
  tc: `${RAW}notofonts/noto-cjk/main/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf`,
  ja: `${RAW}notofonts/noto-cjk/main/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf`,
  ko: `${RAW}notofonts/noto-cjk/main/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf`,
  arabic: `${RAW}google/fonts/main/ofl/notosansarabic/NotoSansArabic%5Bwdth,wght%5D.ttf`,
  hebrew: `${RAW}google/fonts/main/ofl/notosanshebrew/NotoSansHebrew%5Bwdth,wght%5D.ttf`,
  thai: `${RAW}google/fonts/main/ofl/notosansthai/NotoSansThai%5Bwdth,wght%5D.ttf`,
  devanagari: `${RAW}google/fonts/main/ofl/notosansdevanagari/NotoSansDevanagari%5Bwdth,wght%5D.ttf`,
};

const HAN = /[㐀-䶿一-鿿豈-﫿]/;
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
/** Characters only Traditional Chinese uses (a few common ones). */
const TRADITIONAL = /[們這個來時會說對過發後國問題還點長開關體電機車門東應實學將經與無從頭當義區處見請邊讓認變]/;

/**
 * The writing system of `text` that needs a font of its own, or null when the
 * bundled fonts (Latin, Greek, Cyrillic) are enough. `lang` (a language code
 * such as "ja" or "zh-TW") decides between the Chinese and Japanese forms.
 */
export function scriptOf(text: string, lang?: string): Script | null {
  const l = (lang ?? '').toLowerCase();
  if (KANA.test(text) || (l.startsWith('ja') && HAN.test(text))) return 'ja';
  if (HANGUL.test(text)) return 'ko';
  if (HAN.test(text) || /[　-〿＀-｠]/.test(text)) {
    if (l === 'zh-tw' || l === 'zh-hk' || l === 'zh-hant' || (!l && TRADITIONAL.test(text))) return 'tc';
    return 'sc';
  }
  if (/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(text)) return 'arabic';
  if (/[֐-׿]/.test(text)) return 'hebrew';
  if (/[฀-๿]/.test(text)) return 'thai';
  if (/[ऀ-ॿ]/.test(text)) return 'devanagari';
  return null;
}

/** A guess of the language of `text` from its letters (a language code), or null. */
export function guessLanguage(text: string): string | null {
  const s = scriptOf(text);
  if (s === 'ja') return 'ja';
  if (s === 'ko') return 'ko';
  if (s === 'sc') return 'zh-CN';
  if (s === 'tc') return 'zh-TW';
  if (s === 'arabic') return 'ar';
  if (s === 'hebrew') return 'he';
  if (s === 'thai') return 'th';
  if (s === 'devanagari') return 'hi';
  if (/[Ѐ-ӿ]/.test(text)) return 'ru';
  if (/[Ͱ-Ͽ]/.test(text)) return 'el';
  return null;
}

/** The parts of a fontkit font used here. */
export interface ShapingFont {
  unitsPerEm: number;
  layout(text: string): {
    glyphs: { path: { commands: { command: string; args: number[] }[] } }[];
    positions: { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }[];
  };
}

/** A path command in em units (1 = the font size), y up from the baseline. */
export type OutlineOp =
  | { op: 'M' | 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'Z' };

/** The outlines of `text` shaped in `font`, and its advance width (em units). */
export function outlineText(font: ShapingFont, text: string): { ops: OutlineOp[]; advance: number } {
  const run = font.layout(text);
  const k = 1 / font.unitsPerEm;
  const ops: OutlineOp[] = [];
  let x = 0;
  let y = 0;
  run.glyphs.forEach((g, i) => {
    const p = run.positions[i];
    const ox = x + p.xOffset;
    const oy = y + p.yOffset;
    let cx = 0;
    let cy = 0;
    for (const c of g.path.commands) {
      const a = c.args;
      const P = (ax: number, ay: number) => ({ x: (ox + ax) * k, y: (oy + ay) * k });
      if (c.command === 'moveTo' || c.command === 'lineTo') {
        const q = P(a[0], a[1]);
        ops.push({ op: c.command === 'moveTo' ? 'M' : 'L', ...q });
        [cx, cy] = [a[0], a[1]];
      } else if (c.command === 'bezierCurveTo') {
        const p1 = P(a[0], a[1]);
        const p2 = P(a[2], a[3]);
        const q = P(a[4], a[5]);
        ops.push({ op: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: q.x, y: q.y });
        [cx, cy] = [a[4], a[5]];
      } else if (c.command === 'quadraticCurveTo') {
        // a quadratic Bezier as a cubic
        const c1 = { x: cx + (2 / 3) * (a[0] - cx), y: cy + (2 / 3) * (a[1] - cy) };
        const c2 = { x: a[2] + (2 / 3) * (a[0] - a[2]), y: a[3] + (2 / 3) * (a[1] - a[3]) };
        const p1 = P(c1.x, c1.y);
        const p2 = P(c2.x, c2.y);
        const q = P(a[2], a[3]);
        ops.push({ op: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: q.x, y: q.y });
        [cx, cy] = [a[2], a[3]];
      } else if (c.command === 'closePath') ops.push({ op: 'Z' });
    }
    x += p.xAdvance;
    y += p.yAdvance;
  });
  return { ops, advance: x * k };
}

/** Loads the font of a writing system: from `fetcher` (tests) or GitHub. */
export type ScriptFontLoader = (s: Script) => Promise<ShapingFont | null>;

const cache = new Map<Script, Promise<ShapingFont | null>>();
/** Fetches and opens the Noto font for a writing system (once per session). */
export function webScriptFont(s: Script): Promise<ShapingFont | null> {
  let p = cache.get(s);
  if (!p) {
    p = (async () => {
      const res = await fetch(SCRIPT_FONT_URLS[s]);
      if (!res.ok) throw new Error(`Could not download the font for this script (${res.status}).`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const fontkit = (await import('@pdf-lib/fontkit')).default as unknown as { create(b: Uint8Array): ShapingFont };
      return fontkit.create(buf);
    })();
    p.catch(() => cache.delete(s));
    cache.set(s, p);
  }
  return p;
}
