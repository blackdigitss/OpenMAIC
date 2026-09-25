import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '@/lib/sensei/db/types';
import { generateLabDrills } from '@/lib/sensei/drills';
import { dueCards } from '@/lib/sensei/learn';
import type { StructuredCall, StructuredLlm } from '@/lib/sensei/llm';
import { addEvidence, ensureCourse, ensureLecture, insertUnits, registerSource, resolveConcept, sha256, startRun, upsertRecord } from '@/lib/sensei/store';

import { testDb } from './helpers';

let db: Db & { close(): Promise<void> };
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.close();
});

describe('lab drills', () => {
  it('makes step drills and spot-the-error cards only when they cite class facts', async () => {
    const course = await ensureCourse(db, 'RESP 101A', 'RC1');
    const lectureId = await ensureLecture(db, { courseId: course, date: '2026-09-24', title: 'Vital signs lab' });
    const src = await registerSource(db, { sha256: sha256('v'), kind: 'slides', courseId: course, title: 'Vital Signs', originalName: 'v.pdf', storedPath: '/v' });
    const [unit] = await insertUnits(db, src.id, [{ kind: 'page', ordinal: 1, pageNo: 1, text: 'Manual blood pressure steps' }]);
    const bp = await resolveConcept(db, { name: 'Manual blood pressure' });
    const run = await startRun(db, lectureId, 'v', 'm');
    for (const statement of [
      'Choose a cuff whose bladder covers 80% of the arm circumference.',
      'Palpate the brachial artery, then inflate 30 mmHg above where the pulse disappears.',
      'Deflate at 2 to 3 mmHg per second while listening for Korotkoff sounds.',
    ]) {
      const r = await upsertRecord(db, { conceptId: bp.id, type: 'clinical', statement, verification: 'fidelity_ok', lectureId });
      await addEvidence(db, { recordId: r.id, unitId: unit.id, lectureId, runId: run, quote: 'Manual blood pressure steps' });
    }
    const llm: StructuredLlm = {
      modelName: () => 'fake',
      async call<T>(req: StructuredCall<T>): Promise<T> {
        expect(req.prompt).toContain('F1 [Manual blood pressure]');
        return req.schema.parse({
          step_drills: [
            { concept: 'Manual blood pressure', procedure: 'Measure blood pressure manually', steps: ['Choose the right cuff size', 'Palpate the brachial artery', 'Inflate 30 mmHg above pulse loss', 'Deflate 2-3 mmHg per second'], why: 'Order from class.', refs: ['F1', 'F2', 'F3'] },
            { concept: 'Manual blood pressure', procedure: 'Invented procedure', steps: ['a', 'b', 'c'], why: 'x', refs: [] },
          ],
          spot_errors: [
            { concept: 'Manual blood pressure', scenario: 'A student measures BP on a large adult arm.', options: ['Uses a child cuff', 'Palpates first', 'Inflates 30 mmHg above pulse loss', 'Deflates 2-3 mmHg/s'], error_index: 0, why: 'Cuff bladder must cover 80% of the arm.', refs: ['F1'] },
          ],
        });
      },
    };
    expect(await generateLabDrills(db, llm, lectureId)).toEqual({ stepDrills: 1, spotErrors: 1, dropped: 1 });
    const due = await dueCards(db);
    const kinds = due.map((c) => c.payload?.kind).sort();
    expect(kinds).toEqual(['mcq', 'order']);
    // Running again adds nothing new.
    expect(await generateLabDrills(db, llm, lectureId)).toMatchObject({ stepDrills: 0, spotErrors: 0 });
  });
});
