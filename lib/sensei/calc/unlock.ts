/**
 * A formula unlocks once a concept it practices has been taught (has live
 * records). Each unlocked formula gets one FSRS card; every review of it draws
 * fresh numbers, graded by code.
 */
import type { Db } from '../db/types';
import { normalizeTerm } from '../normalize';
import { FORMULAS, type Formula } from './formulas';

export interface UnlockedFormula {
  formula: Formula;
  conceptId: string;
  conceptName: string;
}

export async function unlockedFormulas(db: Db): Promise<UnlockedFormula[]> {
  const { rows } = await db.query<{ id: string; canonical_name: string; names: string[] }>(
    `SELECT c.id, c.canonical_name,
            array_append(coalesce(array_agg(a.normalized_alias) FILTER (WHERE a.normalized_alias IS NOT NULL), '{}'), c.normalized_name) AS names
       FROM sensei_concept c
       LEFT JOIN sensei_concept_alias a ON a.concept_id = c.id
      WHERE EXISTS (SELECT 1 FROM sensei_knowledge_record r JOIN sensei_record_evidence e ON e.record_id = r.id AND e.superseded_at IS NULL
                     WHERE r.concept_id = c.id AND r.superseded_at IS NULL AND r.verification <> 'rejected')
      GROUP BY c.id`,
  );
  const out: UnlockedFormula[] = [];
  for (const formula of FORMULAS) {
    const keys = formula.concepts.map(normalizeTerm);
    const hit = rows.find((c) => c.names.some((name) => keys.some((k) => name === k || ` ${name} `.includes(` ${k} `))));
    if (hit) out.push({ formula, conceptId: hit.id, conceptName: hit.canonical_name });
  }
  return out;
}

/** Create one calculation card per unlocked formula (idempotent). */
export async function syncCalcCards(db: Db): Promise<number> {
  let created = 0;
  for (const u of await unlockedFormulas(db)) {
    const { rows } = await db.query(
      `INSERT INTO sensei_card (concept_id, competency, content_key, front, back, formula_id)
       VALUES ($1, 'calculate', $2, $3, '', $4) ON CONFLICT (content_key) DO NOTHING RETURNING id`,
      [u.conceptId, `calc:${u.formula.id}`, u.formula.name, u.formula.id],
    );
    created += rows.length;
  }
  return created;
}
