/**
 * Write-side of the knowledge core. Every function is idempotent: calling it
 * twice with the same input leaves the database unchanged. Nothing here deletes
 * rows; reprocessing marks stale rows superseded (DECISIONS A3).
 */
import { createHash } from 'crypto';

import type { ConceptKind, Db, RecordType, RelationType, SourceKind, SourceUnit, SourceUnitInput } from './db/types';
import { aliasCanAutoAttach, isNeverMergePair, normalizeStatement, normalizeTerm } from './normalize';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function ensureCourse(db: Db, code: string, title: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sensei_course (code, title) VALUES ($1, $2)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [code, title],
  );
  return rows[0].id;
}

export interface LectureInput {
  courseId: string;
  date: string;
  title: string;
  slideFrom?: number | null;
  slideTo?: number | null;
}

export async function ensureLecture(db: Db, input: LectureInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sensei_lecture (course_id, lecture_date, title, slide_from, slide_to)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (course_id, lecture_date, title) DO UPDATE
       SET slide_from = COALESCE(EXCLUDED.slide_from, sensei_lecture.slide_from),
           slide_to = COALESCE(EXCLUDED.slide_to, sensei_lecture.slide_to)
     RETURNING id`,
    [input.courseId, input.date, input.title, input.slideFrom ?? null, input.slideTo ?? null],
  );
  return rows[0].id;
}

export interface SourceInput {
  sha256: string;
  kind: SourceKind;
  courseId: string | null;
  title: string;
  originalName: string;
  storedPath: string;
  derivedFrom?: string | null;
  metadata?: Record<string, unknown>;
}

/** Register a file by content hash. Re-registering the same bytes returns the existing source. */
export async function registerSource(db: Db, input: SourceInput): Promise<{ id: string; created: boolean }> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO sensei_source (sha256, kind, course_id, title, original_name, stored_path, derived_from, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (sha256) DO NOTHING
     RETURNING id`,
    [
      input.sha256, input.kind, input.courseId, input.title, input.originalName, input.storedPath,
      input.derivedFrom ?? null, JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const { rows } = await db.query<{ id: string }>('SELECT id FROM sensei_source WHERE sha256 = $1', [input.sha256]);
  return { id: rows[0].id, created: false };
}

export async function linkLectureSource(db: Db, lectureId: string, sourceId: string): Promise<void> {
  await db.query(
    `INSERT INTO sensei_lecture_source (lecture_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [lectureId, sourceId],
  );
}

/** Insert units for a source; existing (source, kind, ordinal) rows are kept as-is. */
export async function insertUnits(db: Db, sourceId: string, units: SourceUnitInput[]): Promise<SourceUnit[]> {
  for (const u of units) {
    await db.query(
      `INSERT INTO sensei_source_unit
         (source_id, kind, ordinal, page_no, start_ms, end_ms, speaker, slide_no, text, uncertain_terms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source_id, kind, ordinal) DO NOTHING`,
      [
        sourceId, u.kind, u.ordinal, u.pageNo ?? null, u.startMs ?? null, u.endMs ?? null,
        u.speaker ?? null, u.slideNo ?? null, u.text, u.uncertainTerms ?? [],
      ],
    );
  }
  return loadUnits(db, sourceId);
}

export async function loadUnits(db: Db, sourceId: string): Promise<SourceUnit[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM sensei_source_unit WHERE source_id = $1 ORDER BY kind, ordinal`,
    [sourceId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    sourceId: r.source_id as string,
    kind: r.kind as 'page' | 'segment',
    ordinal: r.ordinal as number,
    pageNo: r.page_no as number | null,
    startMs: r.start_ms as number | null,
    endMs: r.end_ms as number | null,
    speaker: r.speaker as string | null,
    slideNo: r.slide_no as number | null,
    text: r.text as string,
    uncertainTerms: (r.uncertain_terms as string[]) ?? [],
  }));
}

