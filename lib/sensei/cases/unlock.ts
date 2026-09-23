import type { Db } from '../db/types';
import { unlockedFormulas } from '../calc/unlock';
import { normalizeTerm } from '../normalize';
import { CASE_FAMILIES, type CaseFamily } from './families';

/** A case family unlocks when its formula is unlocked or one of its concepts has been taught. */
export async function unlockedCases(db: Db): Promise<{ family: CaseFamily; conceptId: string }[]> {
  const formulas = await unlockedFormulas(db);
  const { rows } = await db.query<{ id: string; names: string[] }>(
    `SELECT c.id, array_append(coalesce(array_agg(a.normalized_alias) FILTER (WHERE a.normalized_alias IS NOT NULL), '{}'), c.normalized_name) AS names
       FROM sensei_concept c LEFT JOIN sensei_concept_alias a ON a.concept_id = c.id
      WHERE EXISTS (SELECT 1 FROM sensei_knowledge_record r JOIN sensei_record_evidence e ON e.record_id = r.id AND e.superseded_at IS NULL
                     WHERE r.concept_id = c.id AND r.superseded_at IS NULL AND r.verification <> 'rejected')
      GROUP BY c.id`,
  );
  const out: { family: CaseFamily; conceptId: string }[] = [];
  for (const family of CASE_FAMILIES) {
    const viaFormula = formulas.find((u) => family.unlockFormulas?.includes(u.formula.id));
    if (viaFormula) {
      out.push({ family, conceptId: viaFormula.conceptId });
      continue;
    }
    const keys = (family.unlockConcepts ?? []).map(normalizeTerm);
    const hit = rows.find((c) => c.names.some((n) => keys.some((k) => n === k || ` ${n} `.includes(` ${k} `))));
    if (hit) out.push({ family, conceptId: hit.id });
  }
  return out;
}

export async function syncCaseCards(db: Db): Promise<number> {
  let created = 0;
  for (const u of await unlockedCases(db)) {
    const { rows } = await db.query(
      `INSERT INTO sensei_card (concept_id, competency, content_key, front, back, case_family)
       VALUES ($1, 'apply', $2, $3, '', $4) ON CONFLICT (content_key) DO NOTHING RETURNING id`,
      [u.conceptId, `case:${u.family.id}`, u.family.name, u.family.id],
    );
    created += rows.length;
  }
  return created;
}
