/**
 * Seed a DEMO database with two realistic lectures so the app can be exercised
 * without API keys. Never point this at the real database.
 *   SENSEI_DATABASE_URL=postgresql://localhost:5432/sensei_demo SENSEI_HOME=/tmp/sensei-demo tsx scripts/sensei/demo-seed.ts
 */
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { loadEnv } from './env';

loadEnv();

const L1 = [
  [0, 'Alright, before we start, parking passes are due Friday at the front office.'],
  [22, 'Today is oxygen therapy. FiO2 is the fraction of inspired oxygen. Room air is 21 percent, so an FiO2 of 0.21.'],
  [51, 'A nasal cannula adds roughly 4 percent per liter. So at 2 liters you are around 28 percent.'],
  [84, 'Do not go above 6 liters on a nasal cannula. Above that you just dry out the mucosa. This will be on the exam.'],
  [118, 'Now PaO2 is the partial pressure of oxygen in arterial blood. Normal PaO2 is 80 to 100 mmHg. That is what the ABG tells you.'],
  [160, 'SpO2 is what the pulse oximeter reads, the saturation. It is not the same as PaO2, and students mix these up constantly.'],
  [197, 'I had a patient in the ER, a firefighter, SpO2 of 99 percent, but he had carbon monoxide poisoning. The pulse ox cannot tell carbon monoxide from oxygen.'],
  [240, 'Hypoxemia means low oxygen in the blood, low PaO2. Hypoxia is low oxygen at the tissues. Different things.'],
  [275, 'Next week we get into the oxyhemoglobin dissociation curve, which ties SpO2 and PaO2 together.'],
] as const;

const L2 = [
  [0, 'Remember FiO2 from last week? On a nonrebreather you can get close to 100 percent, maybe 60 to 80 percent realistically.'],
  [40, 'Today, the oxyhemoglobin dissociation curve. It shows how saturation relates to PaO2.'],
  [78, 'A PaO2 of 60 gives you roughly 90 percent saturation. Memorize that pair, 60 and 90. Exam material.'],
  [115, 'A shift to the right means hemoglobin lets go of oxygen more easily. Acidosis, fever, and high CO2 shift it right.'],
  [150, 'Normal PaO2, some textbooks say 75 to 100 mmHg. Just know the range can differ by source.'],
  [185, 'Think of hemoglobin like a taxi. In the lungs it picks up passengers, in the tissues it drops them off.'],
] as const;

