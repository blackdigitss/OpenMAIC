import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '@/lib/sensei/db/types';
import { dueCards } from '@/lib/sensei/learn';
import type { StructuredCall, StructuredLlm } from '@/lib/sensei/llm';
import { importPracticeQuestions } from '@/lib/sensei/practice';
import { ensureCourse, ensureLecture, resolveConcept, upsertRecord } from '@/lib/sensei/store';

import { testDb } from './helpers';

let db: Db & { close(): Promise<void> };
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.close();
});

async function guidePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('1. What is the E cylinder factor? A. 0.28 B. 3.14 Answer: A', { x: 30, y: 700, font, size: 10 });
  const path = join(await mkdtemp(join(tmpdir(), 'sensei-practice-')), 'guide.pdf');
  await writeFile(path, await doc.save());
  return path;
}

describe('practice question import', () => {
  it('attaches questions to concepts, holds back answers that conflict with class, and is idempotent', async () => {
    const course = await ensureCourse(db, 'RESP 101A', 'RC1');
    const lectureId = await ensureLecture(db, { courseId: course, date: '2026-09-17', title: 'Gases' });
    const e = await resolveConcept(db, { name: 'E cylinder' });
    await upsertRecord(db, { conceptId: e.id, type: 'formula', statement: 'The E cylinder factor is 0.28 L/psi.', verification: 'fidelity_ok', lectureId });
    const questions = [
      { question: 'What is the E cylinder factor?', options: ['0.28 L/psi', '3.14 L/psi', '1.56 L/psi', '0.16 L/psi'], answerIndex: 0, explanation: 'E = 0.28.' },
      { question: 'What is the E cylinder factor in liters per psi?', options: ['0.28', '3.14'], answerIndex: 1, explanation: 'Wrong key.' },
      { question: 'What does HIPAA protect?', options: ['Privacy', 'Parking'], answerIndex: 0, explanation: 'Health privacy.' },
    ];
    const llm: StructuredLlm = {
      modelName: () => 'fake',
      async call<T>(req: StructuredCall<T>): Promise<T> {
        if (req.prompt.startsWith('<guide>')) return req.schema.parse({ questions });
        if (req.prompt.includes('1. What is the E cylinder factor?')) expect(req.prompt).toContain('The E cylinder factor is 0.28 L/psi.');
        return req.schema.parse({
          matches: [
            { n: 1, concept: 'E cylinder', verdict: 'agrees', note: null },
            { n: 2, concept: 'E cylinder', verdict: 'conflicts', note: 'Class taught 0.28 L/psi, not 3.14.' },
            { n: 3, concept: null, verdict: 'not_covered', note: null },
          ],
        });
      },
    };
    const path = await guidePdf();
    expect(await importPracticeQuestions(db, llm, path, 'Module 1 practice guide')).toEqual({ found: 3, added: 1, alreadyHad: 0, unmatched: 1, heldForConflict: 1 });
    const due = await dueCards(db);
    expect(due).toHaveLength(1);
    expect(due[0].payload).toMatchObject({ kind: 'mcq', answer: 0, source: 'Module 1 practice guide' });
    // Re-running adds nothing new; the unmatched one gets another chance.
    expect(await importPracticeQuestions(db, llm, path, 'Module 1 practice guide')).toMatchObject({ found: 3, alreadyHad: 2 });
  });
});
