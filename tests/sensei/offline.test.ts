import { describe, expect, it } from 'vitest';

import { GET } from '@/app/sensei-sw.js/route';

describe('service worker', () => {
  it('is valid JavaScript with a build-specific cache and no precache', async () => {
    const src = await GET().text();
    expect(() => new Function(src)).not.toThrow();
    expect(src).toMatch(/const CACHE = 'sensei-[^']+'/);
    expect(src).not.toMatch(/addAll\(/);
  });

  it('keeps pages and data but never audio or ranged requests', async () => {
    const src = await GET().text();
    const keepable = new Function(`${src.slice(src.indexOf('function keepable'), src.indexOf("self.addEventListener('fetch'"))}; return keepable;`)() as (
      u: URL,
      r: { method: string; headers: Headers },
    ) => boolean;
    Object.assign(globalThis, { self: { location: { origin: 'https://s.test' } } });
    const get = (h: Record<string, string> = {}) => ({ method: 'GET', headers: new Headers(h) });
    const u = (p: string) => new URL(p, 'https://s.test');
    expect(keepable(u('/sensei'), get())).toBe(true);
    expect(keepable(u('/api/sensei/today'), get())).toBe(true);
    expect(keepable(u('/_next/static/chunks/a.js'), get())).toBe(true);
    expect(keepable(u('/api/sensei/audio/x'), get())).toBe(false);
    expect(keepable(u('/api/sensei/reels/x'), get())).toBe(false);
    expect(keepable(u('/api/sensei/today'), get({ range: 'bytes=0-1' }))).toBe(false);
    expect(keepable(u('/api/sensei/review'), { method: 'POST', headers: new Headers() })).toBe(false);
    expect(keepable(u('/'), get())).toBe(false);
  });
});

describe('queued ratings on the server', () => {
  it('ignores a replay of the same rating and an older rating that arrives late', async () => {
    const { testDb } = await import('./helpers');
    const { reviewCard } = await import('@/lib/sensei/learn');
    const { resolveConcept } = await import('@/lib/sensei/store');
    const db = await testDb();
    try {
      const c = await resolveConcept(db, { name: 'Oxygen toxicity' });
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO sensei_card (concept_id, competency, content_key, front, back) VALUES ($1, 'recall', 'k', 'f', 'b') RETURNING id`,
        [c.id],
      );
      const id = rows[0].id;
      const t1 = new Date('2026-09-01T15:00:00Z');
      await reviewCard(db, id, 3, t1);
      const snap = async () => (await db.query('SELECT stability, reps, due FROM sensei_card WHERE id = $1', [id])).rows[0];
      const after = await snap();
      await reviewCard(db, id, 3, t1); // replay
      await reviewCard(db, id, 1, new Date('2026-08-31T15:00:00Z')); // older, from another device
      expect(await snap()).toEqual(after);
      const { rows: logs } = await db.query('SELECT 1 FROM sensei_review_log WHERE card_id = $1', [id]);
      expect(logs).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
