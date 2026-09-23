import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formulaById, FORMULAS, generate, grade } from '@/lib/sensei/calc/formulas';
import { syncCalcCards, unlockedFormulas } from '@/lib/sensei/calc/unlock';
import type { Db } from '@/lib/sensei/db/types';
import { addEvidence, ensureCourse, ensureLecture, insertUnits, registerSource, resolveConcept, sha256, startRun, upsertRecord } from '@/lib/sensei/store';

import { testDb } from './helpers';

const f = (id: string) => formulaById(id)!;

describe('formulas match textbook worked examples', () => {
  it('E cylinder: 2200 psig × 0.28 ÷ 2 L/min = 308 min', () => {
    expect(grade(f('cylinder-duration'), { size: 'E', psig: 2200, flow: 2 }, 308).correct).toBe(true);
    expect(grade(f('cylinder-duration'), { size: 'E', psig: 2200, flow: 2 }, 320).correct).toBe(false);
  });

  it('accepts a 500 psig reserve as a legitimate method and says so', () => {
    const g = grade(f('cylinder-duration'), { size: 'E', psig: 2200, flow: 2 }, 238);
    expect(g.correct).toBe(true);
    expect(g.matched?.id).toBe('reserve500');
  });

  it('alveolar air equation: Egan’s FiO2 0.7, PaCO2 40 → 449; dropping 0.8 at high FiO2 → 459 also accepted', () => {
    const v = { fio2: 0.7, pb: 760, paco2: 40 };
    expect(grade(f('pao2-alveolar'), v, 449).matched?.id).toBe('standard');
    expect(grade(f('pao2-alveolar'), v, 459).matched?.id).toBe('noR');
    expect(grade(f('pao2-alveolar'), v, 420).correct).toBe(false);
  });

  it('entrainment ratio at 35%: formula 4.6 and chart 5 are both right', () => {
    expect(grade(f('entrainment-ratio'), { fio2: 35 }, 4.6).correct).toBe(true);
    expect(grade(f('entrainment-ratio'), { fio2: 35 }, 5).matched?.id).toBe('chart');
    expect(grade(f('entrainment-ratio'), { fio2: 35 }, 3).correct).toBe(false);
  });

  it('CaO2 with 1.34 (Egan’s) and the other published constants', () => {
    const v = { hb: 15, sao2: 97, pao2: 95 };
    expect(grade(f('cao2'), v, 19.8).matched?.id).toBe('1.34');
    expect(grade(f('cao2'), v, 20.5).correct).toBe(true); // 1.39 × 15 × 0.97 + 0.285
  });

  it('anion gap with or without K⁺', () => {
    const v = { na: 140, k: 4, cl: 104, hco3: 24 };
    expect(grade(f('anion-gap'), v, 12).matched?.id).toBe('noK');
    expect(grade(f('anion-gap'), v, 16).matched?.id).toBe('withK');
  });

  it('other spot checks', () => {
    expect(grade(f('liquid-o2-duration'), { lbs: 10, flow: 2 }, 1720).correct).toBe(true);
    expect(grade(f('pbw'), { sex: 'male', inches: 70 }, 73).correct).toBe(true);
    expect(grade(f('pbw'), { sex: 'female', inches: 64 }, 54.7).correct).toBe(true);
    expect(grade(f('rsbi'), { f: 30, vt: 300 }, 100).correct).toBe(true);
    expect(grade(f('airway-resistance'), { pip: 30, pplat: 20, flow: 60 }, 10).correct).toBe(true);
    expect(grade(f('heliox-flow'), { mix: '80/20', reading: 10 }, 18).correct).toBe(true);
    expect(grade(f('static-compliance'), { vt: 500, pplat: 25, peep: 5 }, 25).correct).toBe(true);
    expect(grade(f('mean-arterial-pressure'), { sbp: 120, dbp: 80 }, 93).correct).toBe(true);
  });
});

describe('problem generation', () => {
  it('every formula generates valid, finite problems and grades its own answer as correct', () => {
    for (const formula of FORMULAS) {
      for (let seed = 1; seed < 40; seed++) {
        const v = generate(formula, seed);
        const answer = formula.variants[0].compute(v);
        expect(Number.isFinite(answer), `${formula.id} seed ${seed}`).toBe(true);
        expect(grade(formula, v, answer).correct, `${formula.id} seed ${seed}`).toBe(true);
        expect(formula.question(v).length).toBeGreaterThan(10);
        expect(formula.steps(v, formula.variants[0]).length).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic per seed', () => {
    expect(generate(f('cao2'), 42)).toEqual(generate(f('cao2'), 42));
  });
});

describe('unlocking', () => {
  let db: Db & { close(): Promise<void> };
  beforeEach(async () => {
    db = await testDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it('unlocks cylinder duration once "E cylinder" is taught, and creates one calc card', async () => {
    expect(await unlockedFormulas(db)).toEqual([]);
    const course = await ensureCourse(db, 'RESP 101A', 'RC1');
    const lectureId = await ensureLecture(db, { courseId: course, date: '2026-09-15', title: 'Gases' });
    const src = await registerSource(db, { sha256: sha256('x'), kind: 'transcript', courseId: course, title: 't', originalName: 't', storedPath: '/x' });
    const [unit] = await insertUnits(db, src.id, [{ kind: 'segment', ordinal: 1, text: 'the E cylinder factor is 0.28' }]);
    const c = await resolveConcept(db, { name: 'E cylinder', aliases: [] });
    const run = await startRun(db, lectureId, 'v', 'm');
    const rec = await upsertRecord(db, { conceptId: c.id, type: 'formula', statement: 'E cylinder factor is 0.28.', verification: 'fidelity_ok', lectureId });
    await addEvidence(db, { recordId: rec.id, unitId: unit.id, lectureId, runId: run, quote: 'the E cylinder factor is 0.28' });
    expect((await unlockedFormulas(db)).map((u) => u.formula.id)).toContain('cylinder-duration');
    expect(await syncCalcCards(db)).toBeGreaterThan(0);
    expect(await syncCalcCards(db)).toBe(0);
  });
});
