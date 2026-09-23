import { describe, expect, it } from 'vitest';

import { CardState, intervalDays, retrievability, schedule, type CardMemory } from '@/lib/sensei/fsrs';

const fresh: CardMemory = { stability: 0, difficulty: 0, reps: 0, lapses: 0, state: CardState.New, lastReview: null };
const DAY = 86_400_000;

describe('FSRS-5', () => {
  it('retrievability is 90% after exactly one stability interval', () => {
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 5);
    expect(intervalDays(10)).toBe(10);
  });

  it('first ratings seed stability from the default weights, ordered by rating', () => {
    const t0 = new Date('2026-09-01T12:00:00Z');
    const again = schedule(fresh, 1, t0);
    const good = schedule(fresh, 3, t0);
    const easy = schedule(fresh, 4, t0);
    expect(again.due.getTime() - t0.getTime()).toBe(10 * 60_000);
    expect(good.intervalDays).toBe(3);
    expect(easy.intervalDays).toBeGreaterThan(good.intervalDays);
    expect(easy.difficulty).toBeLessThan(good.difficulty);
  });

  it('successive Good reviews grow the interval; a lapse shrinks stability and counts', () => {
    let t = new Date('2026-09-01T12:00:00Z');
    let card: CardMemory = fresh;
    const intervals: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = schedule(card, 3, t);
      intervals.push(r.intervalDays);
      card = r;
      t = r.due;
    }
    expect(intervals).toEqual([...intervals].sort((a, b) => a - b));
    expect(intervals[3]).toBeGreaterThan(intervals[0] * 5);
    const lapse = schedule(card, 1, t);
    expect(lapse.stability).toBeLessThan(card.stability);
    expect(lapse.lapses).toBe(1);
    expect(lapse.state).toBe(CardState.Relearning);
  });

  it('difficulty stays within [1, 10]', () => {
    let card: CardMemory = fresh;
    let t = new Date();
    for (let i = 0; i < 20; i++) {
      card = schedule(card, 1, t);
      t = new Date(t.getTime() + 2 * DAY);
    }
    expect(card.difficulty).toBeLessThanOrEqual(10);
    expect(card.difficulty).toBeGreaterThanOrEqual(1);
  });
});
