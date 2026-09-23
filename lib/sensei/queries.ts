/**
 * Read side for the Sensei app. Every query returns plain JSON-safe objects.
 */
import type { Db } from './db/types';
import { conceptMastery } from './learn';
import { AMBIGUOUS_ABBREVIATIONS, normalizeTerm } from './normalize';

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));
const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d == null ? null : String(d).slice(0, 10));

export interface TermLink {
  term: string;
  conceptId: string;
}

/**
 * Every unambiguous name/alias → concept, longest first, for tap-any-term
 * linking. Ambiguous abbreviations and aliases shared by several concepts are
 * left out so a tap never opens the wrong concept.
 */
export async function termDictionary(db: Db): Promise<TermLink[]> {
  const { rows } = await db.query<{ term: string; concept_id: string; n: string }>(
    `WITH names AS (
       SELECT canonical_name AS term, normalized_name AS norm, id AS concept_id FROM sensei_concept
       UNION SELECT alias, normalized_alias, concept_id FROM sensei_concept_alias)
     SELECT n.term, n.concept_id, (SELECT count(DISTINCT concept_id) FROM names m WHERE m.norm = n.norm) AS n
       FROM names n`,
  );
  const seen = new Set<string>();
  const out: TermLink[] = [];
  for (const r of rows) {
    const norm = normalizeTerm(r.term);
    if (Number(r.n) > 1 || AMBIGUOUS_ABBREVIATIONS.has(norm) || norm.replace(/\s/g, '').length < 2) continue;
    const key = `${r.term.toLowerCase()}|${r.concept_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term: r.term, conceptId: r.concept_id });
  }
  return out.sort((a, b) => b.term.length - a.term.length);
}

export interface LectureSummary {
  id: string;
  title: string;
  date: string;
  courseCode: string;
  courseTitle: string;
  courseColor: string | null;
  status: string;
  classroomUrl: string | null;
  job: { status: string; step: string | null; progress: number; detail: string | null; error: string | null } | null;
  conceptCount: number;
}

export async function listLectures(db: Db, limit = 30): Promise<LectureSummary[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT l.id, l.title, l.lecture_date, l.status, l.classroom_url, c.code, c.title AS course_title, c.color,
            j.status AS job_status, j.step, j.progress, j.detail, j.error,
            (SELECT count(DISTINCT r.concept_id) FROM sensei_record_evidence e
               JOIN sensei_knowledge_record r ON r.id = e.record_id
              WHERE e.lecture_id = l.id AND e.superseded_at IS NULL AND r.superseded_at IS NULL) AS concept_count
       FROM sensei_lecture l JOIN sensei_course c ON c.id = l.course_id
       LEFT JOIN LATERAL (SELECT * FROM sensei_job WHERE lecture_id = l.id ORDER BY created_at DESC LIMIT 1) j ON true
      ORDER BY l.lecture_date DESC, l.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    date: day(r.lecture_date)!,
    courseCode: r.code as string,
    courseTitle: r.course_title as string,
    courseColor: (r.color as string) ?? null,
    status: r.status as string,
    classroomUrl: (r.classroom_url as string) ?? null,
    job: r.job_status
      ? {
          status: r.job_status as string,
          step: (r.step as string) ?? null,
          progress: Number(r.progress),
          detail: (r.detail as string) ?? null,
          error: (r.error as string) ?? null,
        }
      : null,
    conceptCount: Number(r.concept_count),
  }));
}

export interface ConceptChip {
  id: string;
  name: string;
  shortDefinition: string | null;
  lectureCount: number;
  emphasis: number;
}

export interface LectureDigest {
  lecture: LectureSummary;
  newConcepts: ConceptChip[];
  reinforced: (ConceptChip & { firstSeen: string | null })[];
  emphasis: { recordId: string; conceptId: string; conceptName: string; statement: string; startMs: number | null }[];
  connections: { from: ConceptChip; to: ConceptChip; type: string }[];
}

export async function lectureDigest(db: Db, lectureId: string): Promise<LectureDigest | null> {
  const lectures = await listLectures(db, 500);
  const lecture = lectures.find((l) => l.id === lectureId);
  if (!lecture) return null;
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT DISTINCT c.id, c.canonical_name, c.short_definition, s.lecture_count, s.emphasis_count, s.first_seen,
            (s.first_seen = l.lecture_date) AS is_new
       FROM sensei_record_evidence e
       JOIN sensei_knowledge_record r ON r.id = e.record_id AND r.superseded_at IS NULL
       JOIN sensei_concept c ON c.id = r.concept_id
       JOIN sensei_concept_signals s ON s.concept_id = c.id
       JOIN sensei_lecture l ON l.id = e.lecture_id
      WHERE e.lecture_id = $1 AND e.superseded_at IS NULL
      ORDER BY s.emphasis_count DESC, s.lecture_count DESC`,
    [lectureId],
  );
  const chip = (r: Record<string, unknown>): ConceptChip => ({
    id: r.id as string,
    name: r.canonical_name as string,
    shortDefinition: (r.short_definition as string) ?? null,
    lectureCount: Number(r.lecture_count),
    emphasis: Number(r.emphasis_count),
  });
  const { rows: emph } = await db.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (r.id) r.id, r.statement, c.id AS concept_id, c.canonical_name, u.start_ms
       FROM sensei_record_evidence e
       JOIN sensei_knowledge_record r ON r.id = e.record_id AND r.superseded_at IS NULL
       JOIN sensei_concept c ON c.id = r.concept_id
       JOIN sensei_source_unit u ON u.id = e.unit_id
      WHERE e.lecture_id = $1 AND e.superseded_at IS NULL AND r.type IN ('emphasis','exam_hint')
        AND r.verification <> 'rejected'`,
    [lectureId],
  );
  const ids = rows.map((r) => r.id as string);
  const { rows: rel } = await db.query<Record<string, unknown>>(
    `SELECT cr.type, a.id AS a_id, a.canonical_name AS a_name, a.short_definition AS a_def,
            b.id AS b_id, b.canonical_name AS b_name, b.short_definition AS b_def
       FROM sensei_concept_relation cr
       JOIN sensei_concept a ON a.id = cr.from_concept JOIN sensei_concept b ON b.id = cr.to_concept
      WHERE cr.type <> 'possible_duplicate' AND (cr.from_concept = ANY($1::uuid[]) OR cr.to_concept = ANY($1::uuid[]))
        AND NOT (cr.from_concept = ANY($1::uuid[]) AND cr.to_concept = ANY($1::uuid[]))
      LIMIT 12`,
    [ids],
  );
  return {
    lecture,
    newConcepts: rows.filter((r) => r.is_new).map(chip),
    reinforced: rows.filter((r) => !r.is_new).map((r) => ({ ...chip(r), firstSeen: day(r.first_seen) })),
    emphasis: emph.map((r) => ({
      recordId: r.id as string,
      conceptId: r.concept_id as string,
      conceptName: r.canonical_name as string,
      statement: r.statement as string,
      startMs: (r.start_ms as number) ?? null,
    })),
    connections: rel.map((r) => ({
      type: r.type as string,
      from: { id: r.a_id as string, name: r.a_name as string, shortDefinition: (r.a_def as string) ?? null, lectureCount: 0, emphasis: 0 },
      to: { id: r.b_id as string, name: r.b_name as string, shortDefinition: (r.b_def as string) ?? null, lectureCount: 0, emphasis: 0 },
    })),
  };
}

export interface EvidenceRef {
  lectureId: string;
  lectureTitle: string;
  lectureDate: string;
  courseCode: string;
  quote: string;
  kind: 'page' | 'segment';
  startMs: number | null;
  pageNo: number | null;
  slideNo: number | null;
  audioSourceId: string | null;
}

export interface ConceptRecord {
  id: string;
  type: string;
  statement: string;
  context: string | null;
  verification: string;
  verificationNotes: string[];
  provenance: string;
  evidence: EvidenceRef[];
  links: { type: string; recordId: string; statement: string }[];
}

export interface ConceptDetail {
  id: string;
  name: string;
  kind: string;
  shortDefinition: string | null;
  aliases: string[];
  signals: { lectures: number; courses: number; emphasis: number; relations: number; unlocks: number; firstSeen: string | null; lastSeen: string | null; clinicalSafety: boolean };
  records: ConceptRecord[];
  relations: { direction: 'out' | 'in'; type: string; concept: { id: string; name: string; shortDefinition: string | null } }[];
  mastery: Awaited<ReturnType<typeof conceptMastery>>;
  cards: { total: number; due: number };
}

export async function conceptDetail(db: Db, conceptId: string): Promise<ConceptDetail | null> {
  const { rows: c } = await db.query<Record<string, unknown>>(
    `SELECT c.*, s.* FROM sensei_concept c JOIN sensei_concept_signals s ON s.concept_id = c.id WHERE c.id = $1`,
    [conceptId],
  );
  if (!c[0]) return null;
  const { rows: aliases } = await db.query<{ alias: string }>(
    'SELECT alias FROM sensei_concept_alias WHERE concept_id = $1 ORDER BY length(alias)',
    [conceptId],
  );
  const { rows: recs } = await db.query<Record<string, unknown>>(
    `SELECT r.* FROM sensei_knowledge_record r
      WHERE r.concept_id = $1 AND r.superseded_at IS NULL AND r.verification <> 'rejected'
      ORDER BY r.created_at`,
    [conceptId],
  );
  const recIds = recs.map((r) => r.id as string);
  const { rows: ev } = await db.query<Record<string, unknown>>(
    `SELECT e.record_id, e.quote, l.id AS lecture_id, l.title, l.lecture_date, co.code,
            u.kind, u.start_ms, u.page_no, u.slide_no, s.metadata->>'audioSourceId' AS audio_source_id
       FROM sensei_record_evidence e
       JOIN sensei_lecture l ON l.id = e.lecture_id JOIN sensei_course co ON co.id = l.course_id
       JOIN sensei_source_unit u ON u.id = e.unit_id JOIN sensei_source s ON s.id = u.source_id
      WHERE e.record_id = ANY($1::uuid[]) AND e.superseded_at IS NULL
      ORDER BY l.lecture_date, u.start_ms NULLS LAST, u.page_no`,
    [recIds],
  );
  const { rows: links } = await db.query<Record<string, unknown>>(
    `SELECT k.from_record, k.to_record, k.type, r.statement FROM sensei_record_link k
       JOIN sensei_knowledge_record r ON r.id = k.to_record WHERE k.from_record = ANY($1::uuid[])`,
    [recIds],
  );
  const { rows: rels } = await db.query<Record<string, unknown>>(
    `SELECT 'out' AS direction, cr.type, o.id, o.canonical_name, o.short_definition
       FROM sensei_concept_relation cr JOIN sensei_concept o ON o.id = cr.to_concept
      WHERE cr.from_concept = $1 AND cr.type <> 'possible_duplicate'
     UNION ALL
     SELECT 'in', cr.type, o.id, o.canonical_name, o.short_definition
       FROM sensei_concept_relation cr JOIN sensei_concept o ON o.id = cr.from_concept
      WHERE cr.to_concept = $1 AND cr.type <> 'possible_duplicate'`,
    [conceptId],
  );
  const { rows: cards } = await db.query<{ total: string; due: string }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE due <= now() AND NOT suspended) AS due FROM sensei_card WHERE concept_id = $1`,
    [conceptId],
  );
  const r0 = c[0];
  return {
    id: conceptId,
    name: r0.canonical_name as string,
    kind: r0.kind as string,
    shortDefinition: (r0.short_definition as string) ?? null,
    aliases: aliases.map((a) => a.alias).filter((a) => a !== r0.canonical_name),
    signals: {
      lectures: Number(r0.lecture_count),
      courses: Number(r0.course_count),
      emphasis: Number(r0.emphasis_count),
      relations: Number(r0.relation_degree),
      unlocks: Number(r0.unlocks_count),
      firstSeen: day(r0.first_seen),
      lastSeen: day(r0.last_seen),
      clinicalSafety: Boolean(r0.clinical_safety),
    },
    records: recs.map((r) => ({
      id: r.id as string,
      type: r.type as string,
      statement: r.statement as string,
      context: (r.context as string) ?? null,
      verification: r.verification as string,
      verificationNotes: (r.verification_notes as string[]) ?? [],
      provenance: r.provenance as string,
      evidence: ev
        .filter((e) => e.record_id === r.id)
        .map((e) => ({
          lectureId: e.lecture_id as string,
          lectureTitle: e.title as string,
          lectureDate: day(e.lecture_date)!,
          courseCode: e.code as string,
          quote: e.quote as string,
          kind: e.kind as 'page' | 'segment',
          startMs: (e.start_ms as number) ?? null,
          pageNo: (e.page_no as number) ?? null,
          slideNo: (e.slide_no as number) ?? null,
          audioSourceId: (e.audio_source_id as string) ?? null,
        })),
      links: links
        .filter((k) => k.from_record === r.id)
        .map((k) => ({ type: k.type as string, recordId: k.to_record as string, statement: k.statement as string })),
    })),
    relations: rels.map((r) => ({
      direction: r.direction as 'out' | 'in',
      type: r.type as string,
      concept: { id: r.id as string, name: r.canonical_name as string, shortDefinition: (r.short_definition as string) ?? null },
    })),
    mastery: await conceptMastery(db, conceptId),
    cards: { total: Number(cards[0].total), due: Number(cards[0].due) },
  };
}

