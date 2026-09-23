/**
 * Sensei knowledge-core schema. Numbered, append-only migrations: never edit a
 * shipped migration — add a new one. Applied by `runMigrations`, which records
 * each id in `sensei_schema_migrations` and runs each migration in a transaction.
 *
 * Integrity rules the schema encodes (see Sensei/docs/DECISIONS.md):
 * - Sources, units, records and evidence are never deleted by the pipeline;
 *   reprocessing supersedes rows instead (A3).
 * - Aliases map many-to-many onto concepts; short/ambiguous aliases never
 *   auto-attach (A4).
 * - Recurrence is derived from evidence joins, so reprocessing cannot inflate it (D8).
 */

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_knowledge_core',
    sql: `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE sensei_course (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sensei_lecture (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES sensei_course(id),
  lecture_date DATE NOT NULL,
  title TEXT NOT NULL,
  -- Page range of a multi-week deck that this lecture covers (inclusive).
  slide_from INT,
  slide_to INT,
  status TEXT NOT NULL DEFAULT 'new',
  classroom_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, lecture_date, title)
);

CREATE TABLE sensei_source (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('slides','audio','transcript','handout','textbook')),
  course_id UUID REFERENCES sensei_course(id),
  title TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  -- A re-transcription is a new version of the same original (A3).
  derived_from UUID REFERENCES sensei_source(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A deck can span many lectures; a lecture can have many sources.
CREATE TABLE sensei_lecture_source (
  lecture_id UUID NOT NULL REFERENCES sensei_lecture(id),
  source_id UUID NOT NULL REFERENCES sensei_source(id),
  PRIMARY KEY (lecture_id, source_id)
);

CREATE TABLE sensei_source_unit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sensei_source(id),
  kind TEXT NOT NULL CHECK (kind IN ('page','segment')),
  ordinal INT NOT NULL,
  page_no INT,
  start_ms INT,
  end_ms INT,
  speaker TEXT,
  -- Slide this transcript segment was spoken over, when established.
  slide_no INT,
  text TEXT NOT NULL,
  uncertain_terms TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, kind, ordinal)
);

CREATE TABLE sensei_concept (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'term',
  short_definition TEXT,
  clinical_safety BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sensei_concept_name_trgm ON sensei_concept USING gin (normalized_name gin_trgm_ops);

CREATE TABLE sensei_concept_alias (
  concept_id UUID NOT NULL REFERENCES sensei_concept(id),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  PRIMARY KEY (concept_id, normalized_alias)
);
CREATE INDEX sensei_concept_alias_norm ON sensei_concept_alias (normalized_alias);

CREATE TABLE sensei_extraction_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lecture_id UUID NOT NULL REFERENCES sensei_lecture(id),
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE sensei_knowledge_record (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id UUID NOT NULL REFERENCES sensei_concept(id),
  -- sha256(concept_id + normalized statement): a rerun that reproduces the
  -- same fact reuses the same record id (A3).
  content_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  statement TEXT NOT NULL,
  context TEXT,
  provenance TEXT NOT NULL DEFAULT 'taught'
    CHECK (provenance IN ('taught','sensei_generated','external_reference')),
  verification TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification IN ('unverified','fidelity_ok','flagged','human_confirmed','rejected')),
  verification_notes TEXT[] NOT NULL DEFAULT '{}',
  first_lecture_id UUID REFERENCES sensei_lecture(id),
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sensei_record_concept ON sensei_knowledge_record (concept_id);
CREATE INDEX sensei_record_fts ON sensei_knowledge_record
  USING gin (to_tsvector('english', statement || ' ' || coalesce(context, '')));

CREATE TABLE sensei_record_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id UUID NOT NULL REFERENCES sensei_knowledge_record(id),
  unit_id UUID NOT NULL REFERENCES sensei_source_unit(id),
  lecture_id UUID NOT NULL REFERENCES sensei_lecture(id),
  run_id UUID NOT NULL REFERENCES sensei_extraction_run(id),
  quote TEXT NOT NULL,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (record_id, unit_id, run_id)
);
CREATE INDEX sensei_evidence_lecture ON sensei_record_evidence (lecture_id);

CREATE TABLE sensei_concept_relation (
  from_concept UUID NOT NULL REFERENCES sensei_concept(id),
  to_concept UUID NOT NULL REFERENCES sensei_concept(id),
  type TEXT NOT NULL CHECK (type IN (
    'prerequisite_of','related_to','causes','affects','measured_by','applied_in',
    'extends','contradicts','confused_with','possible_duplicate')),
  evidence_record_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_concept, to_concept, type),
  CHECK (from_concept <> to_concept)
);

-- Record-to-record links: a later lecture extends or contradicts an earlier fact.
CREATE TABLE sensei_record_link (
  from_record UUID NOT NULL REFERENCES sensei_knowledge_record(id),
  to_record UUID NOT NULL REFERENCES sensei_knowledge_record(id),
  type TEXT NOT NULL CHECK (type IN ('extends','contradicts')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_record, to_record, type),
  CHECK (from_record <> to_record)
);

-- Recurrence signals, kept separate (D8). Superseded evidence never counts.
CREATE VIEW sensei_concept_signals AS
SELECT
  c.id AS concept_id,
  count(DISTINCT e.lecture_id) AS lecture_count,
  count(DISTINCT l.course_id) AS course_count,
  count(DISTINCT r.id) FILTER (WHERE r.type IN ('emphasis','exam_hint')) AS emphasis_count,
  min(l.lecture_date) AS first_seen,
  max(l.lecture_date) AS last_seen,
  (SELECT count(*) FROM sensei_concept_relation cr
    WHERE (cr.from_concept = c.id OR cr.to_concept = c.id)
      AND cr.type <> 'possible_duplicate') AS relation_degree,
  (SELECT count(*) FROM sensei_concept_relation cr
    WHERE cr.from_concept = c.id AND cr.type = 'prerequisite_of') AS unlocks_count,
  c.clinical_safety
FROM sensei_concept c
LEFT JOIN sensei_knowledge_record r ON r.concept_id = c.id AND r.superseded_at IS NULL
LEFT JOIN sensei_record_evidence e ON e.record_id = r.id AND e.superseded_at IS NULL
LEFT JOIN sensei_lecture l ON l.id = e.lecture_id
GROUP BY c.id;
`,
  },
];

export interface MigrationQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Split a migration into single statements (drivers like PGlite reject multi-statement queries). */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** `db` must be a single connection (a checked-out client), not a pool: migrations use BEGIN/COMMIT. */
export async function runMigrations(db: MigrationQueryable): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS sensei_schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const { rows } = await db.query('SELECT id FROM sensei_schema_migrations');
  const applied = new Set((rows as { id: string }[]).map((r) => r.id));
  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await db.query('BEGIN');
    try {
      for (const statement of splitStatements(migration.sql)) await db.query(statement);
      await db.query('INSERT INTO sensei_schema_migrations (id) VALUES ($1)', [migration.id]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw new Error(`Sensei migration ${migration.id} failed: ${(error as Error).message}`);
    }
    ran.push(migration.id);
  }
  return ran;
}
