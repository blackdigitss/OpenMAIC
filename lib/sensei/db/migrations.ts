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
  {
    id: '0002_jobs_schedule_review',
    sql: `
-- One job per lecture processing request; steps are resumable because every
-- step is idempotent and model calls are cached.
CREATE TABLE sensei_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lecture_id UUID REFERENCES sensei_lecture(id),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','needs_course')),
  step TEXT,
  progress REAL NOT NULL DEFAULT 0,
  detail TEXT,
  error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sensei_job_status ON sensei_job (status, created_at);

-- Weekly class schedule: recordings are assigned to a course by when they were made (A17).
CREATE TABLE sensei_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES sensei_course(id),
  weekday INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL
);

ALTER TABLE sensei_course ADD COLUMN color TEXT;
ALTER TABLE sensei_lecture ADD COLUMN summary TEXT;

-- Spaced repetition (FSRS). One card per concept x competency x prompt.
CREATE TABLE sensei_card (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id UUID NOT NULL REFERENCES sensei_concept(id),
  competency TEXT NOT NULL CHECK (competency IN ('recall','explain','calculate','apply')),
  content_key TEXT NOT NULL UNIQUE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  source_record_ids UUID[] NOT NULL DEFAULT '{}',
  due TIMESTAMPTZ NOT NULL DEFAULT now(),
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  reps INT NOT NULL DEFAULT 0,
  lapses INT NOT NULL DEFAULT 0,
  state INT NOT NULL DEFAULT 0,
  last_review TIMESTAMPTZ,
  suspended BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sensei_card_due ON sensei_card (due) WHERE NOT suspended;
CREATE INDEX sensei_card_concept ON sensei_card (concept_id);

CREATE TABLE sensei_review_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES sensei_card(id),
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 4),
  source TEXT NOT NULL DEFAULT 'sensei_review',
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stability_before REAL,
  retrievability REAL
);
CREATE INDEX sensei_review_log_card ON sensei_review_log (card_id, reviewed_at);

-- Human decisions on flagged records (A18): one tap confirms or rejects.
ALTER TABLE sensei_knowledge_record ADD COLUMN reviewed_at TIMESTAMPTZ;
`,
  },
  {
    id: '0003_decks_sessions_textbooks',
    sql: `
-- A lecture is either a class session (a recording) or a slide deck (the week's backbone).
ALTER TABLE sensei_lecture ADD COLUMN kind TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session','deck'));

-- Textbook/handbook pages are searched on demand with full-text search (no model calls).
CREATE INDEX sensei_unit_page_fts ON sensei_source_unit USING gin (to_tsvector('english', text)) WHERE kind = 'page';

-- Recurrence split by where a concept appeared: class sessions vs slide decks.
CREATE OR REPLACE VIEW sensei_concept_signals AS
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
  c.clinical_safety,
  count(DISTINCT e.lecture_id) FILTER (WHERE l.kind = 'session') AS session_count,
  count(DISTINCT e.lecture_id) FILTER (WHERE l.kind = 'deck') AS deck_count
FROM sensei_concept c
LEFT JOIN sensei_knowledge_record r ON r.concept_id = c.id AND r.superseded_at IS NULL
LEFT JOIN sensei_record_evidence e ON e.record_id = r.id AND e.superseded_at IS NULL
LEFT JOIN sensei_lecture l ON l.id = e.lecture_id
GROUP BY c.id;
`,
  },
  {
    id: '0004_modules_durability',
    sql: `
-- Each semester is three 5-week modules, each with its own professor and exams.
CREATE TABLE sensei_module (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES sensei_course(id),
  number INT NOT NULL,
  title TEXT NOT NULL,
  instructor TEXT,
  topics TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  dates_estimated BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (course_id, number)
);

-- Will this keep mattering after its module? "core" = keep reviewing for the long run
-- (calculations, normal values, safety, clinical practice, boards); "module" = tested in
-- this module only (e.g. industrial processes, storage infrastructure specifics).
ALTER TABLE sensei_concept ADD COLUMN durability TEXT CHECK (durability IN ('core','module'));
ALTER TABLE sensei_concept ADD COLUMN durability_by TEXT CHECK (durability_by IN ('model','user'));
ALTER TABLE sensei_concept ADD COLUMN durability_reason TEXT;

-- Per concept: which modules taught it, the effective durability, and whether it has retired.
-- A concept that comes back in a later module is core, whatever the first guess was.
CREATE VIEW sensei_concept_scope AS
WITH taught AS (
  SELECT DISTINCT r.concept_id, m.id AS module_id, m.end_date
    FROM sensei_knowledge_record r
    JOIN sensei_record_evidence e ON e.record_id = r.id AND e.superseded_at IS NULL
    JOIN sensei_lecture l ON l.id = e.lecture_id
    JOIN sensei_module m ON m.course_id = l.course_id AND l.lecture_date BETWEEN m.start_date AND m.end_date
   WHERE r.superseded_at IS NULL
)
SELECT c.id AS concept_id,
       count(DISTINCT t.module_id) AS module_count,
       max(t.end_date) AS last_module_end,
       CASE WHEN c.durability_by = 'user' THEN c.durability
            WHEN count(DISTINCT t.module_id) >= 2 THEN 'core'
            ELSE coalesce(c.durability, 'core') END AS effective_durability,
       (CASE WHEN c.durability_by = 'user' THEN c.durability
             WHEN count(DISTINCT t.module_id) >= 2 THEN 'core'
             ELSE coalesce(c.durability, 'core') END) = 'module'
         AND max(t.end_date) < current_date AS retired
  FROM sensei_concept c LEFT JOIN taught t ON t.concept_id = c.id
 GROUP BY c.id;
`,
  },
  {
    id: '0005_settings_push',
    sql: `
-- Small key/value settings the student controls from the app (budget, reminder time, toggles).
CREATE TABLE sensei_setting (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Web Push subscriptions (one per installed home-screen app).
CREATE TABLE sensei_push_subscription (
  endpoint TEXT PRIMARY KEY,
  keys JSONB NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at TIMESTAMPTZ,
  failures INT NOT NULL DEFAULT 0
);
`,
  },
  {
    id: '0006_calc_cards',
    sql: `
-- Calculation cards are generated by code (lib/sensei/calc): fresh numbers every review.
ALTER TABLE sensei_card ADD COLUMN formula_id TEXT;
`,
  },
  {
    id: '0007_board_cases',
    sql: `
-- Concepts tagged to NBRC RT Exam Portion A tasks (lib/sensei/board/outline.ts).
CREATE TABLE sensei_concept_board (
  concept_id UUID NOT NULL REFERENCES sensei_concept(id),
  task_code TEXT NOT NULL,
  PRIMARY KEY (concept_id, task_code)
);
-- Case cards are generated by code (lib/sensei/cases): a new scenario every review.
ALTER TABLE sensei_card ADD COLUMN case_family TEXT;
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
