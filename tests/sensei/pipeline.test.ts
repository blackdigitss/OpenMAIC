import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '@/lib/sensei/db/types';
import { ingestFile } from '@/lib/sensei/ingest';
import { processLecture } from '@/lib/sensei/pipeline';

import { fakeLlm, rec, refFor, testConfig, testDb, writeFixture } from './helpers';

const LECTURE_1 = `WEBVTT

00:00:01.000 --> 00:00:20.000
Okay everyone, parking passes are due Friday.

00:00:21.000 --> 00:00:50.000
So FiO2 is the fraction of inspired oxygen. Room air is point two one, twenty one percent.

00:00:51.000 --> 00:01:20.000
We usually start PEEP at five centimeters of water. This will be on the exam.

00:01:21.000 --> 00:01:50.000
I had a patient once, a big guy, whose SpO2 read 99 but his PaO2 was 60 because of carbon monoxide.
`;

const LECTURE_2 = `WEBVTT

00:00:01.000 --> 00:00:30.000
Remember FiO2 from last week? On a nasal cannula, each liter adds about four percent.

00:00:31.000 --> 00:00:59.000
Normal PaO2 is 75 to 100 millimeters of mercury.
`;

let db: Db & { close(): Promise<void> };
let config: Awaited<ReturnType<typeof testConfig>>;

beforeEach(async () => {
  db = await testDb();
  config = await testConfig();
});
afterEach(async () => {
  await db.close();
});

async function ingest(content: string, course: string, date: string, title: string) {
  const path = await writeFixture(`${title}.vtt`, content);
  return ingestFile(db, { path, course: { code: course }, lecture: { date, title } }, config);
}

const lecture1Extraction = {
  records: [
    rec({
      concept_name: 'Fraction of inspired oxygen',
      concept_aliases: ['FiO2'],
      statement: 'FiO2 is the fraction of inspired oxygen; room air FiO2 is 0.21 (21%).',
      evidence: [{ unit_ref: 'U2', quote: 'FiO2 is the fraction of inspired oxygen' }],
    }),
    rec({
      concept_name: 'Positive end-expiratory pressure',
      concept_aliases: ['PEEP'],
      type: 'clinical',
      statement: 'PEEP is usually started at 15 cmH2O.', // wrong number: source says 5
      evidence: [{ unit_ref: 'U3', quote: 'We usually start PEEP at five centimeters of water' }],
    }),
    rec({
      concept_name: 'Positive end-expiratory pressure',
      concept_aliases: ['PEEP'],
      type: 'exam_hint',
      statement: 'Starting PEEP is on the exam.',
      evidence: [{ unit_ref: 'U3', quote: 'This will be on the exam' }],
    }),
    rec({
      concept_name: 'Carbon monoxide poisoning',
      concept_aliases: ['CO poisoning'],
      type: 'anecdote',
      statement: 'A [PATIENT] had SpO2 99 but PaO2 60 due to carbon monoxide.',
      evidence: [{ unit_ref: 'U4', quote: 'whose SpO2 read 99 but his PaO2 was 60 because of carbon monoxide' }],
    }),
    rec({
      concept_name: 'Oxygen toxicity',
      statement: 'High FiO2 causes oxygen toxicity.',
      evidence: [{ unit_ref: 'U2', quote: 'oxygen toxicity is dangerous above sixty percent' }], // invented quote
    }),
  ],
  relations: [
    { from_concept: 'Fraction of inspired oxygen', to_concept: 'Carbon monoxide poisoning', type: 'related_to' as const },
  ],
};

async function signals(name: string) {
  const { rows } = await db.query<{ lecture_count: string; course_count: string; emphasis_count: string }>(
    `SELECT s.* FROM sensei_concept_signals s JOIN sensei_concept c ON c.id = s.concept_id WHERE c.canonical_name = $1`,
    [name],
  );
  return { lectures: Number(rows[0].lecture_count), courses: Number(rows[0].course_count), emphasis: Number(rows[0].emphasis_count) };
}

