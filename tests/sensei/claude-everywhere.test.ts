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

describe('transcribing a class again', () => {
  it('detaches the current transcript (kept for history) and queues the lecture', async () => {
    const { testDb } = await import('./helpers');
    const { retranscribeLecture } = await import('@/lib/sensei/jobs');
    const { ensureCourse, ensureLecture, linkLectureSource, registerSource, sha256 } = await import('@/lib/sensei/store');
    const db = await testDb();
    try {
      const course = await ensureCourse(db, 'RESP 101A', 'RC1');
      const lectureId = await ensureLecture(db, { courseId: course, date: '2026-09-17', title: 'Lab 9/17' });
      const audio = await registerSource(db, { sha256: sha256('a'), kind: 'audio', courseId: course, title: 'a', originalName: 'a.m4a', storedPath: '/a' });
      const old = await registerSource(db, { sha256: sha256('t'), kind: 'transcript', courseId: null, title: 'Transcript', originalName: 't', storedPath: '/t', derivedFrom: audio.id });
      await linkLectureSource(db, lectureId, audio.id);
      await linkLectureSource(db, lectureId, old.id);
      await db.query(`INSERT INTO sensei_job (status, input, lecture_id, detail) VALUES ('failed', '{"files":[]}', $1, 'x')`, [lectureId]);
      expect(await retranscribeLecture(db, lectureId)).not.toBeNull();
      const { rows: links } = await db.query<{ source_id: string }>('SELECT source_id FROM sensei_lecture_source WHERE lecture_id = $1', [lectureId]);
      expect(links.map((l) => l.source_id)).toEqual([audio.id]);
      const { rows: kept } = await db.query('SELECT 1 FROM sensei_source WHERE id = $1', [old.id]);
      expect(kept).toHaveLength(1);
      const { rows: job } = await db.query<{ status: string }>('SELECT status FROM sensei_job');
      expect(job[0].status).toBe('queued');
    } finally {
      await db.close();
    }
  });
});

describe('lesson narration', () => {
  it('builds narration URLs for the public address, not localhost', async () => {
    const { publicOriginHeaders } = await import('@/lib/sensei/lesson');
    expect(publicOriginHeaders({ SENSEI_PUBLIC_URL: 'https://sensei.walkersnotary.com' } as NodeJS.ProcessEnv)).toEqual({
      'x-forwarded-host': 'sensei.walkersnotary.com',
      'x-forwarded-proto': 'https',
    });
    expect(publicOriginHeaders({} as NodeJS.ProcessEnv)).toEqual({});
  });
});