function vttAudio(dir: string, name: string, seconds: number) {
  const path = join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`, '-ac', '1', '-b:a', '32k', path]);
  return path;
}

async function main() {
  const url = process.env.SENSEI_DATABASE_URL ?? '';
  if (!/sensei_demo/.test(url)) throw new Error('Refusing: SENSEI_DATABASE_URL must point at a *sensei_demo* database');
  const { senseiConfig } = await import('@/lib/sensei/config');
  const { senseiDb, closeSenseiDb } = await import('@/lib/sensei/db/pool');
  const store = await import('@/lib/sensei/store');
  const { processLecture } = await import('@/lib/sensei/pipeline');
  const config = senseiConfig();
  const db = await senseiDb();
  const dir = join(config.home, 'demo-src');
  mkdirSync(dir, { recursive: true });

  const courses = [
    { code: 'RESP 110', title: 'Respiratory Care Fundamentals', color: '#30B0C7' },
    { code: 'RESP 120', title: 'Cardiopulmonary Physiology', color: '#FF9500' },
  ];
  for (const c of courses) {
    const id = await store.ensureCourse(db, c.code, c.title);
    await db.query('UPDATE sensei_course SET color = $2, title = $3 WHERE id = $1', [id, c.color, c.title]);
  }

  async function lecture(course: string, date: string, title: string, lines: readonly (readonly [number, string])[], summary: string) {
    const courseId = (await db.query<{ id: string }>('SELECT id FROM sensei_course WHERE code = $1', [course])).rows[0].id;
    const lectureId = await store.ensureLecture(db, { courseId, date, title });
    const audioPath = vttAudio(dir, `${title}.m4a`, lines[lines.length - 1][0] + 40);
    const audio = await store.registerSource(db, {
      sha256: store.sha256(title + 'audio'), kind: 'audio', courseId, title, originalName: `${title}.m4a`, storedPath: audioPath,
    });
    await store.linkLectureSource(db, lectureId, audio.id);
    const t = await store.registerSource(db, {
      sha256: store.sha256(title + 'transcript'), kind: 'transcript', courseId: null, title: 'Transcript', originalName: 'transcript.json',
      storedPath: join(dir, `${title}.json`), derivedFrom: audio.id, metadata: { audioSourceId: audio.id },
    });
    await store.linkLectureSource(db, lectureId, t.id);
    await store.insertUnits(
      db,
      t.id,
      lines.map(([s, text], i) => ({
        kind: 'segment' as const, ordinal: i + 1, startMs: s * 1000, endMs: (lines[i + 1]?.[0] ?? s + 30) * 1000,
        speaker: 'instructor', text, uncertainTerms: text.includes('nonrebreather') ? ['nonrebreather'] : [],
      })),
    );
    await db.query('UPDATE sensei_lecture SET summary = $2 WHERE id = $1', [lectureId, summary]);
    return lectureId;
  }

  const rec = (o: Record<string, unknown>) => ({
    concept_ref: null, concept_aliases: [], concept_kind: 'term', concept_short_definition: null, type: 'definition',
    context: null, existing_record_ref: null, existing_record_relation: null, ...o,
  });
  const ref = (prompt: string, text: string) => /\b([CR]\d+):/.exec(prompt.split('\n').find((l) => l.includes(text)) ?? '')?.[1] ?? null;
  const scripted = (fn: (prompt: string) => unknown) => ({
    modelName: () => 'demo',
    call: async <T,>(req: { schema: { parse: (x: unknown) => T }; prompt: string }) => req.schema.parse(fn(req.prompt)),
  });

  const l1 = await lecture('RESP 110', daysAgo(7), 'Oxygen Therapy Basics', L1,
    'Introduced FiO2, PaO2 and SpO2 and why they are not interchangeable. Stressed the 6 L/min nasal cannula ceiling and the carbon monoxide pulse-ox trap.');
  await processLecture(db, scripted(() => ({
    records: [
      rec({ concept_name: 'Fraction of inspired oxygen', concept_aliases: ['FiO2'], concept_short_definition: 'The fraction of oxygen in the gas a patient breathes in.', statement: 'FiO2 is the fraction of inspired oxygen; room air is 21%, an FiO2 of 0.21.', evidence: [{ unit_ref: 'U2', quote: 'FiO2 is the fraction of inspired oxygen' }] }),
      rec({ concept_name: 'Nasal cannula', concept_kind: 'device', concept_short_definition: 'Low-flow oxygen device delivering oxygen through two prongs in the nostrils.', type: 'calculation', statement: 'A nasal cannula adds about 4% FiO2 per liter; at 2 L/min FiO2 is about 28%.', evidence: [{ unit_ref: 'U3', quote: 'A nasal cannula adds roughly 4 percent per liter' }] }),
      rec({ concept_name: 'Nasal cannula', concept_kind: 'device', type: 'exam_hint', statement: 'Do not exceed 6 L/min on a nasal cannula; higher flows dry the mucosa.', evidence: [{ unit_ref: 'U4', quote: 'Do not go above 6 liters on a nasal cannula' }] }),
      rec({ concept_name: 'Partial pressure of arterial oxygen', concept_aliases: ['PaO2'], concept_kind: 'lab_value', concept_short_definition: 'The pressure of oxygen dissolved in arterial blood, measured on an ABG.', statement: 'PaO2 is the partial pressure of oxygen in arterial blood; normal is 80-100 mmHg, measured by ABG.', evidence: [{ unit_ref: 'U5', quote: 'Normal PaO2 is 80 to 100 mmHg' }] }),
      rec({ concept_name: 'Oxygen saturation by pulse oximetry', concept_aliases: ['SpO2'], concept_kind: 'lab_value', concept_short_definition: 'Hemoglobin oxygen saturation estimated by a pulse oximeter.', statement: 'SpO2 is the saturation read by the pulse oximeter and is not the same as PaO2.', evidence: [{ unit_ref: 'U6', quote: 'SpO2 is what the pulse oximeter reads' }] }),
      rec({ concept_name: 'Oxygen saturation by pulse oximetry', concept_aliases: ['SpO2'], type: 'misconception', statement: 'Students often confuse SpO2 with PaO2.', evidence: [{ unit_ref: 'U6', quote: 'students mix these up constantly' }] }),
      rec({ concept_name: 'Carbon monoxide poisoning', concept_kind: 'disease', concept_short_definition: 'Poisoning where carbon monoxide binds hemoglobin in place of oxygen.', type: 'anecdote', statement: 'A firefighter with carbon monoxide poisoning had an SpO2 of 99% because the pulse oximeter cannot tell carbon monoxide from oxygen.', evidence: [{ unit_ref: 'U7', quote: 'The pulse ox cannot tell carbon monoxide from oxygen' }] }),
      rec({ concept_name: 'Hypoxemia', concept_kind: 'physiology', concept_short_definition: 'Low oxygen in the arterial blood (low PaO2).', statement: 'Hypoxemia is low oxygen in the blood (low PaO2); hypoxia is low oxygen at the tissues.', evidence: [{ unit_ref: 'U8', quote: 'Hypoxemia means low oxygen in the blood' }] }),
      rec({ concept_name: 'Hypoxia', concept_kind: 'physiology', concept_short_definition: 'Low oxygen at the tissue level.', statement: 'Hypoxia is low oxygen at the tissues, which is different from hypoxemia.', evidence: [{ unit_ref: 'U8', quote: 'Hypoxia is low oxygen at the tissues' }] }),
      rec({ concept_name: 'Oxyhemoglobin dissociation curve', concept_kind: 'physiology', type: 'foreshadow', statement: 'Next week covers the oxyhemoglobin dissociation curve linking SpO2 and PaO2.', evidence: [{ unit_ref: 'U9', quote: 'Next week we get into the oxyhemoglobin dissociation curve' }] }),
    ],
    relations: [
      { from_concept: 'Partial pressure of arterial oxygen', to_concept: 'Hypoxemia', type: 'measured_by' },
      { from_concept: 'Oxygen saturation by pulse oximetry', to_concept: 'Partial pressure of arterial oxygen', type: 'confused_with' },
      { from_concept: 'Hypoxemia', to_concept: 'Hypoxia', type: 'confused_with' },
      { from_concept: 'Fraction of inspired oxygen', to_concept: 'Nasal cannula', type: 'applied_in' },
      { from_concept: 'Partial pressure of arterial oxygen', to_concept: 'Oxyhemoglobin dissociation curve', type: 'prerequisite_of' },
      { from_concept: 'Carbon monoxide poisoning', to_concept: 'Oxygen saturation by pulse oximetry', type: 'affects' },
    ],
  })) as never, l1);

  const l2 = await lecture('RESP 120', daysAgo(0), 'The Oxyhemoglobin Curve', L2,
    'Built the oxyhemoglobin dissociation curve on last week’s PaO2 and SpO2. The 60/90 pair was flagged as exam material, and right shifts were explained with a taxi analogy.');
  await processLecture(db, scripted((p) => ({
    records: [
      rec({ concept_ref: ref(p, 'Fraction of inspired oxygen'), concept_name: 'Fraction of inspired oxygen', type: 'clinical', statement: 'A nonrebreather can approach 100% FiO2, realistically 60-80%.', evidence: [{ unit_ref: 'U1', quote: 'On a nonrebreather you can get close to 100 percent' }] }),
      rec({ concept_ref: ref(p, 'Oxyhemoglobin dissociation curve'), concept_name: 'Oxyhemoglobin dissociation curve', concept_short_definition: 'Curve showing how hemoglobin saturation varies with PaO2.', statement: 'The oxyhemoglobin dissociation curve shows how saturation relates to PaO2.', evidence: [{ unit_ref: 'U2', quote: 'It shows how saturation relates to PaO2' }] }),
      rec({ concept_ref: ref(p, 'Oxyhemoglobin dissociation curve'), concept_name: 'Oxyhemoglobin dissociation curve', type: 'exam_hint', statement: 'A PaO2 of 60 mmHg gives roughly 90% saturation; memorize the 60/90 pair.', evidence: [{ unit_ref: 'U3', quote: 'A PaO2 of 60 gives you roughly 90 percent saturation' }] }),
      rec({ concept_name: 'Right shift of the oxyhemoglobin curve', concept_kind: 'physiology', concept_short_definition: 'Hemoglobin releases oxygen more easily.', type: 'mechanism', statement: 'A right shift means hemoglobin releases oxygen more easily; acidosis, fever and high CO2 shift the curve right.', evidence: [{ unit_ref: 'U4', quote: 'A shift to the right means hemoglobin lets go of oxygen more easily' }] }),
      rec({ concept_ref: ref(p, 'Partial pressure of arterial oxygen'), concept_name: 'Partial pressure of arterial oxygen', statement: 'Normal PaO2 is 75-100 mmHg in some textbooks.', evidence: [{ unit_ref: 'U5', quote: 'some textbooks say 75 to 100 mmHg' }], existing_record_ref: ref(p, 'normal is 80-100'), existing_record_relation: 'duplicate' }),
      rec({ concept_name: 'Hemoglobin', concept_kind: 'physiology', concept_short_definition: 'The oxygen-carrying protein in red blood cells.', type: 'analogy', statement: 'Hemoglobin is like a taxi: it picks up oxygen in the lungs and drops it off in the tissues.', evidence: [{ unit_ref: 'U6', quote: 'Think of hemoglobin like a taxi' }] }),
    ],
    relations: [
      { from_concept: 'Oxyhemoglobin dissociation curve', to_concept: 'Right shift of the oxyhemoglobin curve', type: 'prerequisite_of' },
      { from_concept: 'Hemoglobin', to_concept: 'Oxyhemoglobin dissociation curve', type: 'prerequisite_of' },
    ],
  })) as never, l2);

  // A few review cards, one already lapsed twice, so every screen has content.
  const { rows: cs } = await db.query<{ id: string; canonical_name: string }>('SELECT id, canonical_name FROM sensei_concept');
  const cid = (n: string) => cs.find((c) => c.canonical_name === n)!.id;
  const cards: [string, string, string, string][] = [
    ['Fraction of inspired oxygen', 'recall', 'What is the FiO2 of room air?', '0.21, or 21% oxygen.'],
    ['Nasal cannula', 'calculate', 'Estimate the FiO2 for a patient on a nasal cannula at 3 L/min.', 'About 33%: room air 21% plus roughly 4% per liter (21 + 3 × 4).'],
    ['Oxyhemoglobin dissociation curve', 'recall', 'A PaO2 of 60 mmHg corresponds to what saturation?', 'Roughly 90%. Your professor called the 60/90 pair exam material.'],
    ['Oxygen saturation by pulse oximetry', 'apply', 'A firefighter pulled from a house fire has an SpO2 of 99%. Can you trust it?', 'No. The pulse oximeter cannot distinguish carbon monoxide from oxygen, so SpO2 reads falsely high in CO poisoning.'],
    ['Hypoxemia', 'explain', 'How is hypoxemia different from hypoxia?', 'Hypoxemia is low oxygen in the blood (low PaO2); hypoxia is low oxygen at the tissues.'],
  ];
  for (const [name, comp, front, back] of cards) {
    await db.query(
      `INSERT INTO sensei_card (concept_id, competency, content_key, front, back) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [cid(name), comp, store.sha256(front), front, back],
    );
  }
  await db.query(`UPDATE sensei_card SET lapses = 2, state = 3, stability = 0.8, difficulty = 7, reps = 4, last_review = now() - interval '2 days' WHERE front LIKE 'How is hypoxemia%'`);
  writeFileSync(join(config.home, 'demo-seeded'), new Date().toISOString());
  console.log('Demo seeded.');
  await closeSenseiDb();
}

function daysAgo(n: number) {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
