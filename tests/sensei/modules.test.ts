import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '@/lib/sensei/db/types';
import { dueCards } from '@/lib/sensei/learn';
import { conceptScope } from '@/lib/sensei/queries';
import { ensureCourse, ensureLecture, insertUnits, registerSource, resolveConcept, sha256, startRun, upsertRecord, addEvidence } from '@/lib/sensei/store';

import { testDb } from './helpers';

let db: Db & { close(): Promise<void> };
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.close();
});

/** A concept taught in a lecture on `date`, with one due card. */
async function taught(courseId: string, name: string, date: string, durability: 'core' | 'module') {
  const lectureId = await ensureLecture(db, { courseId, date, title: `${name} ${date}` });
  const src = await registerSource(db, { sha256: sha256(name + date), kind: 'transcript', courseId, title: 't', originalName: 't', storedPath: '/x' });
  const [unit] = await insertUnits(db, src.id, [{ kind: 'segment', ordinal: 1, text: `${name} was taught` }]);
  const concept = await resolveConcept(db, { name });
  await db.query(`UPDATE sensei_concept SET durability = $2, durability_by = 'model' WHERE id = $1`, [concept.id, durability]);
  const run = await startRun(db, lectureId, 'v', 'm');
  const rec = await upsertRecord(db, { conceptId: concept.id, type: 'definition', statement: `${name} fact ${date}`, verification: 'fidelity_ok', lectureId });
  await addEvidence(db, { recordId: rec.id, unitId: unit.id, lectureId, runId: run, quote: name });
  await db.query(
    `INSERT INTO sensei_card (concept_id, competency, content_key, front, back, due) VALUES ($1, 'recall', $2, 'q', 'a', now() - interval '1 day')
     ON CONFLICT DO NOTHING`,
    [concept.id, sha256(name)],
  );
  return concept.id;
}

describe('modules', () => {
  it('retires module-only details after the module ends; core and returning concepts stay', async () => {
    const course = await ensureCourse(db, 'RESP 101A', 'Respiratory Care 1');
    await db.query(
      `INSERT INTO sensei_module (course_id, number, title, start_date, end_date) VALUES
         ($1, 1, 'Gases', current_date - 60, current_date - 30), ($1, 2, 'Physiology', current_date - 29, current_date + 5)`,
      [course],
    );
    const distillation = await taught(course, 'Fractional distillation', dateAgo(40), 'module');
    const cylinder = await taught(course, 'E cylinder duration', dateAgo(40), 'core');
    const bulk = await taught(course, 'Bulk oxygen storage', dateAgo(40), 'module');
    await taught(course, 'Bulk oxygen storage', dateAgo(10), 'module'); // came back in module 2

    expect((await conceptScope(db, distillation)).retired).toBe(true);
    expect((await conceptScope(db, cylinder)).durability).toBe('core');
    expect(await conceptScope(db, bulk)).toMatchObject({ durability: 'core', retired: false });

    const due = (await dueCards(db)).map((c) => c.conceptName);
    expect(due).not.toContain('Fractional distillation');
    expect(due).toEqual(expect.arrayContaining(['E cylinder duration', 'Bulk oxygen storage']));

    // The student can always bring a retired detail back.
    await db.query(`UPDATE sensei_concept SET durability = 'core', durability_by = 'user' WHERE id = $1`, [distillation]);
    expect((await dueCards(db)).map((c) => c.conceptName)).toContain('Fractional distillation');
  });
});

function dateAgo(n: number) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}