export interface GlossaryEntry extends ConceptChip {
  kind: string;
  firstSeen: string | null;
  flagged: number;
}

export async function glossary(db: Db, q = '', limit = 400): Promise<GlossaryEntry[]> {
  const query = q.trim();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT c.id, c.canonical_name, c.short_definition, c.kind, s.lecture_count, s.emphasis_count, s.first_seen,
            (SELECT count(*) FROM sensei_knowledge_record r WHERE r.concept_id = c.id AND r.verification = 'flagged'
               AND r.superseded_at IS NULL) AS flagged,
            CASE WHEN $1 = '' THEN 0 ELSE greatest(
              similarity(c.normalized_name, $2),
              coalesce((SELECT max(similarity(a.normalized_alias, $2)) FROM sensei_concept_alias a WHERE a.concept_id = c.id), 0),
              CASE WHEN EXISTS (SELECT 1 FROM sensei_knowledge_record r WHERE r.concept_id = c.id AND r.superseded_at IS NULL
                AND to_tsvector('english', r.statement || ' ' || coalesce(r.context, '')) @@ plainto_tsquery('english', $1)) THEN 0.35 ELSE 0 END,
              CASE WHEN c.normalized_name LIKE '%' || $2 || '%' THEN 0.6 ELSE 0 END,
              CASE WHEN EXISTS (SELECT 1 FROM sensei_concept_alias a WHERE a.concept_id = c.id AND a.normalized_alias = $2) THEN 1 ELSE 0 END
            ) END AS score
       FROM sensei_concept c JOIN sensei_concept_signals s ON s.concept_id = c.id
      WHERE s.lecture_count > 0`,
    [query, normalizeTerm(query)],
  );
  const entries = rows
    .filter((r) => !query || Number(r.score) >= 0.3)
    .map((r) => ({
      id: r.id as string,
      name: r.canonical_name as string,
      shortDefinition: (r.short_definition as string) ?? null,
      kind: r.kind as string,
      lectureCount: Number(r.lecture_count),
      emphasis: Number(r.emphasis_count),
      firstSeen: day(r.first_seen),
      flagged: Number(r.flagged),
      score: Number(r.score),
    }));
  entries.sort((a, b) => (query ? b.score - a.score : a.name.localeCompare(b.name)));
  return entries.slice(0, limit).map(({ score: _score, ...e }) => e);
}

export interface FlaggedItem {
  recordId: string;
  conceptId: string;
  conceptName: string;
  statement: string;
  notes: string[];
  quote: string | null;
  startMs: number | null;
  audioSourceId: string | null;
  lectureTitle: string | null;
}

/** At most `limit` high-stakes flagged facts awaiting a one-tap decision (A18). */
export async function flaggedForReview(db: Db, limit = 3): Promise<FlaggedItem[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM (
     SELECT DISTINCT ON (r.id) r.id, r.statement, r.verification_notes, c.id AS concept_id, c.canonical_name,
            e.quote, u.start_ms, s.metadata->>'audioSourceId' AS audio_source_id, l.title, r.created_at
       FROM sensei_knowledge_record r
       JOIN sensei_concept c ON c.id = r.concept_id
       LEFT JOIN sensei_record_evidence e ON e.record_id = r.id AND e.superseded_at IS NULL
       LEFT JOIN sensei_source_unit u ON u.id = e.unit_id
       LEFT JOIN sensei_source s ON s.id = u.source_id
       LEFT JOIN sensei_lecture l ON l.id = e.lecture_id
      WHERE r.verification = 'flagged' AND r.superseded_at IS NULL AND r.reviewed_at IS NULL
      ORDER BY r.id, u.start_ms NULLS LAST) x
     ORDER BY x.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows
    .map((r) => ({
      recordId: r.id as string,
      conceptId: r.concept_id as string,
      conceptName: r.canonical_name as string,
      statement: r.statement as string,
      notes: (r.verification_notes as string[]) ?? [],
      quote: (r.quote as string) ?? null,
      startMs: (r.start_ms as number) ?? null,
      audioSourceId: (r.audio_source_id as string) ?? null,
      lectureTitle: (r.title as string) ?? null,
    }));
}

export async function resolveFlag(db: Db, recordId: string, decision: 'confirm' | 'reject'): Promise<void> {
  await db.query(
    `UPDATE sensei_knowledge_record SET verification = $2, reviewed_at = now() WHERE id = $1`,
    [recordId, decision === 'confirm' ? 'human_confirmed' : 'rejected'],
  );
}

export interface LectureUnitView {
  id: string;
  kind: 'page' | 'segment';
  startMs: number | null;
  endMs: number | null;
  pageNo: number | null;
  slideNo: number | null;
  speaker: string | null;
  text: string;
  uncertainTerms: string[];
}

export async function lectureTranscript(db: Db, lectureId: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT u.*, s.kind AS source_kind, s.metadata->>'audioSourceId' AS audio_source_id
       FROM sensei_lecture_source ls
       JOIN sensei_source s ON s.id = ls.source_id
       JOIN sensei_source_unit u ON u.source_id = s.id
      WHERE ls.lecture_id = $1
        AND NOT EXISTS (SELECT 1 FROM sensei_source newer WHERE newer.derived_from = s.id)
      ORDER BY u.kind DESC, u.start_ms NULLS LAST, u.page_no, u.ordinal`,
    [lectureId],
  );
  const lecture = await db.query<{ slide_from: number | null; slide_to: number | null }>(
    'SELECT slide_from, slide_to FROM sensei_lecture WHERE id = $1',
    [lectureId],
  );
  const range = lecture.rows[0];
  const units: LectureUnitView[] = rows
    .filter((r) => r.kind !== 'page' || range?.slide_from == null || ((r.page_no as number) >= range.slide_from! && (r.page_no as number) <= range.slide_to!))
    .map((r) => ({
      id: r.id as string,
      kind: r.kind as 'page' | 'segment',
      startMs: (r.start_ms as number) ?? null,
      endMs: (r.end_ms as number) ?? null,
      pageNo: (r.page_no as number) ?? null,
      slideNo: (r.slide_no as number) ?? null,
      speaker: (r.speaker as string) ?? null,
      text: r.text as string,
      uncertainTerms: (r.uncertain_terms as string[]) ?? [],
    }));
  const audioSourceId = (rows.find((r) => r.audio_source_id)?.audio_source_id as string) ?? null;
  return { units, audioSourceId };
}

export async function stats(db: Db) {
  const { rows } = await db.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM sensei_concept c JOIN sensei_concept_signals s ON s.concept_id = c.id WHERE s.lecture_count > 0) AS concepts,
            (SELECT count(*) FROM sensei_knowledge_record WHERE superseded_at IS NULL AND verification <> 'rejected') AS facts,
            (SELECT count(*) FROM sensei_lecture) AS lectures,
            (SELECT count(*) FROM sensei_card WHERE due <= now() AND NOT suspended AND state <> 0) AS due,
            (SELECT count(*) FROM sensei_card WHERE due <= now() AND NOT suspended AND state = 0) AS new_cards,
            (SELECT count(DISTINCT date(reviewed_at)) FROM sensei_review_log WHERE reviewed_at > now() - interval '7 days') AS active_days,
            (SELECT count(*) FROM sensei_review_log WHERE reviewed_at::date = current_date) AS reviewed_today`,
  );
  const r = rows[0];
  return {
    concepts: Number(r.concepts),
    facts: Number(r.facts),
    lectures: Number(r.lectures),
    due: Number(r.due),
    newCards: Number(r.new_cards),
    activeDays: Number(r.active_days),
    reviewedToday: Number(r.reviewed_today),
  };
}

export { iso };
