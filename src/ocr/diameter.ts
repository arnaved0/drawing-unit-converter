// Puts back the diameter sign (Ø) that OCR loses.
//
// The PP-OCRv5 recogniser has no Ø in its alphabet. It reads a Ø in front of a
// number as "0" ("Ø60" -> "060"), as the letter O or D, or leaves it out
// ("Ø30 H7" -> "30 H7"). Candidate texts with a Ø are drawn in the line's font
// and compared with the letter shapes on the page (fonts/match.ts): a Ø is put
// in when the shapes say so.

import { familyFace, getFace, type Face } from '../fonts/faces';
import { fitFace, measureLine, snappedBox, type Fit, type LineBox, type Measured, type RenderText, type RGBA } from '../fonts/match';

const DIA = '\u00d8';

/** A number that can be a length: alone, or followed by a unit, a tolerance class, a count or punctuation. */
const LENGTH_AFTER = /^(?:\d+(?:\.\s?\d+)?|\.\d+)(?=$|\s|mm\b|cm\b|m\b|in\b|"|\u2033|\/\d|-\d+\/\d|[)\],;xX\u00d7]|[A-HJ-NP-Za-hj-np-z]{1,2}\d{1,2}\b|$)/;

/** Start of a word: what may come before a Ø ("2X Ø12", "(Ø8)", "Bore Ø22", "2XØ12"). */
const WORD_START = /(^|[\s(\[=:<>~]|\d[xX])$/;

interface Edit {
  text: string;
  /** Where the Ø went. */
  at: number;
  /** A sure misreading (a number with a leading zero, "O12"): accepted unless the shapes clearly disagree. */
  sure: boolean;
}

/**
 * Texts with one Ø more than `text`: a "0", "O", "o", "D" or "Q" at the start of a
 * number turned into Ø, or a Ø put in front of a number. Each with and without
 * a space after the Ø ("Ø 96.5").
 */
export function diameterEdits(text: string): Edit[] {
  const out: Edit[] = [];
  const add = (at: number, cut: number, sure: boolean) => {
    // a Ø goes in front of a length: not of "304SS", "120V", "M6"
    if (!LENGTH_AFTER.test(text.slice(at + cut).replace(/^\s/, ''))) return;
    for (const sp of ['', ' ']) {
      if (sp && text[at + cut] === ' ') continue;
      out.push({ text: text.slice(0, at) + DIA + sp + text.slice(at + cut), at, sure: sure && !sp });
    }
  };
  for (let i = 0; i < text.length; i++) {
    if (!WORD_START.test(text.slice(0, i))) continue;
    const ch = text[i];
    const next = text.slice(i + 1);
    // "060", "00.75", "022.3mm": drawings do not write numbers with a leading zero
    if (ch === '0' && /^\d/.test(next)) add(i, 1, true);
    // "O12", "o12": no word starts with a letter O and a digit
    else if ((ch === 'O' || ch === 'o') && /^\d/.test(next)) add(i, 1, true);
    // "D60", "Q12": also a real notation ("D60" = diameter 60), so only when the shapes say so
    else if ((ch === 'D' || ch === 'Q') && /^\s?\d/.test(next)) add(i, 1, false);
    // nothing read where the Ø is: "30 H7", "Bore 22.3mm"
    if (/\d/.test(ch) || (ch === '.' && /^\d/.test(next))) add(i, 0, false);
  }
  return out;
}

const DIGIT_LIKE: Record<string, string> = { O: '0', o: '0', D: '0', Q: '0', G: '6', b: '6', S: '5', s: '5', B: '8', l: '1', I: '1', '|': '1', Z: '2', z: '2' };

/** Words made of digits and digit look-alikes, with the look-alikes as digits ("0Go" -> "060"). */
export function digitised(text: string): string {
  return text.replace(/[0-9OoDQGbSsBlI|Zz.]{2,}/g, (w) => (/\d/.test(w) && /^[0-9OoDQGbSsBlI|Zz]/.test(w) ? w.replace(/[OoDQGbSsBlI|Zz]/g, (c) => DIGIT_LIKE[c]) : w));
}

/** `text` with a Ø at the start of every number (a misread 0, O, D or Q there becomes the Ø). */
function everyDiameter(text: string): string {
  return text.replace(/(^|[\s(\[=:<>~])(?:[0OoQ](?=\d)|D(?=\d))?(?=\d|\.\d)/g, (_m, pre: string) => pre + DIA);
}

/** `cur` with one of its added Ø signs taken out again (only while it has more than `orig`). */
function withoutOne(cur: string, orig: string): string[] {
  const count = (t: string) => [...t].filter((c) => c === DIA).length;
  if (count(cur) <= count(orig)) return [];
  const out: string[] = [];
  for (let i = 0; i < cur.length; i++) if (cur[i] === DIA) out.push(cur.slice(0, i) + cur.slice(i + 1));
  return out;
}

/** Turns "Ø60" into "Ø 60" or back. */
function spacings(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== DIA) continue;
    if (text[i + 1] === ' ') out.push(text.slice(0, i + 1) + text.slice(i + 2));
    else if (/\d/.test(text[i + 1] ?? '')) out.push(text.slice(0, i + 1) + ' ' + text.slice(i + 1));
  }
  return out;
}

/**
 * Gain in shape score a Ø must bring when nothing in the reading stood for
 * it. One letter changes the score of a long line less, so the bar is lower there.
 */
const gainFor = (text: string) => Math.max(0.02, (0.08 * 5) / Math.max(5, text.replace(/\s/g, '').length));
/** How much worse a sure fix may score (the shapes of 0 and Ø are close in some fonts). */
const SURE_LOSS = 0.1;
/**
 * How much better a Ø must match than a plain O in its place. Any extra letter
 * can raise the score of a poorly measured line, and there an O matches as
 * well or better; a real Ø matches better by its slash (only just, for the
 * thin slash of serif fonts at small sizes).
 */
const OVER_O = 0.005;

export interface DiameterFix {
  text: string;
  /** The box the text was read in (another direction when an alternative reading won). */
  box: LineBox;
  /** The fit of the fixed text, in the line's font. */
  fit: Fit | null;
}

/**
 * The reading of a line with its Ø signs put back. `fit` is the line's font fit
 * (from matchFonts), `family` the page's font family.
 */
export function fixDiameters(
  img: RGBA,
  line: { l: LineBox & { alts?: { text: string; u: { x: number; y: number }; len: number; hgt: number }[] }; text: string },
  fit: Fit | null,
  family: Face['family'] | null,
  render: RenderText,
): DiameterFix | null {
  const raw = [{ text: line.text, box: line.l as LineBox }, ...(line.l.alts ?? []).map((a) => ({ text: a.text, box: { ...line.l, u: a.u, len: a.len, hgt: a.hgt } }))];
  // also a box a few degrees off an axis put on the axis; readings in other
  // directions also with letters as digits (the main reading's "304SS" is a word)
  const readings = raw.flatMap((r, k) => {
    const texts = k > 0 ? [...new Set([r.text, digitised(r.text)])] : [r.text];
    const snapped = snappedBox(r.box);
    const boxes = snapped ? [r.box, snapped] : [r.box];
    return texts.flatMap((text) => boxes.map((box) => ({ text, box, k })));
  });
  let best: { text: string; box: LineBox; score: number; fit: Fit | null; changed: boolean } | null = null;
  readings.forEach(({ k, ...r }) => {
    if (!/\d/.test(r.text)) return;
    const m = measureLine(img, r.box, r.text);
    if (!m) return;
    const faces = candidateFaces(fit, family);
    const res = improve(m, r.text, faces, fit?.slant ?? 0, render);
    if (!res) return;
    // another direction must be clearly better: upright readings are the rule
    const score = res.score - (k > 0 ? 0.05 : 0);
    if (!best || score > best.score) best = { text: res.text, box: r.box, score, fit: res.fit, changed: k > 0 || res.text !== r.text };
  });
  const b = best as { text: string; box: LineBox; score: number; fit: Fit | null; changed: boolean } | null;
  return b && b.changed ? { text: b.text, box: b.box, fit: b.fit } : null;
}

function candidateFaces(fit: Fit | null, family: Face['family'] | null): Face[] {
  const out = new Map<string, Face>();
  if (fit) out.set(fit.face, getFace(fit.face));
  if (family) for (const bold of [false, true]) out.set(familyFace(family, bold).id, familyFace(family, bold));
  if (!out.size) out.set('sans', getFace('sans'));
  return [...out.values()];
}

/** Best score of `text` over `faces`. */
function score(m: Measured, text: string, faces: Face[], slant: number, render: RenderText): Fit | null {
  let best: Fit | null = null;
  for (const f of faces) {
    const r = fitFace(m, text, f, slant, render);
    if (r && (!best || r.score > best.score)) best = r;
  }
  return best;
}

/** Puts Ø signs into `text` one at a time while the shapes agree (at most 4). */
function improve(m: Measured, text: string, faces: Face[], slant: number, render: RenderText): { text: string; score: number; fit: Fit | null } | null {
  const first = score(m, text, faces, slant, render);
  if (!first) return null;
  let cur = { text, score: first.score, fit: first as Fit | null };
  // Several Ø on a line ("Ø60 to Ø44"): one alone shifts the rest of the line
  // and hardly scores, so a Ø at every number is tried too, then thinned out.
  const every = everyDiameter(text);
  if (every !== text) {
    const f = score(m, every, faces, slant, render);
    const o = f && score(m, every.replace(/\u00d8/g, 'O'), faces, slant, render);
    if (f && f.score >= cur.score + gainFor(text) && f.score >= (o?.score ?? 0) + OVER_O) {
      cur = { text: every, score: f.score, fit: f };
      for (let step = 0; step < 4; step++) {
        let drop: typeof cur | null = null;
        for (const t of withoutOne(cur.text, text)) {
          const g = score(m, t, faces, slant, render);
          if (g && g.score > (drop?.score ?? cur.score + 0.02)) drop = { text: t, score: g.score, fit: g };
        }
        if (!drop) break;
        cur = drop;
      }
    }
  }
  for (let step = 0; step < 4; step++) {
    let pick: { text: string; rank: number; fit: Fit } | null = null;
    for (const e of diameterEdits(cur.text)) {
      const f = score(m, e.text, faces, slant, render);
      if (!f) continue;
      const need = e.sure ? -SURE_LOSS : gainFor(cur.text);
      if (f.score - cur.score < need) continue;
      if (!e.sure) {
        const o = score(m, e.text.slice(0, e.at) + 'O' + e.text.slice(e.at + 1), faces, slant, render);
        if (o && f.score < o.score + OVER_O) continue;
      }
      // a sure fix wins over an unsure one that scores about the same
      const rank = f.score + (e.sure ? 0.1 : 0);
      if (!pick || rank > pick.rank) pick = { text: e.text, rank, fit: f };
    }
    if (!pick) break;
    cur = { text: pick.text, score: pick.fit.score, fit: pick.fit };
  }
  // "Ø60" or "Ø 60": whichever matches the spacing on the page
  for (let step = 0; step < 3; step++) {
    let moved = false;
    for (const t of spacings(cur.text)) {
      const f = score(m, t, faces, slant, render);
      // only on clear evidence: anti-aliasing and nearby strokes blur the gap
      if (f && f.score > cur.score + 0.06) {
        cur = { text: t, score: f.score, fit: f };
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return cur;
}
