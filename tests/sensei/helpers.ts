import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { senseiConfig } from '@/lib/sensei/config';
import { runMigrations } from '@/lib/sensei/db/migrations';
import type { Db } from '@/lib/sensei/db/types';
import type { Extraction } from '@/lib/sensei/extract';
import type { StructuredCall, StructuredLlm } from '@/lib/sensei/llm';

export async function testDb(): Promise<Db & { close(): Promise<void> }> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const db = {
    query: <T>(text: string, params?: unknown[]) => pg.query<T>(text, params) as Promise<{ rows: T[] }>,
    close: () => pg.close(),
  };
  await runMigrations(db);
  return db;
}

export async function testConfig() {
  const home = await mkdtemp(join(tmpdir(), 'sensei-'));
  return { ...senseiConfig({ SENSEI_HOME: home } as unknown as NodeJS.ProcessEnv), googleApiKey: undefined };
}

export async function writeFixture(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sensei-fx-'));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

/** Scripted model: each call pops the next response (or builds it from the prompt). */
export function fakeLlm(responses: (Extraction | ((prompt: string) => Extraction) | Error)[]): StructuredLlm & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    modelName: () => 'fake-model',
    async call<T>(req: StructuredCall<T>): Promise<T> {
      prompts.push(req.prompt);
      const next = responses.shift();
      if (!next) throw new Error('fakeLlm: no scripted response left');
      if (next instanceof Error) throw next;
      const out = typeof next === 'function' ? next(req.prompt) : next;
      return req.schema.parse(out);
    },
  };
}

type Rec = Extraction['records'][number];
export function rec(partial: Partial<Rec> & Pick<Rec, 'concept_name' | 'statement' | 'evidence'>): Rec {
  return {
    concept_ref: null,
    concept_aliases: [],
    concept_kind: 'term',
    concept_short_definition: null,
    type: 'definition',
    context: null,
    existing_record_ref: null,
    existing_record_relation: null,
    ...partial,
  };
}

/** Find the ref ("C3" / "R2") the prompt assigned to a concept name or record statement. */
export function refFor(prompt: string, text: string): string {
  const line = prompt.split('\n').find((l) => l.includes(text) && /\b[CR]\d+:/.test(l));
  const m = line && /\b([CR]\d+):/.exec(line);
  if (!m) throw new Error(`No ref for "${text}" in prompt`);
  return m[1];
}
