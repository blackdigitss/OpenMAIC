import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '@/lib/sensei/db/types';
import { fillGap, thinConcepts } from '@/lib/sensei/gaps';
import type { StructuredCall, StructuredLlm } from '@/lib/sensei/llm';
import { conceptDetail, textbookPassages } from '@/lib/sensei/queries';
import { addEvidence, ensureCourse, ensureLecture, insertUnits, registerSource, resolveConcept, sha256, startRun, upsertRecord } from '@/lib/sensei/store';

import { testDb } from './helpers';

let db: Db & { close(): Promise<void> };
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.close();
});

async function seed() {
  const course = await ensureCourse(db, 'RESP 101A', 'RC1');
  const lectureId = await ensureLecture(db, { courseId: course, date: '2026-09-15', title: 'Gases', kind: 'deck' });
  const deck = await registerSource(db, { sha256: sha256('deck'), kind: 'slides', courseId: course, title: 'deck', originalName: 'd', storedPath: '/d' });
  const [slide] = await insertUnits(db, deck.id, [{ kind: 'page', ordinal: 1, pageNo: 1, text: 'Bourdon gauge: flow meter that measures pressure' }]);
  const concept = await resolveConcept(db, { name: 'Bourdon gauge' });
  const run = await startRun(db, lectureId, 'v', 'm');
  const rec = await upsertRecord(db, { conceptId: concept.id, type: 'detail', statement: 'A Bourdon gauge is a flowmeter.', verification: 'fidelity_ok', lectureId });
  await addEvidence(db, { recordId: rec.id, unitId: slide.id, lectureId, runId: run, quote: 'Bourdon gauge' });
  const book = await registerSource(db, { sha256: sha256('book'), kind: 'textbook', courseId: null, title: 'Egan’s', originalName: 'e.pdf', storedPath: '/e' });
  const units = await insertUnits(db, book.id, [
    { kind: 'page', ordinal: 1, pageNo: 987, text: `${'The Bourdon gauge is a fixed-orifice pressure gauge calibrated in L/min; it reads pressure, not flow, so an obstruction downstream makes it read falsely high. '.repeat(3)}\n886 SECTION V Basic Therapeutics` },
    { kind: 'page', ordinal: 2, pageNo: 988, text: 'Bourdon gauge figure' }, // too short: excluded
  ]);
  await db.query(`UPDATE sensei_source_unit SET printed_page = '886' WHERE id = $1`, [units[0].id]);
  return { lectureId, conceptId: concept.id };
}

function llmReturning(out: unknown): StructuredLlm & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    modelName: () => 'fake',
    async call<T>(req: StructuredCall<T>): Promise<T> {
      prompts.push(req.prompt);
      return req.schema.parse(out);
    },
  };
}

describe('textbook gap filling', () => {
  it('finds thin concepts, writes a cited note from the book only, and flags disagreement', async () => {
    const { lectureId, conceptId } = await seed();
    const thin = await thinConcepts(db, lectureId);
    expect(thin.map((c) => c.name)).toEqual(['Bourdon gauge']);

    const passages = await textbookPassages(db, ['Bourdon gauge'], 3);
    expect(passages).toHaveLength(1); // near-empty figure page skipped
    expect(passages[0].cite).toBe('p. 886');

    const llm = llmReturning({
      adds: 'It is a pressure gauge calibrated in L/min, so a downstream obstruction makes it read high [T1].',
      refs: ['T1'],
      disagreement: 'Your slides call it a flowmeter; the textbook says it measures pressure, not flow.',
    });
    expect(await fillGap(db, llm, thin[0])).toBe(true);
    expect(llm.prompts[0]).toContain('p. 886');
    const detail = await conceptDetail(db, conceptId);
    expect(detail?.gap?.adds).toBe('It is a pressure gauge calibrated in L/min, so a downstream obstruction makes it read high.');
    expect(detail?.gap?.citations).toEqual([{ book: 'Egan’s', cite: 'p. 886' }]);
    expect(detail?.gap?.disagreement).toMatch(/flowmeter/);
    // The course fact is untouched.
    expect(detail?.records.map((r) => r.statement)).toEqual(['A Bourdon gauge is a flowmeter.']);
    expect(await thinConcepts(db, lectureId)).toEqual([]); // cached
  });
});
