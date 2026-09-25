import { describe, expect, it } from 'vitest';

import type { StructuredCall, StructuredLlm } from '@/lib/sensei/llm';
import { cleanTranscript, dropArtifacts, type RawSegment } from '@/lib/sensei/localTranscribe';
import { callCost } from '@/lib/sensei/pricing';
import { toPrompt } from '@/scripts/sensei/claude-bridge';

const seg = (n: number, text: string): RawSegment => ({ startMs: n * 10_000, endMs: n * 10_000 + 9_000, text });

describe('local transcription', () => {
  it('drops whisper artifacts: bracketed tags, credits, and lines looping over silence', () => {
    const out = dropArtifacts([seg(0, '[BLANK_AUDIO]'), seg(1, 'Sterile water goes in the humidifier.'), seg(2, 'Thank you.'), seg(3, 'Okay.'), seg(4, 'Okay.'), seg(5, 'Okay.'), seg(6, 'Okay.')]);
    expect(out.map((s) => s.text)).toEqual(['Sterile water goes in the humidifier.', 'Okay.', 'Okay.']);
  });

  it('proofreading fixes words but can never drop or invent content', async () => {
    const raw = [
      seg(0, 'It makes it 100% relative humidity because my lungs need 100% yellow treatment for gas exchange'),
      seg(1, 'So the sponge is very compliant because it is wet and the little air sacs stay open'),
      seg(2, 'um'),
    ];
    const llm: StructuredLlm = {
      modelName: () => 'fake',
      async call<T>(req: StructuredCall<T>): Promise<T> {
        return req.schema.parse({
          segments: [
            { n: 1, text: 'It makes it 100% relative humidity because my lungs need 100% relative humidity for gas exchange', speaker: 'instructor', slide_no: null, uncertain_terms: [] },
            { n: 2, text: 'Compliance.', speaker: 'instructor', slide_no: null, uncertain_terms: [] }, // over-shortened: rejected
            { n: 3, text: '', speaker: 'other', slide_no: null, uncertain_terms: [] },
          ],
        });
      },
    };
    const { units, rejected } = await cleanTranscript(llm, raw, '', 'lec');
    expect(units.map((u) => u.text)).toEqual([
      'It makes it 100% relative humidity because my lungs need 100% relative humidity for gas exchange',
      'So the sponge is very compliant because it is wet and the little air sacs stay open',
    ]);
    expect(rejected).toBe(1);
    expect(units[1].uncertainTerms).toContain('(proofreading skipped for this segment)');
    expect(units[0].startMs).toBe(0);
  });
});

describe('Claude bridge', () => {
  it('turns chat messages into one system prompt and a prompt with earlier turns', () => {
    expect(toPrompt([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }])).toEqual({ system: 'Be brief.', prompt: 'Hi' });
    const p = toPrompt([
      { role: 'user', content: [{ type: 'text', text: 'What is PEEP?' }] },
      { role: 'assistant', content: 'Positive end-expiratory pressure.' },
      { role: 'user', content: 'Normal range?' },
    ]);
    expect(p.prompt).toContain('User: What is PEEP?');
    expect(p.prompt).toContain('Assistant: Positive end-expiratory pressure.');
    expect(p.prompt.endsWith('Normal range?')).toBe(true);
  });

  it('subscription usage costs nothing in the budget', () => {
    expect(callCost('claude-opus', 1_000_000, 1_000_000)).toBe(0);
  });
});
