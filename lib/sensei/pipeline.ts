/**
 * Lecture → knowledge core. For each window of a lecture's units: gather
 * candidate concepts already in the core, make one structured extraction call,
 * gate every record deterministically, then write through the idempotent store.
 * A failed run leaves the previous run's knowledge live; a successful run
 * supersedes it without deleting anything.
 */
import type { Db, SourceUnit } from './db/types';
import {
  buildExtractionPrompt,
  buildWindows,
  EXTRACT_PROMPT_VERSION,
  EXTRACT_SYSTEM,
  ExtractionSchema,
  type ExtractionWindow,
  type WindowCandidate,
} from './extract';
import type { StructuredLlm } from './llm';
import { checkNumericFidelity, normalizeTerm, numericSignature, quoteAppearsIn } from './normalize';
import {
  addEvidence,
  addRelation,
  finishRun,
  linkRecords,
  loadUnits,
  resolveConcept,
  startRun,
  supersedeOrphans,
  supersedeStale,
  upsertRecord,
} from './store';

export interface LectureRunReport {
  runId: string;
  windows: number;
  recordsWritten: number;
  recordsNew: number;
  recordsFlagged: number;
  recordsRejected: { statement: string; reason: string }[];
  conceptsCreated: number;
  relations: number;
  superseded: { evidence: number; records: number };
}

/** The quoted passage within a unit, widened by ~80 characters each side (whole unit if not found). */
export function quoteWindow(unitText: string, quote: string): string {
  const hay = unitText.toLowerCase();
  const needle = quote.toLowerCase().trim().slice(0, 40);
  const at = needle ? hay.indexOf(needle) : -1;
  if (at < 0) return unitText;
  return unitText.slice(Math.max(0, at - 80), Math.min(unitText.length, at + quote.length + 80));
}

export async function lectureUnits(
  db: Db,
  lectureId: string,
): Promise<{ label: string; units: SourceUnit[]; slideContext: SourceUnit[] }> {
  const { rows: lec } = await db.query<Record<string, unknown>>(
    `SELECT l.*, c.code FROM sensei_lecture l JOIN sensei_course c ON c.id = l.course_id WHERE l.id = $1`,
    [lectureId],
  );
  if (!lec[0]) throw new Error(`Unknown lecture ${lectureId}`);
  const l = lec[0];
  const { rows: sources } = await db.query<{ source_id: string }>(
    `SELECT ls.source_id FROM sensei_lecture_source ls JOIN sensei_source s ON s.id = ls.source_id
      WHERE ls.lecture_id = $1
        -- a re-transcribed source replaces its predecessor (A3)
        AND NOT EXISTS (SELECT 1 FROM sensei_source newer WHERE newer.derived_from = s.id)
      ORDER BY s.kind, s.created_at`,
    [lectureId],
  );
  const from = (l.slide_from as number | null) ?? null;
  const to = (l.slide_to as number | null) ?? null;
  const all: SourceUnit[] = [];
  for (const { source_id } of sources) {
    for (const u of await loadUnits(db, source_id)) {
      // A multi-week deck contributes only this lecture's page range.
      if (u.kind === 'page' && from != null && to != null && (u.pageNo! < from || u.pageNo! > to)) continue;
      all.push(u);
    }
  }
  const date = l.lecture_date instanceof Date ? l.lecture_date.toISOString().slice(0, 10) : String(l.lecture_date);
  const label = `${l.code} — ${l.title} (${date})`;
  const segments = all.filter((u) => u.kind === 'segment');
  // A class session's evidence is what was said; the deck was already extracted on its own,
  // so its covered slides are context here, never counted again (DECISIONS: decks vs sessions).
  if (l.kind === 'session' && segments.length > 0) {
    let budget = 14_000;
    const slideContext = all.filter((u) => u.kind === 'page' && (budget -= u.text.length) > 0);
    return { label, units: segments, slideContext };
  }
  return { label, units: all, slideContext: [] };
}

