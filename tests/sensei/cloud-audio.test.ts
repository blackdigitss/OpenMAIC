import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { summarize } from '@/lib/sensei/budget';
import { courseSnapshot, SENSEI_BRIEF } from '@/lib/sensei/brief';
import { planPieces, punctuate } from '@/lib/sensei/cloudTranscribe';
import { quantityCost } from '@/lib/sensei/pricing';

const seen: { system: string }[] = [];
vi.mock('@/lib/ai/llm', () => ({
  callLLM: vi.fn(async (opts: { system: string }) => {
    seen.push({ system: opts.system });
    return { output: { answer: 'ok' } };
  }),
}));

describe('cloud transcription', () => {
  it('carries punctuation from segments onto word times, so reels can cut on sentence ends', () => {
    const words = punctuate({
      segments: [{ start: 0, end: 3, text: 'Sterile water, always. Never tap water.' }],
      words: [
        { word: 'Sterile', start: 0, end: 0.4 }, { word: 'water', start: 0.4, end: 0.8 }, { word: 'always', start: 0.8, end: 1.2 },
        { word: 'Never', start: 1.5, end: 1.8 }, { word: 'tap', start: 1.8, end: 2 }, { word: 'water', start: 2, end: 2.4 },
      ],
    });
    expect(words.map((w) => w.word)).toEqual(['Sterile', 'water,', 'always.', 'Never', 'tap', 'water.']);
  });

  it('cuts long recordings into ~20-minute pieces at quiet moments', () => {
    const pieces = planPieces(6000, [1150, 1210, 2450, 3600, 4800]);
    expect(pieces[0]).toEqual([0, 1210]);
    expect(pieces.every(([a, b]) => b - a <= 1400)).toBe(true);
    expect(pieces[pieces.length - 1][1]).toBe(6000);
  });

  it('prices transcription by the minute and narration by the characters spoken', () => {
    expect(quantityCost('whisper-1', 3600, 'second')).toBeCloseTo(0.36);
    expect(quantityCost('gpt-4o-mini-tts', 9000, 'character')).toBeCloseTo(0.15);
    const month = summarize([
      { id: '1', createdAt: Date.now(), kind: 'asr', source: 'sensei:transcribe:x', providerId: 'openai', modelId: 'whisper-1', modelString: '', inputTokens: 0, outputTokens: 0, quantity: 600, unit: 'second' } as never,
    ]);
    expect(month.total).toBeCloseTo(0.06);
    expect(month.byPurpose[0].purpose).toBe('transcribe');
  });
});

describe('the standing brief', () => {
  it('is prepended to every task, without breaking the answer cache across days', async () => {
    const { mkdtemp } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { senseiLlm } = await import('@/lib/sensei/llm');
    const home = await mkdtemp(join(tmpdir(), 'sensei-brief-'));
    const config = {
      home, libraryDir: home, cacheDir: join(home, 'cache'), inboxDir: home, databaseUrl: '', claudeBin: '/nonexistent',
      googleApiKey: 'g', openaiApiKey: undefined, fastModel: 'google:gemini-3.8-flash', strongModel: 'google:gemini-3.1-pro-preview', audioModel: 'google:x',
    };
    const schema = z.object({ answer: z.string() });
    await senseiLlm(config, undefined, async () => `${SENSEI_BRIEF}\n\nToday is 2026-09-25.`).call({ schema, system: 'Make cards.', prompt: 'p', tier: 'strong' });
    expect(seen[0].system.startsWith('You are part of Sensei')).toBe(true);
    expect(seen[0].system).toContain('Your task:\nMake cards.');
    // Next day, same task: served from the cache (no new call).
    await senseiLlm(config, undefined, async () => `${SENSEI_BRIEF}\n\nToday is 2026-09-26.`).call({ schema, system: 'Make cards.', prompt: 'p', tier: 'strong' });
    expect(seen).toHaveLength(1);
  });

  it('knows where the student is in the course', async () => {
    const { testDb } = await import('./helpers');
    const db = await testDb();
    try {
      const { rows } = await db.query<{ id: string }>(`INSERT INTO sensei_course (code, title) VALUES ('RESP 101A', 'RC1') RETURNING id`);
      await db.query(`INSERT INTO sensei_module (course_id, number, title, start_date, end_date) VALUES
        ($1, 1, 'Gases', '2026-09-01', '2026-09-23'), ($1, 2, 'Assessment', '2026-09-24', '2026-11-08')`, [rows[0].id]);
      const s = await courseSnapshot(db, new Date('2026-09-25T12:00:00Z'));
      expect(s).toContain('Current: RESP 101A Module 2, Assessment');
      expect(s).toContain('Finished: Module 1 (Gases)');
    } finally {
      await db.close();
    }
  });
});

describe('lessons on request and the audio setting', () => {
  it('queues one lesson job per lecture and defaults audio to this Mac', async () => {
    const { testDb } = await import('./helpers');
    const { requestLesson } = await import('@/lib/sensei/jobs');
    const { getSettings, setSetting } = await import('@/lib/sensei/settings');
    const { ensureCourse, ensureLecture } = await import('@/lib/sensei/store');
    const db = await testDb();
    try {
      const course = await ensureCourse(db, 'RESP 101A', 'RC1');
      const lectureId = await ensureLecture(db, { courseId: course, date: '2026-09-17', title: 'Medical gases', kind: 'deck' });
      const a = await requestLesson(db, lectureId);
      const b = await requestLesson(db, lectureId);
      expect(a?.jobId).toBeTruthy();
      expect(b?.jobId).toBe(a?.jobId); // no duplicate while one is waiting
      const { rows } = await db.query<{ input: { lessonFor: string; files: string[] } }>('SELECT input FROM sensei_job');
      expect(rows[0].input).toMatchObject({ lessonFor: lectureId, files: [] });
      expect(await requestLesson(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
      expect((await getSettings(db)).audioEngine).toBe('local');
      await setSetting(db, 'audioEngine', 'cloud');
      expect((await getSettings(db)).audioEngine).toBe('cloud');
    } finally {
      await db.close();
    }
  });
});

describe('lesson voice setting', () => {
  it('defaults to the Mac voice and maps both voice settings to files the voice service reads', async () => {
    const { SETTING_DEFAULTS, VOICE_SETTING_FILES } = await import('@/lib/sensei/settings');
    expect(SETTING_DEFAULTS.lessonVoice).toBe('kokoro');
    expect(VOICE_SETTING_FILES).toEqual({ audioEngine: 'audio-engine', lessonVoice: 'lesson-voice' });
  });
});
