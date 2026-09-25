/**
 * Structured model calls for the pipeline. The pipeline depends only on the
 * `StructuredLlm` type, so tests inject a fake and providers can be swapped.
 * Responses are cached on disk by (model, prompt, schema) hash: re-running a
 * lecture after a crash or a code change never re-pays for identical calls,
 * and cached raw outputs can be replayed after a schema change (DECISIONS O1).
 */
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { Output } from 'ai';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';

import { callLLM } from '@/lib/ai/llm';

import { senseiConfig } from './config';
import { sha256 } from './store';

export type ModelTier = 'fast' | 'strong' | 'audio';

export interface StructuredCall<T> {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  tier: ModelTier;
  /** Optional binary part (e.g. an audio chunk) sent alongside the prompt. */
  file?: { data: Buffer; mediaType: string };
  /** What this call is for (budget breakdown), e.g. 'transcribe', 'extract', 'cards'. */
  purpose?: string;
  lectureId?: string;
}

export interface StructuredLlm {
  modelName(tier: ModelTier): string;
  call<T>(req: StructuredCall<T>): Promise<T>;
}

export class MissingApiKeyError extends Error {
  constructor(provider = 'google') {
    super(
      provider === 'openai'
        ? 'No OpenAI API key: set OPENAI_API_KEY in sensei.env'
        : 'No Gemini API key: set GOOGLE_API_KEY (or SENSEI_GOOGLE_API_KEY) in .env.local',
    );
  }
}

export interface ModelRoute {
  provider: 'google' | 'openai';
  model: string;
}

/** "openai:gpt-5.6-sol, google:gemini-3.1-pro-preview" → routes in preference order (bare ids are Google). */
export function parseRoutes(spec: string): ModelRoute[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      const provider = i > 0 ? s.slice(0, i) : 'google';
      if (provider !== 'google' && provider !== 'openai') throw new Error(`Unknown model provider "${provider}" in "${s}"`);
      return { provider, model: i > 0 ? s.slice(i + 1) : s };
    });
}

/**
 * Errors that mean "this provider can't serve us right now" (no credits, bad key, no
 * access to the model), as opposed to a problem with the request. Those fall through
 * to the next route; anything else is a real error.
 */
export function isProviderUnavailable(e: unknown): boolean {
  const err = e as { statusCode?: number; message?: string; lastError?: unknown; errors?: unknown[] };
  if (err?.lastError && isProviderUnavailable(err.lastError)) return true;
  const msg = String(err?.message ?? '');
  if (err?.statusCode === 401 || err?.statusCode === 403 || err?.statusCode === 404) return true;
  return /insufficient_quota|no credits|credit balance|billing|exceeded your current quota|API key not valid|incorrect api key|does not exist or you do not have access/i.test(
    msg,
  );
}

/** Providers that just failed that way are skipped for a while instead of being retried on every call. */
const unavailableUntil = new Map<string, number>();
const SKIP_MS = 30 * 60_000;

export function senseiLlm(config = senseiConfig(), notify?: (message: string) => void): StructuredLlm {
  const spec = (tier: ModelTier) => (tier === 'fast' ? config.fastModel : tier === 'audio' ? config.audioModel : config.strongModel);
  const routesFor = (tier: ModelTier) => parseRoutes(spec(tier));
  const keyFor = (p: ModelRoute['provider']) => (p === 'openai' ? config.openaiApiKey : config.googleApiKey);
  const cacheKey = (model: string, req: StructuredCall<unknown>) =>
    sha256(
      [model, req.system, req.prompt, JSON.stringify(z.toJSONSchema(req.schema)), req.file ? sha256(req.file.data) : ''].join('\n\u0000'),
    );
  return {
    /** The model this tier will use now (first available route). */
    modelName(tier) {
      const routes = routesFor(tier);
      const live = routes.find((r) => keyFor(r.provider) && (unavailableUntil.get(r.provider) ?? 0) < Date.now()) ?? routes[0];
      return live.model;
    },
    async call<T>(req: StructuredCall<T>): Promise<T> {
      const routes = routesFor(req.tier);
      // A cached answer from any route counts: re-runs never re-pay.
      for (const r of routes) {
        try {
          return req.schema.parse(JSON.parse(await readFile(join(config.cacheDir, `${cacheKey(r.model, req)}.json`), 'utf8')).output);
        } catch {
          // miss
        }
      }
      let lastError: unknown = null;
      for (const [i, r] of routes.entries()) {
        const isLast = i === routes.length - 1;
        const key = keyFor(r.provider);
        if (!key || (!isLast && (unavailableUntil.get(r.provider) ?? 0) > Date.now())) {
          lastError ??= new MissingApiKeyError(r.provider);
          continue;
        }
        if (req.file && r.provider !== 'google') continue; // audio goes to Gemini
        const model = r.provider === 'openai' ? createOpenAI({ apiKey: key })(r.model) : createGoogleGenerativeAI({ apiKey: key })(r.model);
        try {
          // Through OpenMAIC's wrapper: usage accounting and the thinking kill switch apply to Sensei too.
          const result = await callLLM(
            {
              model,
              system: req.system,
              maxRetries: 3,
              output: Output.object({ schema: req.schema }),
              ...(req.file
                ? {
                    messages: [
                      {
                        role: 'user' as const,
                        content: [
                          { type: 'file' as const, data: req.file.data, mediaType: req.file.mediaType },
                          { type: 'text' as const, text: req.prompt },
                        ],
                      },
                    ],
                  }
                : { prompt: req.prompt }),
            },
            `sensei:${req.purpose ?? req.tier}${req.lectureId ? `:${req.lectureId}` : ''}`,
          );
          const output = req.schema.parse(result.output);
          await mkdir(config.cacheDir, { recursive: true });
          await writeFile(join(config.cacheDir, `${cacheKey(r.model, req)}.json`), JSON.stringify({ model: r.model, at: new Date().toISOString(), output }));
          return output;
        } catch (e) {
          if (isLast || !isProviderUnavailable(e)) throw e;
          lastError = e;
          if ((unavailableUntil.get(r.provider) ?? 0) < Date.now()) {
            notify?.(`${r.provider === 'openai' ? 'OpenAI' : 'Gemini'} is unavailable (${String((e as Error).message).slice(0, 80)}); using ${routes[i + 1].model} instead.`);
          }
          unavailableUntil.set(r.provider, Date.now() + SKIP_MS);
        }
      }
      throw lastError ?? new MissingApiKeyError();
    },
  };
}

/** @deprecated name kept for existing callers. */
export const geminiLlm = senseiLlm;
