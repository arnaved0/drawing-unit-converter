// Translation of text the user boxed.
//
// First choice: the browser's own on-device translator (Chrome's Translator
// API), so nothing leaves the computer. Where the browser has none, and only
// when the user allows it, the text is sent to an online translator (Google
// Translate, then MyMemory). Only the boxed text is sent, never the drawing.

import { guessLanguage } from './fonts/script';

export const LANGUAGES: [code: string, name: string][] = [
  ['en', 'English'], ['zh-CN', 'Chinese (Simplified)'], ['zh-TW', 'Chinese (Traditional)'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'],
  ['pl', 'Polish'], ['cs', 'Czech'], ['sv', 'Swedish'], ['da', 'Danish'], ['fi', 'Finnish'], ['no', 'Norwegian'],
  ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['el', 'Greek'], ['hu', 'Hungarian'], ['ro', 'Romanian'],
  ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['th', 'Thai'], ['vi', 'Vietnamese'], ['id', 'Indonesian'], ['ms', 'Malay'],
];

export const languageName = (code: string) => LANGUAGES.find(([c]) => c === code)?.[1] ?? code;

export interface Translation {
  text: string;
  /** Who translated it, for the dialog ("on this device", "Google Translate"). */
  engine: string;
  /** The language the text was found to be in. */
  from: string;
}

/** Chrome's on-device language detection, or a guess from the letters. */
export async function detectLanguage(text: string): Promise<string | null> {
  const fromLetters = guessLanguage(text);
  const g = globalThis as any;
  if (g.LanguageDetector?.create) {
    try {
      // only a detector that is ready: none is downloaded just to guess the language
      const ready = g.LanguageDetector.availability ? await within(g.LanguageDetector.availability(), 1500) : 'available';
      if (ready !== 'available' && ready !== 'readily') return fromLetters;
      const det: any = await within(g.LanguageDetector.create(), 3000);
      const found: any[] = (det ? await within(det.detect(text), 4000) : null) ?? [];
      const best = found[0];
      if (best?.detectedLanguage && best.detectedLanguage !== 'und' && best.confidence > 0.5) {
        // the detector says "zh"; the letters tell Simplified from Traditional
        return best.detectedLanguage === 'zh' && fromLetters?.startsWith('zh') ? fromLetters : best.detectedLanguage;
      }
    } catch {
      // not available here
    }
  }
  return fromLetters;
}

/** The base language of a code ("zh-CN" -> "zh"), as Chrome's translator names them. */
const base = (code: string) => (code.startsWith('zh-TW') ? 'zh-Hant' : code.split('-')[0]);

async function onDevice(text: string, from: string, to: string, onStatus?: (msg: string) => void): Promise<string | null> {
  const g = globalThis as any;
  if (!g.Translator?.create) return null;
  const opts = { sourceLanguage: base(from), targetLanguage: base(to) };
  try {
    const avail = await within(g.Translator.availability(opts), 3000);
    if (!avail || avail === 'unavailable' || avail === 'no') return null;
    // a language pack may download first (once); give up if it stops moving
    let last = Date.now();
    if (avail !== 'available') onStatus?.(`Downloading the ${languageName(from)} → ${languageName(to)} language pack (once)…`);
    const created = g.Translator.create({
      ...opts,
      monitor(m: EventTarget) {
        m.addEventListener('downloadprogress', (e: any) => {
          last = Date.now();
          const f = typeof e.loaded === 'number' ? (e.total ? e.loaded / e.total : e.loaded) : 0;
          onStatus?.(`Downloading the ${languageName(from)} → ${languageName(to)} language pack (once): ${Math.round(Math.min(1, f) * 100)}%…`);
        });
      },
    });
    const stalled = new Promise<null>((resolve) => {
      const tick = () => (Date.now() - last > 15000 ? resolve(null) : setTimeout(tick, 1000));
      setTimeout(tick, 1000);
    });
    const tr: any = await Promise.race([created, stalled]);
    if (!tr) return null;
    onStatus?.('Translating on this device…');
    const out = await within(tr.translate(text), 30000);
    return out === null ? null : String(out);
  } catch {
    return null;
  }
}

async function google(text: string, from: string, to: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${encodeURIComponent(from || 'auto')}&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Translate answered ${res.status}`);
  const data = await res.json();
  const out = (data?.[0] ?? []).map((part: unknown[]) => part?.[0] ?? '').join('');
  if (!out) throw new Error('Google Translate returned nothing');
  return out;
}

async function myMemory(text: string, from: string, to: string): Promise<string> {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(from || 'en')}|${encodeURIComponent(to)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MyMemory answered ${res.status}`);
  const data = await res.json();
  const out = data?.responseData?.translatedText;
  if (!out || data?.responseStatus >= 400) throw new Error(data?.responseDetails ?? 'MyMemory returned nothing');
  return String(out);
}

export class NeedsOnline extends Error {}

/** `p`, or null after `ms` (a browser API that never answers, a model that never loads). */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/**
 * Translates `text` into `to`. `from` is the source language or '' to detect
 * it. Online translators are used only when `allowOnline` is set.
 */
export async function translate(text: string, from: string, to: string, allowOnline: boolean, onStatus?: (msg: string) => void): Promise<Translation> {
  const src = from || (await detectLanguage(text)) || '';
  if (src && base(src) === base(to)) return { text, engine: 'nothing to do (same language)', from: src };
  if (src) {
    const local = await onDevice(text, src, to, onStatus);
    if (local) return { text: local, engine: 'your browser, on this device', from: src };
  }
  if (!allowOnline) {
    throw new NeedsOnline(
      src
        ? `This browser cannot translate ${languageName(src)} to ${languageName(to)} on this device.`
        : 'This browser cannot translate on this device.',
    );
  }
  const errors: string[] = [];
  onStatus?.('Translating online…');
  try {
    return { text: await google(text, src, to), engine: 'Google Translate (online)', from: src };
  } catch (err) {
    errors.push((err as Error).message);
  }
  try {
    return { text: await myMemory(text, src, to), engine: 'MyMemory (online)', from: src };
  } catch (err) {
    errors.push((err as Error).message);
  }
  throw new Error(`The text could not be translated (${errors.join('; ')}). Check the internet connection, or type the translation yourself.`);
}