export async function startRun(db: Db, lectureId: string, promptVersion: string, model: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sensei_extraction_run (lecture_id, prompt_version, model) VALUES ($1, $2, $3) RETURNING id`,
    [lectureId, promptVersion, model],
  );
  return rows[0].id;
}

export async function finishRun(db: Db, runId: string, error?: string): Promise<void> {
  await db.query(
    `UPDATE sensei_extraction_run SET status = $2, error = $3, finished_at = now() WHERE id = $1`,
    [runId, error ? 'failed' : 'succeeded', error ?? null],
  );
}

// ---------------------------------------------------------------------------
// Concepts
// ---------------------------------------------------------------------------

export interface ConceptCandidate {
  id: string;
  canonicalName: string;
  normalizedName: string;
  kind: string;
  shortDefinition: string | null;
}

export interface ResolveConceptInput {
  name: string;
  aliases?: string[];
  kind?: ConceptKind;
  shortDefinition?: string | null;
  /** Existing concept the extraction model says this is (it saw the candidate's name + definition in context). */
  existingId?: string | null;
}

export interface ResolvedConcept {
  id: string;
  created: boolean;
  /** Existing concepts that look similar but were not merged automatically (A6). */
  possibleDuplicates: string[];
}

async function conceptById(db: Db, id: string): Promise<ConceptCandidate | null> {
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM sensei_concept WHERE id = $1', [id]);
  return rows[0] ? toCandidate(rows[0]) : null;
}

function toCandidate(r: Record<string, unknown>): ConceptCandidate {
  return {
    id: r.id as string,
    canonicalName: r.canonical_name as string,
    normalizedName: r.normalized_name as string,
    kind: r.kind as string,
    shortDefinition: (r.short_definition as string | null) ?? null,
  };
}

export async function addAliases(db: Db, conceptId: string, aliases: string[]): Promise<void> {
  for (const alias of aliases) {
    const normalized = normalizeTerm(alias);
    if (!normalized) continue;
    await db.query(
      `INSERT INTO sensei_concept_alias (concept_id, alias, normalized_alias) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [conceptId, alias, normalized],
    );
  }
}

/**
 * Attach to an existing concept, or create one. Order of trust:
 * 1. the model's explicit `existingId` (it saw the candidate in context), unless the pair is a known confusable;
 * 2. exact canonical-name match;
 * 3. an unambiguous alias (see aliasCanAutoAttach) that points at exactly one concept.
 * A confusable pair (FiO2/PaO2…) is checked across every name and alias on both sides.
 * Anything else creates a new concept; trigram look-alikes are linked as possible duplicates, never merged.
 */
export async function resolveConcept(db: Db, input: ResolveConceptInput): Promise<ResolvedConcept> {
  const normalized = normalizeTerm(input.name);
  if (!normalized) throw new Error(`Empty concept name: "${input.name}"`);
  const aliases = (input.aliases ?? []).filter((a) => normalizeTerm(a) !== normalized);

  const attach = async (concept: ConceptCandidate): Promise<ResolvedConcept> => {
    await addAliases(db, concept.id, aliases);
    if (concept.normalizedName !== normalized) await addAliases(db, concept.id, [input.name]);
    if (!concept.shortDefinition && input.shortDefinition) {
      await db.query('UPDATE sensei_concept SET short_definition = $2 WHERE id = $1 AND short_definition IS NULL', [
        concept.id, input.shortDefinition,
      ]);
    }
    return { id: concept.id, created: false, possibleDuplicates: [] };
  };

  const inputNames = [input.name, ...aliases];
  /** True if any name of the existing concept and any name of the input form a known confusable pair. */
  const confusable = async (concept: ConceptCandidate) => {
    const { rows } = await db.query<{ alias: string }>(
      'SELECT alias FROM sensei_concept_alias WHERE concept_id = $1',
      [concept.id],
    );
    const existingNames = [concept.canonicalName, ...rows.map((r) => r.alias)];
    return existingNames.some((a) => inputNames.some((b) => isNeverMergePair(a, b)));
  };

  if (input.existingId) {
    const existing = await conceptById(db, input.existingId);
    if (existing && !(await confusable(existing))) return attach(existing);
  }

  const byName = await db.query<Record<string, unknown>>('SELECT * FROM sensei_concept WHERE normalized_name = $1', [
    normalized,
  ]);
  if (byName.rows[0]) return attach(toCandidate(byName.rows[0]));

  const byAlias = await db.query<Record<string, unknown>>(
    `SELECT DISTINCT c.* FROM sensei_concept_alias a JOIN sensei_concept c ON c.id = a.concept_id
     WHERE a.normalized_alias = $1`,
    [normalized],
  );
  const aliasHits: ConceptCandidate[] = [];
  for (const c of byAlias.rows.map(toCandidate)) if (!(await confusable(c))) aliasHits.push(c);
  if (aliasHits.length === 1 && aliasCanAutoAttach(input.name)) return attach(aliasHits[0]);

  const created = await db.query<{ id: string }>(
    `INSERT INTO sensei_concept (canonical_name, normalized_name, kind, short_definition)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (normalized_name) DO UPDATE SET normalized_name = EXCLUDED.normalized_name
     RETURNING id`,
    [input.name.trim(), normalized, input.kind ?? 'term', input.shortDefinition ?? null],
  );
  const id = created.rows[0].id;
  await addAliases(db, id, aliases);

  const lookalikes = await db.query<{ id: string; canonical_name: string }>(
    `SELECT id, canonical_name FROM sensei_concept
     WHERE id <> $1 AND similarity(normalized_name, $2) > 0.55`,
    [id, normalized],
  );
  const possibleDuplicates: string[] = [];
  // Exact alias hits we refused to auto-attach (ambiguous/short) are the likeliest duplicates.
  for (const hit of aliasHits) {
    await addRelation(db, hit.id, id, 'possible_duplicate', []);
    possibleDuplicates.push(hit.id);
  }
  for (const row of lookalikes.rows) {
    if (possibleDuplicates.includes(row.id)) continue;
    if (isNeverMergePair(row.canonical_name, input.name)) continue;
    await addRelation(db, row.id, id, 'possible_duplicate', []);
    possibleDuplicates.push(row.id);
  }
  return { id, created: true, possibleDuplicates };
}

