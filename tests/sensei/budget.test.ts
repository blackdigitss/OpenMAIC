import { describe, expect, it } from 'vitest';

import { purposeOf, summarize } from '@/lib/sensei/budget';
import { callCost, priceFor } from '@/lib/sensei/pricing';

const row = (source: string, modelId: string, inputTokens: number, outputTokens: number, day = 5) => ({
  id: 'x', createdAt: Date.UTC(2026, 8, day), kind: 'llm' as const, source, providerId: 'google', modelId,
  modelString: `google:${modelId}`, inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
});

describe('pricing', () => {
  it('prices known models and bills audio input at the audio rate', () => {
    expect(callCost('gemini-3.5-flash', 1_000_000, 100_000)).toBeCloseTo(1.5 + 0.9);
    expect(callCost('gemini-3-flash-preview', 1_000_000, 0, true)).toBeCloseTo(1);
    expect(callCost('gemini-3-flash-preview', 1_000_000, 0, false)).toBeCloseTo(0.5);
  });
  it('never under-counts an unknown model', () => {
    expect(priceFor('some-new-model').known).toBe(false);
    expect(callCost('some-new-model', 1_000_000, 1_000_000)).toBeGreaterThanOrEqual(callCost('gemini-3.1-pro-preview', 1_000_000, 1_000_000));
  });
});

describe('monthly summary', () => {
  it('splits Sensei purposes from OpenMAIC lessons and projects the month', () => {
    const s = summarize(
      [
        row('sensei:transcribe:abc', 'gemini-3.1-pro-preview', 230_000, 30_000),
        row('sensei:extract:abc', 'gemini-3.5-flash', 90_000, 45_000),
        row('scene-content', 'gemini-3-flash-preview', 200_000, 60_000),
      ],
      new Date(Date.UTC(2026, 8, 10)),
    );
    expect(purposeOf('sensei:transcribe:abc')).toBe('transcribe');
    expect(purposeOf('scene-content')).toBe('lessons');
    expect(s.byPurpose.map((p) => p.purpose)).toEqual(['transcribe', 'extract', 'lessons']);
    expect(s.total).toBeCloseTo(0.46 + 0.36 + 0.135 + 0.405 + 0.1 + 0.18, 2);
    expect(s.projected).toBeCloseTo((s.total / 10) * 30, 4);
  });
});
