/**
 * Structured model calls for the pipeline. The pipeline depends only on the
 * `StructuredLlm` type, so tests inject a fake and providers can be swapped.
 * Responses are cached on disk by (model, prompt, schema) hash: re-running a
 * lecture after a crash or a code change never re-pays for identical calls,
 * and cached raw outputs can be replayed after a schema change (DECISIONS O1).
 */
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { Output } from 'ai';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
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
  /** claude = your Claude subscription, through the Claude Code CLI on this Mac. */
  provider: 'google' | 'openai' | 'claude';
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
      if (provider !== 'google' && provider !== 'openai' && provider !== 'claude') throw new Error(`Unknown model provider "${provider}" in "${s}"`);
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

const PROVIDER_NAMES: Record<ModelRoute['provider'], string> = { google: 'Gemini', openai: 'OpenAI', claude: 'Your Claude subscription' };

/** JSON Schema for the CLI, without the draft tag it doesn't resolve. */
function cliSchema(schema: z.ZodType): object {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * One structured call through the Claude Code CLI, which bills your Claude plan
 * instead of an API key. Runs lean: no tools, no settings, hooks, plugins or MCP
 * servers, and no saved session, so each call carries ~1k tokens of overhead.
 * Hitting the plan's usage limit reads as "provider unavailable" (falls through).
 */
export function claudeSubscriptionCall<T>(bin: string, model: string, req: StructuredCall<T>, timeoutMs = 15 * 60_000): Promise<unknown> {
  const args = [
    '-p', '--output-format', 'json', '--model', model, '--tools', '', '--no-session-persistence',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--system-prompt', req.system, '--json-schema', JSON.stringify(cliSchema(req.schema)),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let d: { is_error?: boolean; result?: string; structured_output?: unknown } | null = null;
      try {
        d = JSON.parse(out);
      } catch {
        // not JSON: report what the CLI said
      }
      const message = String(d?.result ?? err ?? '').trim() || `claude exited with code ${code}`;
      if (!d || d.is_error || d.structured_output === undefined) {
        const limited = /usage limit|limit reached|rate limit|out of (extra )?usage|credit|quota|not logged in|login|authenticat/i.test(message);
        reject(Object.assign(new Error(`Claude subscription: ${message.slice(0, 200)}`), limited ? { statusCode: 429, message: `no credits: ${message.slice(0, 200)}` } : {}));
        return;
      }
      resolve(d.structured_output);
    });
    child.stdin.end(req.prompt);
  });
}

export function senseiLlm(config = senseiConfig(), notify?: (message: string) => void): StructuredLlm {
  const spec = (tier: ModelTier) => (tier === 'fast' ? config.fastModel : tier === 'audio' ? config.audioModel : config.strongModel);
  const routesFor = (tier: ModelTier) => parseRoutes(spec(tier));
  const keyFor = (p: ModelRoute['provider']) =>
    p === 'openai' ? config.openaiApiKey : p === 'claude' ? (existsSync(config.claudeBin) ? 'subscription' : undefined) : config.googleApiKey;
  const cacheModel = (r: ModelRoute) => (r.provider === 'claude' ? `claude-cli:${r.model}` : r.model);
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
          return req.schema.parse(JSON.parse(await readFile(join(config.cacheDir, `${cacheKey(cacheModel(r), req)}.json`), 'utf8')).output);
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
        if (req.file && r.provider !== 'google') continue; // audio and PDFs go to Gemini
        try {
          if (r.provider === 'claude') {
            const output = req.schema.parse(await claudeSubscriptionCall(config.claudeBin, r.model, req));
            await mkdir(config.cacheDir, { recursive: true });
            await writeFile(join(config.cacheDir, `${cacheKey(cacheModel(r), req)}.json`), JSON.stringify({ model: cacheModel(r), at: new Date().toISOString(), output }));
            return output;
          }
          const model = r.provider === 'openai' ? createOpenAI({ apiKey: key })(r.model) : createGoogleGenerativeAI({ apiKey: key })(r.model);
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
          // The subscription is best effort: any failure there falls through to the paid API.
          if (isLast || (r.provider !== 'claude' && !isProviderUnavailable(e))) throw e;
          lastError = e;
          if (r.provider === 'claude' && !isProviderUnavailable(e)) continue;
          if ((unavailableUntil.get(r.provider) ?? 0) < Date.now()) {
            notify?.(`${PROVIDER_NAMES[r.provider]} is unavailable (${String((e as Error).message).slice(0, 80)}); using ${routes[i + 1].model} instead.`);
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