/** Concepts already in the core whose name or alias occurs in the window text. */
export async function findCandidates(db: Db, window: ExtractionWindow, limit = 30): Promise<WindowCandidate[]> {
  const text = ` ${normalizeTerm(window.units.map((u) => u.text).join(' '))} `;
  const { rows } = await db.query<{ id: string; canonical_name: string; normalized_name: string; short_definition: string | null; aliases: string[] | null; normalized_aliases: string[] | null }>(
    `SELECT c.id, c.canonical_name, c.normalized_name, c.short_definition,
            array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL) AS aliases,
            array_agg(a.normalized_alias) FILTER (WHERE a.alias IS NOT NULL) AS normalized_aliases
       FROM sensei_concept c LEFT JOIN sensei_concept_alias a ON a.concept_id = c.id
      GROUP BY c.id`,
  );
  const hits = rows
    .map((r) => {
      const names = [r.normalized_name, ...(r.normalized_aliases ?? [])];
      const hitsCount = names.filter((n) => n && text.includes(` ${n} `)).length;
      return { r, hitsCount };
    })
    .filter((h) => h.hitsCount > 0)
    .sort((a, b) => b.hitsCount - a.hitsCount)
    .slice(0, limit);

  const candidates: WindowCandidate[] = [];
  let recordRef = 0;
  for (const [i, { r }] of hits.entries()) {
    const { rows: recs } = await db.query<{ id: string; statement: string }>(
      `SELECT id, statement FROM sensei_knowledge_record
        WHERE concept_id = $1 AND superseded_at IS NULL AND verification <> 'rejected'
        ORDER BY created_at LIMIT 6`,
      [r.id],
    );
    candidates.push({
      ref: `C${i + 1}`,
      conceptId: r.id,
      name: r.canonical_name,
      aliases: r.aliases ?? [],
      definition: r.short_definition,
      records: recs.map((x) => ({ ref: `R${++recordRef}`, recordId: x.id, statement: x.statement })),
    });
  }
  return candidates;
}

export interface ProcessOptions {
  onProgress?: (done: number, total: number) => void;
}

export async function processLecture(
  db: Db,
  llm: StructuredLlm,
  lectureId: string,
  opts: ProcessOptions = {},
): Promise<LectureRunReport> {
  const { label, units, slideContext } = await lectureUnits(db, lectureId);
  const windows = buildWindows(units);
  const runId = await startRun(db, lectureId, EXTRACT_PROMPT_VERSION, llm.modelName('fast'));
  const report: LectureRunReport = {
    runId, windows: windows.length, recordsWritten: 0, recordsNew: 0, recordsFlagged: 0,
    recordsRejected: [], conceptsCreated: 0, relations: 0, superseded: { evidence: 0, records: 0 },
  };
  await db.query(`UPDATE sensei_lecture SET status = 'processing' WHERE id = $1`, [lectureId]);
  try {
    for (const [i, window] of windows.entries()) {
      const candidates = await findCandidates(db, window);
      const extraction = await llm.call({
        schema: ExtractionSchema,
        system: EXTRACT_SYSTEM,
        prompt: buildExtractionPrompt(window, candidates, label, slideContext),
        tier: 'fast',
        purpose: 'extract',
        lectureId,
      });
      await applyExtraction(db, { lectureId, runId, window, candidates, extraction, report });
      opts.onProgress?.(i + 1, windows.length);
    }
    report.superseded = await supersedeStale(db, lectureId, runId);
    await finishRun(db, runId);
    await db.query(`UPDATE sensei_lecture SET status = 'ready' WHERE id = $1`, [lectureId]);
    return report;
  } catch (error) {
    // Partial output of a failed run must not sit alongside the last good run.
    await db.query(`UPDATE sensei_record_evidence SET superseded_at = now() WHERE run_id = $1`, [runId]);
    await supersedeOrphans(db);
    await finishRun(db, runId, (error as Error).message);
    await db.query(`UPDATE sensei_lecture SET status = 'failed' WHERE id = $1`, [lectureId]);
    throw error;
  }
}

interface ApplyArgs {
  lectureId: string;
  runId: string;
  window: ExtractionWindow;
  candidates: WindowCandidate[];
  extraction: import('./extract').Extraction;
  report: LectureRunReport;
}

