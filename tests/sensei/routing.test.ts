import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { dateFromFilename } from '@/lib/sensei/jobs';
import { isProviderUnavailable, parseRoutes } from '@/lib/sensei/llm';

const calls: string[] = [];
vi.mock('@/lib/ai/llm', () => ({
  callLLM: vi.fn(async (opts: { model: { provider: string; modelId: string } }) => {
    calls.push(opts.model.modelId);
    if (opts.model.provider.startsWith('openai')) {
      throw Object.assign(new Error('You have no credits remaining. Add credits to continue using the API.'), { statusCode: 429 });
    }
    return { output: { answer: 'ok' } };
  }),
}));

describe('file-name dates', () => {
  const now = new Date(2026, 8, 24, 21, 0);
  it('reads month-day from recording and slide names, ignoring the staging prefix', () => {
    expect(dateFromFilename('/s/1790297356711-Resp. Lab 9-21.m4a', now)).toBe('2026-09-21');
    expect(dateFromFilename('Resp. Lec 9-24.m4a', now)).toBe('2026-09-24');
    expect(dateFromFilename('Vital Signs 9.24.26.pdf', now)).toBe('2026-09-24');
    expect(dateFromFilename('Cleaned_RT_Lecture_9-16-26.docx', now)).toBe('2026-09-16');
  });
  it('ignores names without a real date and treats far-future dates as last year', () => {
    expect(dateFromFilename('Storage and Delivery of Medical Gases - Tagged.pdf', now)).toBeNull();
    expect(dateFromFilename('Module 1 13-45.pdf', now)).toBeNull();
    expect(dateFromFilename('Review 12-10.m4a', now)).toBe('2025-12-10');
  });
});

describe('model routes', () => {
  it('parses provider:model lists; bare ids are Gemini', () => {
    expect(parseRoutes('openai:gpt-5.6-sol, google:gemini-3.1-pro-preview')).toEqual([
      { provider: 'openai', model: 'gpt-5.6-sol' },
      { provider: 'google', model: 'gemini-3.1-pro-preview' },
    ]);
    expect(parseRoutes('gemini-3.8-flash')).toEqual([{ provider: 'google', model: 'gemini-3.8-flash' }]);
    expect(() => parseRoutes('acme:x')).toThrow();
  });
  it('treats no credits / bad key as "provider unavailable", not a bad request', () => {
    expect(isProviderUnavailable(Object.assign(new Error('You have no credits remaining'), { statusCode: 429 }))).toBe(true);
    expect(isProviderUnavailable({ lastError: { statusCode: 401, message: 'Incorrect API key' } })).toBe(true);
    expect(isProviderUnavailable(Object.assign(new Error('Rate limit reached, slow down'), { statusCode: 429 }))).toBe(false);
    expect(isProviderUnavailable(new Error('Invalid schema'))).toBe(false);
  });
});

describe('fallback between providers', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sensei-route-'));
    calls.length = 0;
  });
  afterEach(() => vi.resetModules());

  it('uses Gemini when OpenAI is out of credits, says so once, and stops trying OpenAI for a while', async () => {
    const { senseiLlm } = await import('@/lib/sensei/llm');
    const notices: string[] = [];
    const llm = senseiLlm(
      {
        home, libraryDir: home, cacheDir: join(home, 'cache'), inboxDir: home, databaseUrl: '',
        googleApiKey: 'g', openaiApiKey: 'o',
        fastModel: 'google:gemini-3.8-flash', strongModel: 'openai:gpt-5.6-sol,google:gemini-3.1-pro-preview', audioModel: 'google:gemini-3.1-pro-preview',
      },
      (m) => notices.push(m),
    );
    const schema = z.object({ answer: z.string() });
    expect(await llm.call({ schema, system: 's', prompt: 'one', tier: 'strong' })).toEqual({ answer: 'ok' });
    expect(await llm.call({ schema, system: 's', prompt: 'two', tier: 'strong' })).toEqual({ answer: 'ok' });
    expect(calls).toEqual(['gpt-5.6-sol', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview']);
    expect(notices).toHaveLength(1);
    expect(llm.modelName('strong')).toBe('gemini-3.1-pro-preview');
    // Cached: no new call.
    await llm.call({ schema, system: 's', prompt: 'two', tier: 'strong' });
    expect(calls).toHaveLength(3);
  });
});
