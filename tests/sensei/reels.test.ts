import { describe, expect, it } from 'vitest';

import { clipSpan, locateQuote, tokens, type Word } from '@/lib/sensei/reels/boundaries';

/** Build a word stream: ~300 ms per word, 150 ms gaps, longer gaps after sentences. */
function stream(text: string): Word[] {
  let t = 0;
  return text.split(/\s+/).map((w) => {
    const word = { text: w, startMs: t, endMs: t + 300 };
    t += 450 + (/[.?!]$/.test(w) ? 600 : 0);
    return word;
  });
}

const LECTURE = stream(
  'Okay so let us move on. Remember, the E cylinder factor is 0.28. This will be on the exam. ' +
    'Now the pack O2 tells you about ventilation. If it goes up the patient is hypoventilating. Moving on to liquid systems.',
);

describe('reel clip boundaries', () => {
  it('finds a quote and returns whole sentences', () => {
    const span = locateQuote(LECTURE, 'the E cylinder factor is 0.28')!;
    const clip = clipSpan(LECTURE, span, { minMs: 1000 });
    expect(clip.text).toBe('Remember, the E cylinder factor is 0.28.');
  });

  it('pulls in the previous sentence when the clip leans on it ("This will be on the exam")', () => {
    const span = locateQuote(LECTURE, 'This will be on the exam')!;
    expect(clipSpan(LECTURE, span, { minMs: 1000 }).text).toBe('Remember, the E cylinder factor is 0.28. This will be on the exam.');
  });

  it('tolerates recognizer jargon splits ("pack O2" for PaCO2)', () => {
    expect(tokens('pack O2')).toEqual(['paco2']);
    const span = locateQuote(LECTURE, 'the PaCO2 tells you about ventilation');
    expect(span).not.toBeNull();
  });

  it('returns null rather than guessing when the quote is not there', () => {
    expect(locateQuote(LECTURE, 'nitric oxide is a pulmonary vasodilator')).toBeNull();
  });

  it('pads edges into the silence without overlapping neighbors, and caps long clips', () => {
    const span = locateQuote(LECTURE, 'the E cylinder factor is 0.28')!;
    const clip = clipSpan(LECTURE, span, { minMs: 1000 });
    expect(clip.startMs).toBeLessThan(LECTURE[clip.first].startMs);
    expect(clip.startMs).toBeGreaterThan(LECTURE[clip.first - 1].endMs);
    const long = stream(Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ') + ' end.');
    const capped = clipSpan(long, [60, 62], { maxMs: 30_000 });
    expect(capped.endMs - capped.startMs).toBeLessThanOrEqual(31_000);
    expect(capped.first).toBeLessThanOrEqual(60);
    expect(capped.last).toBeGreaterThanOrEqual(62);
  });

  it('does not start on the previous sentence when a misheard word makes windows tie (real whisper case)', () => {
    const words = stream('Remember this for the exam the PaCO2 goes up when ventilation drops. Set the PEEP at 5 cm of water.');
    const span = locateQuote(words, 'Set the PEEP at 5 cmH2O')!;
    expect(words[span[0]].text).toBe('Set');
    expect(clipSpan(words, span, { minMs: 1000 }).text).toBe('Set the PEEP at 5 cm of water.');
  });

  it('matches jargon split across whisper words ("pack" "O2")', () => {
    const words = stream('Okay. pack O2 goes up. Next slide.');
    expect(locateQuote(words, 'PaCO2 goes up')).not.toBeNull();
  });

  it('keeps a minimum pad when word stamps touch, as whisper output does', () => {
    const words: Word[] = ['It', 'drops.', 'Set', 'the', 'PEEP.', 'Next'].map((text, i) => ({ text, startMs: 1000 + i * 500, endMs: 1500 + i * 500 }));
    const clip = clipSpan(words, [2, 4], { minMs: 0 });
    expect(clip.startMs).toBeLessThanOrEqual(words[2].startMs - 120);
    expect(clip.endMs).toBeGreaterThanOrEqual(words[4].endMs + 200);
  });
});
