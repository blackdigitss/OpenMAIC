import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '@/lib/sensei/db/types';
import { DEFAULT_W, retrievability } from '@/lib/sensei/fsrs';
import { reviewCard } from '@/lib/sensei/learn';
import { setSetting } from '@/lib/sensei/settings';
import { activeWeights, evaluate, firstReviewObservations, maybeTuneSpacing, spacingStatus, type Observation } from '@/lib/sensei/spacing';
import { resolveConcept } from '@/lib/sensei/store';

import { testDb } from './helpers';

/** A deterministic simulated student whose true initial stabilities are `w`. */
function simulate(w: number[], n: number, seed = 1): Observation[] {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: Observation[] = [];
  for (let i = 0; i < n; i++) {
    const rating = ([1, 2, 3, 3, 3, 3, 4] as const)[Math.floor(rand() * 7)];
    const days = 1 + Math.floor(rand() * 10);
    out.push({ rating, days, recalled: rand() < retrievability(days, w[rating - 1]), at: new Date(Date.UTC(2026, 8, 1) + i * 3_600_000) });
  }
  return out;
}

describe('personal spacing fit', () => {
  it('learns that this student forgets slower than the defaults, and keeps the order', () => {
    const truth = [1.2, 3.5, 9, 40];
    const r = evaluate(simulate(truth, 1500));
    expect(r.w).not.toBeNull();
    expect(r.winRate).toBeGreaterThanOrEqual(0.8);
    expect(r.w![2]).toBeGreaterThan(DEFAULT_W[2] * 1.8);
    for (let i = 1; i < 4; i++) expect(r.w![i]).toBeGreaterThanOrEqual(r.w![i - 1]);
  });

  it('keeps the defaults when they already describe the student', () => {
    const r = evaluate(simulate(DEFAULT_W.slice(0, 4), 400, 7));
    expect(r.w).toBeNull();
  });
});

describe('personal spacing in the app', () => {
  let db: Db & { close(): Promise<void> };
  beforeEach(async () => {
    db = await testDb();
  });
  afterEach(async () => {
    await db.close();
  });

  async function card(competency: string) {
    const c = await resolveConcept(db, { name: `Concept ${Math.random()}` });
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sensei_card (concept_id, competency, content_key, front, back) VALUES ($1, $2, $3, 'f', 'b') RETURNING id`,
      [c.id, competency, `k${Math.random()}`],
    );
    return rows[0].id;
  }

  it('uses the first rating and the first later-day review, skipping same-day repeats and calculation cards', async () => {
    const recall = await card('recall');
    const t0 = new Date('2026-09-01T15:00:00Z');
    await reviewCard(db, recall, 1, t0);
    await reviewCard(db, recall, 3, new Date(t0.getTime() + 11 * 60_000)); // same day: skipped
    await reviewCard(db, recall, 2, new Date('2026-09-04T15:00:00Z'));
    const calc = await card('calculate');
    await reviewCard(db, calc, 3, t0);
    await reviewCard(db, calc, 1, new Date('2026-09-03T15:00:00Z'));
    const obs = await firstReviewObservations(db);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ rating: 1, days: 3, recalled: true });
  });

  it('waits for enough data, then applies the tuned values unless switched off', async () => {
    expect(await maybeTuneSpacing(db)).toBeNull();
    expect((await spacingStatus(db)).collected).toBe(0);
    expect(await activeWeights(db)).toEqual(DEFAULT_W);

    await setSetting(db, 'state:spacing', { w: [1, 3, 9, 30], checkedAt: '2026-10-01T00:00:00Z', observations: 400, winRate: 0.95, improvement: 0.04 });
    expect((await activeWeights(db)).slice(0, 4)).toEqual([1, 3, 9, 30]);
    expect((await activeWeights(db)).slice(4)).toEqual(DEFAULT_W.slice(4));
    await setSetting(db, 'personalSpacing', false);
    expect(await activeWeights(db)).toEqual(DEFAULT_W);
  });
});