export async function addRelation(
  db: Db,
  from: string,
  to: string,
  type: RelationType,
  evidenceRecordIds: string[],
): Promise<void> {
  if (from === to) return;
  await db.query(
    `INSERT INTO sensei_concept_relation (from_concept, to_concept, type, evidence_record_ids)
     VALUES ($1, $2, $3, $4::uuid[])
     ON CONFLICT (from_concept, to_concept, type) DO UPDATE
       SET evidence_record_ids = ARRAY(
         SELECT DISTINCT unnest(sensei_concept_relation.evidence_record_ids || EXCLUDED.evidence_record_ids))`,
    [from, to, type, evidenceRecordIds],
  );
}

// ---------------------------------------------------------------------------
// Records & evidence
// ---------------------------------------------------------------------------

export interface RecordInput {
  conceptId: string;
  type: RecordType;
  statement: string;
  context?: string | null;
  verification: 'unverified' | 'fidelity_ok' | 'flagged';
  verificationNotes?: string[];
  lectureId: string;
}

export function recordContentKey(conceptId: string, statement: string): string {
  return sha256(`${conceptId}\n${normalizeStatement(statement)}`);
}

/** Upsert a record by content key. A reproduced fact keeps its id; a stricter verification never gets loosened. */
export async function upsertRecord(db: Db, input: RecordInput): Promise<{ id: string; created: boolean }> {
  const key = recordContentKey(input.conceptId, input.statement);
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO sensei_knowledge_record
       (concept_id, content_key, type, statement, context, verification, verification_notes, first_lecture_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (content_key) DO NOTHING
     RETURNING id`,
    [
      input.conceptId, key, input.type, input.statement, input.context ?? null, input.verification,
      input.verificationNotes ?? [], input.lectureId,
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const { rows } = await db.query<{ id: string }>(
    `UPDATE sensei_knowledge_record
        SET superseded_at = NULL,
            verification = CASE
              WHEN verification IN ('human_confirmed','rejected') THEN verification
              WHEN $2 = 'flagged' THEN 'flagged'
              ELSE verification END,
            verification_notes = ARRAY(SELECT DISTINCT unnest(verification_notes || $3::text[]))
      WHERE content_key = $1
      RETURNING id`,
    [key, input.verification, input.verificationNotes ?? []],
  );
  return { id: rows[0].id, created: false };
}

export async function addEvidence(
  db: Db,
  e: { recordId: string; unitId: string; lectureId: string; runId: string; quote: string },
): Promise<void> {
  await db.query(
    `INSERT INTO sensei_record_evidence (record_id, unit_id, lecture_id, run_id, quote)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [e.recordId, e.unitId, e.lectureId, e.runId, e.quote],
  );
}

export async function linkRecords(db: Db, from: string, to: string, type: 'extends' | 'contradicts'): Promise<void> {
  if (from === to) return;
  await db.query(
    `INSERT INTO sensei_record_link (from_record, to_record, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [from, to, type],
  );
}

/**
 * After a successful run for a lecture: evidence from earlier runs of the same
 * lecture is superseded by this run's rows (reproduced facts keep their record
 * id, so cross-lecture links survive), and records left with
 * no live evidence anywhere are superseded. Nothing is deleted.
 */
export async function supersedeStale(db: Db, lectureId: string, runId: string): Promise<{ evidence: number; records: number }> {
  const ev = await db.query<{ id: string }>(
    `UPDATE sensei_record_evidence old SET superseded_at = now()
      WHERE old.lecture_id = $1 AND old.run_id <> $2 AND old.superseded_at IS NULL
      RETURNING old.id`,
    [lectureId, runId],
  );
  return { evidence: ev.rows.length, records: await supersedeOrphans(db) };
}

/** Records left with no live evidence anywhere are superseded (never deleted). */
export async function supersedeOrphans(db: Db): Promise<number> {
  const rec = await db.query<{ id: string }>(
    `UPDATE sensei_knowledge_record r SET superseded_at = now()
      WHERE r.superseded_at IS NULL
        AND r.verification NOT IN ('human_confirmed')
        AND NOT EXISTS (SELECT 1 FROM sensei_record_evidence e WHERE e.record_id = r.id AND e.superseded_at IS NULL)
      RETURNING r.id`,
  );
  return rec.rows.length;
}
