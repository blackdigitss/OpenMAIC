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
        googleApiKey: 'g', openaiApiKey: 'o', claudeBin: '/nonexistent/claude',
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

describe('Claude subscription route', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sensei-claude-'));
    calls.length = 0;
  });
  afterEach(() => vi.resetModules());

  async function fakeClaude(body: string) {
    const { writeFile, chmod } = await import('fs/promises');
    const bin = join(home, 'claude');
    await writeFile(bin, `#!/bin/sh\ncat > /dev/null\ncat <<'JSON'\n${body}\nJSON\n`);
    await chmod(bin, 0o755);
    return bin;
  }
  const config = (claudeBin: string) => ({
    home, libraryDir: home, cacheDir: join(home, 'cache'), inboxDir: home, databaseUrl: '',
    googleApiKey: 'g', openaiApiKey: undefined, claudeBin,
    fastModel: 'google:gemini-3.8-flash', strongModel: 'claude:opus,google:gemini-3.1-pro-preview', audioModel: 'google:gemini-3.1-pro-preview',
  });
  const schema = z.object({ answer: z.string() });

  it('answers through the subscription without calling any API', async () => {
    const { senseiLlm } = await import('@/lib/sensei/llm');
    const bin = await fakeClaude('{"is_error":false,"structured_output":{"answer":"from claude"}}');
    expect(await senseiLlm(config(bin)).call({ schema, system: 's', prompt: 'p', tier: 'strong' })).toEqual({ answer: 'from claude' });
    expect(calls).toEqual([]);
  });

  it('falls through to Gemini when the plan limit is hit, and says so once', async () => {
    const { senseiLlm } = await import('@/lib/sensei/llm');
    const bin = await fakeClaude('{"is_error":true,"result":"Claude AI usage limit reached|1790300000"}');
    const notices: string[] = [];
    const llm = senseiLlm(config(bin), (m) => notices.push(m));
    expect(await llm.call({ schema, system: 's', prompt: 'a', tier: 'strong' })).toEqual({ answer: 'ok' });
    expect(await llm.call({ schema, system: 's', prompt: 'b', tier: 'strong' })).toEqual({ answer: 'ok' });
    expect(calls).toEqual(['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview']);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/Claude subscription/);
  });

  it('audio never goes to the subscription', async () => {
    const { senseiLlm } = await import('@/lib/sensei/llm');
    const bin = await fakeClaude('{"is_error":false,"structured_output":{"answer":"wrong"}}');
    const out = await senseiLlm({ ...config(bin), audioModel: 'claude:opus,google:gemini-3.1-pro-preview' }).call({
      schema, system: 's', prompt: 'p', tier: 'audio', file: { data: Buffer.from('x'), mediaType: 'audio/mpeg' },
    });
    expect(out).toEqual({ answer: 'ok' });
  });
});

describe('titles from file names', () => {
  it('drops upload prefixes, separators and housekeeping words; library hashes are not titles', async () => {
    const { titleFromFile } = await import('@/lib/sensei/ingest');
    expect(titleFromFile('/s/1790298173835-Storage and Delivery of Medical Gases - Tagged.pdf')).toBe('Storage and Delivery of Medical Gases');
    expect(titleFromFile('Vital_Signs-Final (1).pdf')).toBe('Vital Signs');
    expect(titleFromFile('/lib/f003bc5dda9d317ef213e190103644b5b78c5c73e7e97dee341a0061041d22d6.pdf')).toBeNull();
  });
});

describe('running out of AI credits', () => {
  it('recognizes billing refusals, and retries only those jobs after 30 minutes', async () => {
    const { isBillingError, retryBillingFailures } = await import('@/lib/sensei/jobs');
    expect(isBillingError('Your prepayment credits are depleted. Please go to AI Studio')).toBe(true);
    expect(isBillingError('You exceeded your current quota')).toBe(true);
    expect(isBillingError('Transcript timestamps overlap')).toBe(false);
    const { testDb } = await import('./helpers');
    const db = await testDb();
    try {
      await db.query(`INSERT INTO sensei_job (status, input, detail, updated_at) VALUES
        ('failed', '{"files":[]}', 'Waiting for AI credits (resumes on its own)', now() - interval '31 minutes'),
        ('failed', '{"files":[]}', 'Waiting for AI credits (resumes on its own)', now()),
        ('failed', '{"files":[]}', 'Something went wrong', now() - interval '2 hours')`);
      expect(await retryBillingFailures(db)).toBe(1);
      const { rows } = await db.query<{ status: string }>(`SELECT status FROM sensei_job ORDER BY status`);
      expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'queued']);
    } finally {
      await db.close();
    }
  });
});