describe('lecture ingestion', () => {
  it('is idempotent by content hash and keeps timestamps', async () => {
    const a = await ingest(LECTURE_1, 'RESP101', '2026-09-01', 'Oxygen basics');
    const b = await ingest(LECTURE_1, 'RESP101', '2026-09-01', 'Oxygen basics');
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.sourceId).toBe(a.sourceId);
    const { rows } = await db.query<{ start_ms: number; text: string }>(
      `SELECT start_ms, text FROM sensei_source_unit WHERE source_id = $1 ORDER BY ordinal`,
      [a.sourceId],
    );
    expect(rows).toHaveLength(4);
    expect(rows[2].start_ms).toBe(51_000);
    // Chatter is preserved as source evidence even though nothing is extracted from it.
    expect(rows[0].text).toContain('parking passes');
  });
});

describe('concept resolution', () => {
  it('never auto-attaches an ambiguous abbreviation; links it as a possible duplicate instead', async () => {
    const { resolveConcept } = await import('@/lib/sensei/store');
    const pe = await resolveConcept(db, { name: 'Pulmonary embolism', aliases: ['PE'] });
    const effusion = await resolveConcept(db, { name: 'PE' });
    expect(effusion.id).not.toBe(pe.id);
    expect(effusion.possibleDuplicates).toEqual([pe.id]);
    const again = await resolveConcept(db, { name: 'pulmonary Embolism' });
    expect(again.id).toBe(pe.id);
  });
});

