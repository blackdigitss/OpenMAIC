/**
 * Board readiness: Portion A from mastery of the concepts tagged to each task;
 * Portion B from performance on case practice, by patient condition.
 */
import type { Db } from '../db/types';
import { retrievability } from '../fsrs';
import { CASE_FAMILIES } from '../cases/families';
import { CONDITIONS, SECTIONS, TASKS } from './outline';

export interface TaskReadiness {
  code: string;
  title: string;
  items: number;
  concepts: number;
  /** 0–1 average current recall of reviewed cards on this task's concepts; null if none reviewed. */
  recall: number | null;
  topConcepts: { id: string; name: string }[];
}

export async function boardReadiness(db: Db, now = new Date()) {
  const { rows } = await db.query<{ task_code: string; concept_id: string; name: string; stability: number | null; last_review: Date | null }>(
    `SELECT b.task_code, c.id AS concept_id, c.canonical_name AS name, k.stability, k.last_review
       FROM sensei_concept_board b
       JOIN sensei_concept c ON c.id = b.concept_id
       LEFT JOIN sensei_card k ON k.concept_id = c.id AND NOT k.suspended`,
  );
  const tasks: TaskReadiness[] = TASKS.map((t) => {
    const mine = rows.filter((r) => r.task_code === t.code);
    const concepts = new Map(mine.map((r) => [r.concept_id, r.name]));
    const recalls = mine
      .filter((r) => r.last_review && r.stability)
      .map((r) => retrievability((now.getTime() - new Date(r.last_review!).getTime()) / 86_400_000, Number(r.stability)));
    return {
      code: t.code,
      title: t.title,
      items: t.items,
      concepts: concepts.size,
      recall: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
      topConcepts: [...concepts.entries()].slice(0, 6).map(([id, name]) => ({ id, name })),
    };
  });
  const sections = SECTIONS.map((s) => {
    const ts = tasks.filter((t) => t.code.startsWith(`${s.code}.`));
    const covered = ts.filter((t) => t.concepts > 0).reduce((n, t) => n + t.items, 0);
    const weighted = ts.filter((t) => t.recall != null);
    const readiness = weighted.length ? weighted.reduce((n, t) => n + t.items * t.recall!, 0) / weighted.reduce((n, t) => n + t.items, 0) : null;
    return { ...s, coveredItems: covered, readiness, tasks: ts };
  });

  // Portion B: accuracy on case cards (first rating per review: Good/Easy = correct).
  const { rows: caseRows } = await db.query<{ case_family: string; correct: string; total: string }>(
    `SELECT k.case_family, count(*) FILTER (WHERE l.rating >= 3) AS correct, count(*) AS total
       FROM sensei_review_log l JOIN sensei_card k ON k.id = l.card_id
      WHERE k.case_family IS NOT NULL GROUP BY k.case_family`,
  );
  const byCondition = new Map<string, { correct: number; total: number }>();
  for (const r of caseRows) {
    const fam = CASE_FAMILIES.find((f) => f.id === r.case_family);
    if (!fam) continue;
    const condition = fam.generate(1).condition;
    const cur = byCondition.get(condition) ?? { correct: 0, total: 0 };
    byCondition.set(condition, { correct: cur.correct + Number(r.correct), total: cur.total + Number(r.total) });
  }
  const conditions = CONDITIONS.map((c) => ({ ...c, ...(byCondition.get(c.code) ?? { correct: 0, total: 0 }) }));
  return { sections, conditions };
}
