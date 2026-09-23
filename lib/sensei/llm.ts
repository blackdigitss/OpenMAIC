/**
 * Structured model calls for the pipeline. The pipeline depends only on the
 * `StructuredLlm` type, so tests inject a fake and providers can be swapped.
 * Responses are cached on disk by (model, prompt, schema) hash: re-running a
 * lecture after a crash or a code change never re-pays for identical calls,
 * and cached raw outputs can be replayed after a schema change (DECISIONS O1).
 */
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, Output } from 'ai';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';

import { senseiConfig } from './config';
import { sha256 } from './store';

export type ModelTier = 'fast' | 'strong';

export interface StructuredCall<T> {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  tier: ModelTier;
  /** Optional binary part (e.g. an audio chunk) sent alongside the prompt. */
  file?: { data: Buffer; mediaType: string };
}

export interface StructuredLlm {
  modelName(tier: ModelTier): string;
  call<T>(req: StructuredCall<T>): Promise<T>;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('No Gemini API key: set GOOGLE_API_KEY (or SENSEI_GOOGLE_API_KEY) in .env.local');
  }
}

export function geminiLlm(config = senseiConfig()): StructuredLlm {
  const modelName = (tier: ModelTier) => (tier === 'fast' ? config.fastModel : config.strongModel);
  return {
    modelName,
    async call<T>(req: StructuredCall<T>): Promise<T> {
      const model = modelName(req.tier);
      const key = sha256(
        [model, req.system, req.prompt, JSON.stringify(z.toJSONSchema(req.schema)), req.file ? sha256(req.file.data) : ''].join('\n\u0000'),
      );
      const cachePath = join(config.cacheDir, `${key}.json`);
      try {
        return req.schema.parse(JSON.parse(await readFile(cachePath, 'utf8')).output);
      } catch {
        // cache miss or stale schema → call the model
      }
      if (!config.googleApiKey) throw new MissingApiKeyError();
      const google = createGoogleGenerativeAI({ apiKey: config.googleApiKey });
      const result = await generateText({
        model: google(model),
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
      });
      const output = req.schema.parse(result.output);
      await mkdir(config.cacheDir, { recursive: true });
      await writeFile(cachePath, JSON.stringify({ model, at: new Date().toISOString(), output }));
      return output;
    },
  };
}