describe('processLecture', () => {
  it('extracts multiple records, gates numbers and invented quotes, keeps anecdotes as anecdotes', async () => {
    const { lectureId } = await ingest(LECTURE_1, 'RESP101', '2026-09-01', 'Oxygen basics');
    const report = await processLecture(db, fakeLlm([lecture1Extraction]), lectureId);

    expect(report.recordsWritten).toBe(4);
    expect(report.recordsRejected.map((r) => r.reason)).toEqual(['no verifiable evidence quote']);
    expect(report.recordsFlagged).toBe(1);

    const { rows } = await db.query<{ statement: string; verification: string; type: string; notes: string[] }>(
      `SELECT statement, verification, type, verification_notes AS notes FROM sensei_knowledge_record ORDER BY statement`,
    );
    const peep = rows.find((r) => r.statement.includes('15 cmH2O'))!;
    expect(peep.verification).toBe('flagged');
    expect(peep.notes.join()).toMatch(/15/);
    expect(rows.find((r) => r.statement.includes('room air'))!.verification).toBe('fidelity_ok');
    expect(rows.find((r) => r.type === 'anecdote')).toBeTruthy();

    // Evidence links back to the exact transcript timestamp.
    const { rows: ev } = await db.query<{ start_ms: number }>(
      `SELECT u.start_ms FROM sensei_record_evidence e JOIN sensei_source_unit u ON u.id = e.unit_id
         JOIN sensei_knowledge_record r ON r.id = e.record_id WHERE r.type = 'exam_hint'`,
    );
    expect(ev[0].start_ms).toBe(51_000);
    expect((await signals('Positive end-expiratory pressure')).emphasis).toBe(1);
  });

  it('reprocessing the same lecture creates no duplicates and does not inflate recurrence', async () => {
    const { lectureId } = await ingest(LECTURE_1, 'RESP101', '2026-09-01', 'Oxygen basics');
    await processLecture(db, fakeLlm([lecture1Extraction]), lectureId);
    const before = await db.query<{ id: string }>(`SELECT id FROM sensei_knowledge_record ORDER BY id`);
    await processLecture(db, fakeLlm([lecture1Extraction]), lectureId);
    const after = await db.query<{ id: string }>(`SELECT id FROM sensei_knowledge_record ORDER BY id`);
    expect(after.rows).toEqual(before.rows);
    expect((await signals('Fraction of inspired oxygen')).lectures).toBe(1);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sensei_record_evidence WHERE superseded_at IS NULL`,
    );
    expect(Number(rows[0].n)).toBe(4);
  });

  it('links a later lecture to existing concepts, counts recurrence across courses, flags changed numbers', async () => {
    const l1 = await ingest(LECTURE_1, 'RESP101', '2026-09-01', 'Oxygen basics');
    await processLecture(
      db,
      fakeLlm([
        {
          records: [
            ...lecture1Extraction.records.slice(0, 1),
            rec({
              concept_name: 'Partial pressure of arterial oxygen',
              concept_aliases: ['PaO2'],
              type: 'anecdote',
              statement: 'A [PATIENT] had PaO2 60 despite SpO2 99.',
              evidence: [{ unit_ref: 'U4', quote: 'his PaO2 was 60 because of carbon monoxide' }],
            }),
          ],
          relations: [],
        },
      ]),
      l1.lectureId,
    );
    const l2 = await ingest(LECTURE_2, 'RESP102', '2026-09-08', 'Oxygen delivery');
    const llm = fakeLlm([
      (prompt) => ({
        records: [
          rec({
            concept_ref: refFor(prompt, 'Fraction of inspired oxygen'),
            concept_name: 'Fraction of inspired oxygen',
            type: 'clinical',
            statement: 'On a nasal cannula each liter adds about 4% FiO2.',
            evidence: [{ unit_ref: 'U1', quote: 'each liter adds about four percent' }],
          }),
          rec({
            // Model wrongly points PaO2's normal range at the FiO2 concept: the never-merge guard must refuse.
            concept_ref: refFor(prompt, 'Fraction of inspired oxygen'),
            concept_name: 'PaO2',
            statement: 'Normal PaO2 is 75-100 mmHg.',
            evidence: [{ unit_ref: 'U2', quote: 'Normal PaO2 is 75 to 100 millimeters of mercury' }],
          }),
        ],
        relations: [],
      }),
    ]);
    await processLecture(db, llm, l2.lectureId);
    expect(llm.prompts[0]).toContain('Fraction of inspired oxygen');

    const fio2 = await signals('Fraction of inspired oxygen');
    expect(fio2).toMatchObject({ lectures: 2, courses: 2 });

    // Refused the wrong FiO2 ref, then resolved "PaO2" through its unambiguous alias to the right concept.
    const { rows: pao2Records } = await db.query<{ canonical_name: string }>(
      `SELECT c.canonical_name FROM sensei_knowledge_record r JOIN sensei_concept c ON c.id = r.concept_id
        WHERE r.statement LIKE 'Normal PaO2%'`,
    );
    expect(pao2Records[0].canonical_name).toBe('Partial pressure of arterial oxygen');
    expect(await signals('Partial pressure of arterial oxygen')).toMatchObject({ lectures: 2, courses: 2 });
  });

  it('a "duplicate" with different numbers becomes a flagged contradiction, preserving the original', async () => {
    const l1 = await ingest(LECTURE_2.replace('75', '80'), 'RESP101', '2026-09-01', 'ABGs');
    await processLecture(
      db,
      fakeLlm([
        {
          records: [
            rec({
              concept_name: 'Partial pressure of arterial oxygen',
              concept_aliases: ['PaO2'],
              statement: 'Normal PaO2 is 80-100 mmHg.',
              evidence: [{ unit_ref: 'U2', quote: 'Normal PaO2 is 80 to 100 millimeters of mercury' }],
            }),
          ],
          relations: [],
        },
      ]),
      l1.lectureId,
    );
    const l2 = await ingest(LECTURE_2, 'RESP201', '2026-10-01', 'ABGs revisited');
    await processLecture(
      db,
      fakeLlm([
        (prompt) => ({
          records: [
            rec({
              concept_ref: refFor(prompt, 'Partial pressure of arterial oxygen'),
              concept_name: 'Partial pressure of arterial oxygen',
              statement: 'Normal PaO2 is 75-100 mmHg.',
              evidence: [{ unit_ref: 'U2', quote: 'Normal PaO2 is 75 to 100 millimeters of mercury' }],
              existing_record_ref: refFor(prompt, 'Normal PaO2 is 80-100 mmHg.'),
              existing_record_relation: 'duplicate',
            }),
          ],
          relations: [],
        }),
      ]),
      l2.lectureId,
    );
    const { rows } = await db.query<{ statement: string; verification: string; superseded_at: Date | null }>(
      `SELECT statement, verification, superseded_at FROM sensei_knowledge_record ORDER BY created_at`,
    );
    expect(rows.map((r) => r.statement)).toEqual(['Normal PaO2 is 80-100 mmHg.', 'Normal PaO2 is 75-100 mmHg.']);
    expect(rows[0].superseded_at).toBeNull();
    expect(rows[1].verification).toBe('flagged');
    const { rows: links } = await db.query<{ type: string }>(`SELECT type FROM sensei_record_link`);
    expect(links).toEqual([{ type: 'contradicts' }]);
  });

  it('a run that fails after writing some windows leaves no evidence-less records behind', async () => {
    const cues = Array.from({ length: 80 }, (_, i) => {
      const t = (n: number) => `00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000`;
      return `${t(i * 30)} --> ${t(i * 30 + 29)}\nSegment ${i}: compliance is the change in volume over the change in pressure, repeated for length ${'x'.repeat(120)}.`;
    }).join('\n\n');
    const { lectureId } = await ingest(`WEBVTT\n\n${cues}\n`, 'RESP101', '2026-09-01', 'Long lecture');
    const first = {
      records: [
        rec({
          concept_name: 'Compliance',
          statement: 'Compliance is the change in volume over the change in pressure.',
          evidence: [{ unit_ref: 'U1', quote: 'compliance is the change in volume over the change in pressure' }],
        }),
      ],
      relations: [],
    };
    await expect(processLecture(db, fakeLlm([first, new Error('quota exceeded')]), lectureId)).rejects.toThrow('quota');
    const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM sensei_knowledge_record WHERE superseded_at IS NULL`);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('a "duplicate" that fails its own number check does not lend evidence to the earlier fact', async () => {
    const l1 = await ingest(LECTURE_1, 'RESP101', '2026-09-01', 'Oxygen basics');
    await processLecture(db, fakeLlm([{ records: lecture1Extraction.records.slice(0, 1), relations: [] }]), l1.lectureId);
    const l2 = await ingest(LECTURE_2, 'RESP102', '2026-09-08', 'Oxygen delivery');
    await processLecture(
      db,
      fakeLlm([
        (prompt) => ({
          records: [
            rec({
              concept_ref: refFor(prompt, 'Fraction of inspired oxygen'),
              concept_name: 'Fraction of inspired oxygen',
              statement: 'Room air FiO2 is 0.21 (21%).',
              evidence: [{ unit_ref: 'U1', quote: 'Remember FiO2 from last week' }], // this unit says nothing about 0.21
              existing_record_ref: refFor(prompt, 'room air FiO2 is 0.21'),
              existing_record_relation: 'duplicate',
            }),
          ],
          relations: [],
        }),
      ]),
      l2.lectureId,
    );
    const { rows } = await db.query<{ statement: string; lectures: string; verification: string }>(
      `SELECT r.statement, r.verification, count(DISTINCT e.lecture_id) AS lectures FROM sensei_knowledge_record r
         JOIN sensei_record_evidence e ON e.record_id = r.id AND e.superseded_at IS NULL GROUP BY r.id ORDER BY r.created_at`,
    );
    expect(Number(rows[0].lectures)).toBe(1); // original fact did not gain lecture 2's bad evidence
    expect(rows[1].verification).toBe('flagged');
  });

  it('a failed run leaves the last good knowledge intact', async () => {
    const { lectureId } = await ingest(LECTURE_1, 'RESP101', '2026-09-01', 'Oxygen basics');
    await processLecture(db, fakeLlm([lecture1Extraction]), lectureId);
    await expect(processLecture(db, fakeLlm([new Error('provider down')]), lectureId)).rejects.toThrow('provider down');
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sensei_knowledge_record WHERE superseded_at IS NULL`,
    );
    expect(Number(rows[0].n)).toBe(4);
    const { rows: lec } = await db.query<{ status: string }>(`SELECT status FROM sensei_lecture`);
    expect(lec[0].status).toBe('failed');
  });
});
