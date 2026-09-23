/**
 * Precise clip boundaries from word-level timestamps (whisper.cpp). Pure functions:
 * find the professor's quote in the word stream, grow it to whole sentences so the
 * clip stands alone, cap it, and pad the edges slightly so no syllable is clipped.
 * (DECISIONS V12, V13.)
 */
import { normalizeStatement } from '../normalize';

export interface Word {
  text: string;
  startMs: number;
  endMs: number;
}

/** Common ways speech recognition splits RT jargon, mapped back. */
const JARGON: [RegExp, string][] = [
  [/\bpack\s*o\s*2\b/g, 'paco2'],
  [/\bpa\s*co\s*2\b/g, 'paco2'],
  [/\bpa\s*o\s*2\b/g, 'pao2'],
  [/\bfi\s*o\s*2\b/g, 'fio2'],
  [/\bsp\s*o\s*2\b/g, 'spo2'],
  [/\bsa\s*o\s*2\b/g, 'sao2'],
  [/\bet\s*co\s*2\b/g, 'etco2'],
  [/\bc\s*m\s*h\s*2\s*o\b/g, 'cmh2o'],
  [/\bh\s*co\s*3\b/g, 'hco3'],
  [/\bpeep\b/g, 'peep'],
];

export function tokens(text: string): string[] {
  let t = normalizeStatement(text);
  for (const [re, to] of JARGON) t = t.replace(re, to);
  return t
    .split(/\s+/)
    .map((w) => w.replace(/^[./]+|[./]+$/g, ''))
    .filter((w) => w.length > 0);
}

/** Best-matching word span for the quote (token overlap ≥ 0.75), or null. */
export function locateQuote(words: Word[], quote: string): [number, number] | null {
  const q = tokens(quote);
  if (q.length === 0) return null;
  const wt = words.map((w) => tokens(w.text).join(' '));
  let best: [number, number] | null = null;
  let bestScore = 0;
  for (let len = Math.max(1, q.length - 2); len <= q.length + 4; len++) {
    for (let s = 0; s + len <= words.length; s++) {
      const bag = new Map<string, number>();
      for (const w of wt.slice(s, s + len).join(' ').split(' ')) if (w) bag.set(w, (bag.get(w) ?? 0) + 1);
      let hit = 0;
      for (const t of q) {
        const n = bag.get(t) ?? 0;
        if (n > 0) {
          hit++;
          bag.set(t, n - 1);
        }
      }
      const score = hit / q.length - Math.abs(len - q.length) * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = [s, s + len - 1];
      }
    }
  }
  return bestScore >= 0.75 ? best : null;
}

const endsSentence = (w: Word) => /[.?!]["”')]*$/.test(w.text.trim());
const DEPENDENT_OPENERS = new Set(['it', 'this', 'that', 'these', 'those', 'they', 'he', 'she', 'so', 'and', 'but', 'because', 'which', 'then', 'also', 'thats', 'its']);

function sentenceStart(words: Word[], i: number): number {
  for (let k = i - 1; k >= 0; k--) if (endsSentence(words[k])) return k + 1;
  return 0;
}
function sentenceEnd(words: Word[], i: number, limit = 60): number {
  for (let k = i; k < Math.min(words.length, i + limit); k++) if (endsSentence(words[k])) return k;
  return Math.min(words.length - 1, i + limit - 1);
}

export interface ClipSpan {
  startMs: number;
  endMs: number;
  first: number;
  last: number;
  text: string;
}

export function clipSpan(words: Word[], span: [number, number], opts: { maxMs?: number; minMs?: number } = {}): ClipSpan {
  const maxMs = opts.maxMs ?? 30_000;
  const minMs = opts.minMs ?? 5_000;
  let first = sentenceStart(words, span[0]);
  let last = sentenceEnd(words, span[1]);
  const opener = tokens(words[first]?.text ?? '')[0] ?? '';
  // Stand-alone: bring in the previous sentence when this one leans on it, or when it's very short.
  if ((DEPENDENT_OPENERS.has(opener) || words[last].endMs - words[first].startMs < minMs) && first > 0) {
    first = sentenceStart(words, first - 1);
  }
  if (words[last].endMs - words[first].startMs < minMs && last < words.length - 1) last = sentenceEnd(words, last + 1);

  // Cap: trim from whichever side is farther from the quote, cutting at the longest pause.
  while (words[last].endMs - words[first].startMs > maxMs && (first < span[0] || last > span[1])) {
    const trimFront = span[0] - first > last - span[1];
    if (trimFront) {
      let cut = first + 1;
      let gap = -1;
      for (let k = first + 1; k <= span[0]; k++) {
        const g = words[k].startMs - words[k - 1].endMs;
        if (g > gap) [gap, cut] = [g, k];
      }
      first = Math.max(cut, first + 1);
    } else {
      let cut = last - 1;
      let gap = -1;
      for (let k = span[1]; k < last; k++) {
        const g = words[k + 1].startMs - words[k].endMs;
        if (g > gap) [gap, cut] = [g, k];
      }
      last = Math.min(cut, last - 1);
    }
  }
  // Pad into the surrounding pauses without touching neighboring words.
  const prevEnd = first > 0 ? words[first - 1].endMs : words[first].startMs - 400;
  const nextStart = last < words.length - 1 ? words[last + 1].startMs : words[last].endMs + 400;
  const startMs = Math.max(prevEnd + (words[first].startMs - prevEnd) / 2, words[first].startMs - 250);
  const endMs = Math.min(nextStart - (nextStart - words[last].endMs) / 2, words[last].endMs + 350);
  return {
    first,
    last,
    startMs: Math.round(Math.max(0, startMs)),
    endMs: Math.round(endMs),
    text: words.slice(first, last + 1).map((w) => w.text.trim()).join(' ').replace(/\s+([,.?!])/g, '$1'),
  };
}