export async function applyExtraction(db: Db, a: ApplyArgs): Promise<void> {
  const conceptByRef = new Map(a.candidates.map((c) => [c.ref, c]));
  const recordByRef = new Map(a.candidates.flatMap((c) => c.records.map((r) => [r.ref, r])));
  /** normalized concept name/ref → concept id, for resolving relations in this window. */
  const conceptIds = new Map<string, string>();
  for (const c of a.candidates) {
    conceptIds.set(c.ref, c.conceptId);
    conceptIds.set(normalizeTerm(c.name), c.conceptId);
  }

  for (const rec of a.extraction.records) {
    const reject = (reason: string) => a.report.recordsRejected.push({ statement: rec.statement, reason });

    // Gate 1: evidence must point at real units and quote them.
    const evidence = rec.evidence
      .map((e) => ({ unit: a.window.unitRefs.get(e.unit_ref), quote: e.quote }))
      .filter((e): e is { unit: SourceUnit; quote: string } => !!e.unit && quoteAppearsIn(e.quote, e.unit.text));
    if (evidence.length === 0) {
      reject('no verifiable evidence quote');
      continue;
    }

    // Gate 2: numbers and units must match the source exactly (A2) — checked against the
    // quoted passage plus a little context, not the whole unit, so a "15" elsewhere in a
    // long segment can't vouch for a wrong "15 cmH2O".
    const sourceText = evidence.map((e) => quoteWindow(e.unit.text, e.quote)).join('\n');
    const notes: string[] = [];
    const numeric = checkNumericFidelity(rec.statement, sourceText);
    notes.push(...numeric.problems);
    const uncertain = evidence.flatMap((e) => e.unit.uncertainTerms ?? []);
    for (const term of uncertain) {
      if (normalizeTerm(rec.statement).includes(normalizeTerm(term))) notes.push(`transcript uncertain about "${term}"`);
    }
    const verification = notes.length ? 'flagged' : 'fidelity_ok';

    const candidate = rec.concept_ref ? conceptByRef.get(rec.concept_ref) : undefined;
    const concept = await resolveConcept(db, {
      name: rec.concept_name,
      aliases: rec.concept_aliases,
      kind: rec.concept_kind,
      shortDefinition: rec.concept_short_definition,
      existingId: candidate?.conceptId ?? null,
    });
    if (concept.created) a.report.conceptsCreated++;
    conceptIds.set(normalizeTerm(rec.concept_name), concept.id);
    for (const alias of rec.concept_aliases) {
      if (!conceptIds.has(normalizeTerm(alias))) conceptIds.set(normalizeTerm(alias), concept.id);
    }

    // Duplicate handling: a "duplicate" with different numbers is a discrepancy, not a repeat (A5).
    const existing = rec.existing_record_ref ? recordByRef.get(rec.existing_record_ref) : undefined;
    let relation = existing ? rec.existing_record_relation : null;
    if (existing && relation === 'duplicate' && numericSignature(existing.statement) !== numericSignature(rec.statement)) {
      relation = 'contradicts';
      notes.push('numbers differ from an earlier lecture');
    }
    // A repeat that failed its own fidelity gate must not lend its evidence to the earlier fact.
    if (relation === 'duplicate' && notes.length > 0) relation = null;

    let recordId: string;
    if (existing && relation === 'duplicate') {
      recordId = existing.recordId;
    } else {
      const written = await upsertRecord(db, {
        conceptId: concept.id,
        type: rec.type,
        statement: rec.statement,
        context: rec.context,
        verification: notes.length ? 'flagged' : verification,
        verificationNotes: notes,
        lectureId: a.lectureId,
      });
      recordId = written.id;
      if (written.created) a.report.recordsNew++;
      if (existing && (relation === 'extends' || relation === 'contradicts')) {
        await linkRecords(db, recordId, existing.recordId, relation);
      }
    }
    if (notes.length) a.report.recordsFlagged++;
    a.report.recordsWritten++;
    for (const e of evidence) {
      await addEvidence(db, { recordId, unitId: e.unit.id, lectureId: a.lectureId, runId: a.runId, quote: e.quote });
    }
  }

  for (const rel of a.extraction.relations) {
    const from = conceptIds.get(rel.from_concept) ?? conceptIds.get(normalizeTerm(rel.from_concept));
    const to = conceptIds.get(rel.to_concept) ?? conceptIds.get(normalizeTerm(rel.to_concept));
    if (!from || !to || from === to) continue;
    await addRelation(db, from, to, rel.type, []);
    a.report.relations++;
  }
}
