/**
 * Tonight's lesson: build a source-grounded brief from the knowledge core and
 * submit it to OpenMAIC's own /api/generate-classroom (async job + poll). Zero
 * edits to OpenMAIC — the knowledge reaches the classroom agents through the
 * documented `requirement` + `pdfContent.text` inputs (DECISIONS D19).
 */
import type { Db } from './db/types';
import { lectureDigest, textbookPassages } from './queries';

export interface LessonBrief {
  requirement: string;
  notes: string;
  conceptIds: string[];
}

export async function buildLessonBrief(db: Db, lectureId: string): Promise<LessonBrief | null> {
  const digest = await lectureDigest(db, lectureId);
  if (!digest) return null;
  const todays = [...digest.newConcepts, ...digest.reinforced];
  // The slides are the foundation: every concept on the slides this class covered belongs in
  // tonight's lesson, whether or not the professor said it out loud.
  const { rows: onSlides } = await db.query<{ concept_id: string }>(
    `SELECT DISTINCT r.concept_id
       FROM sensei_lecture s
       JOIN sensei_lecture_source ls ON ls.lecture_id = s.id
       JOIN sensei_source d ON d.id = ls.source_id AND d.kind = 'slides'
       JOIN sensei_source_unit u ON u.source_id = d.id AND u.kind = 'page'
       JOIN sensei_record_evidence e ON e.unit_id = u.id AND e.superseded_at IS NULL
       JOIN sensei_knowledge_record r ON r.id = e.record_id AND r.superseded_at IS NULL AND r.verification <> 'rejected'
      WHERE s.id = $1 AND s.slide_from IS NOT NULL AND u.page_no BETWEEN s.slide_from AND s.slide_to`,
    [lectureId],
  );
  const ids = [...new Set([...todays.map((c) => c.id), ...onSlides.map((r) => r.concept_id)])];
  if (ids.length === 0) return null;

  const { rows: recs } = await db.query<Record<string, unknown>>(
    `SELECT c.id AS concept_id, c.canonical_name, r.type, r.statement, r.verification,
            l.title, l.lecture_date, l.kind AS lecture_kind, (e.lecture_id = $2) AS today
       FROM sensei_knowledge_record r
       JOIN sensei_concept c ON c.id = r.concept_id
       JOIN sensei_record_evidence e ON e.record_id = r.id AND e.superseded_at IS NULL
       JOIN sensei_lecture l ON l.id = e.lecture_id
      WHERE r.concept_id = ANY($1::uuid[]) AND r.superseded_at IS NULL AND r.verification NOT IN ('rejected')
      ORDER BY c.canonical_name, l.lecture_date, r.created_at`,
    [ids, lectureId],
  );
  const { rows: prereqs } = await db.query<Record<string, unknown>>(
    `SELECT DISTINCT p.canonical_name, p.short_definition, t.canonical_name AS for_name
       FROM sensei_concept_relation cr
       JOIN sensei_concept p ON p.id = cr.from_concept JOIN sensei_concept t ON t.id = cr.to_concept
      WHERE cr.type = 'prerequisite_of' AND cr.to_concept = ANY($1::uuid[]) AND NOT (cr.from_concept = ANY($1::uuid[]))`,
    [ids],
  );
  const { rows: weak } = await db.query<{ canonical_name: string }>(
    `SELECT DISTINCT c.canonical_name FROM sensei_card k JOIN sensei_concept c ON c.id = k.concept_id
      WHERE NOT k.suspended AND (k.lapses > 0 OR (k.state <> 0 AND k.due <= now()))
      ORDER BY 1 LIMIT 8`,
  );

  const lines: string[] = [];
  const seen = new Set<string>();
  let current = '';
  for (const r of recs) {
    const key = `${r.concept_id}|${r.statement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.canonical_name !== current) {
      current = r.canonical_name as string;
      lines.push(`\n## ${current}`);
    }
    const when = r.lecture_kind === 'deck' ? `slides: "${r.title}"` : r.today ? 'said in class today' : `said in an earlier class: "${r.title}"`;
    const caution = r.verification === 'flagged' ? ' [UNCONFIRMED — do not teach as fact]' : '';
    lines.push(`- (${r.type}, ${when}) ${r.statement}${caution}`);
  }
  if (prereqs.length) {
    lines.push('\n## Prerequisites to recap briefly');
    for (const p of prereqs) lines.push(`- ${p.canonical_name} (needed for ${p.for_name})${p.short_definition ? `: ${p.short_definition}` : ''}`);
  }
  // Textbook: the ground-truth reference, a page or so for each new concept (bounded).
  const refLines: string[] = [];
  let refBudget = 9_000;
  for (const c of digest.newConcepts.slice(0, 6)) {
    const [p] = await textbookPassages(db, [c.name], 1);
    if (!p || refBudget <= 0) continue;
    const text = p.text.slice(0, Math.min(1500, refBudget));
    refBudget -= text.length;
    refLines.push(`- ${c.name} — ${p.book}, p. ${p.page}: ${text}`);
  }
  const reference = refLines.length ? `\n\nTEXTBOOK REFERENCE — the program's ground truth; use to fill gaps and deepen explanations, cite as "(textbook p. N)":\n${refLines.join('\n')}` : '';
  const notes = `COURSE NOTES — the slides are the foundation; "said in class" items are the professor's spoken additions (explanations, emphasis, stories).\n${lines.join('\n')}${reference}`.slice(0, 70_000);

  const d = digest.lecture;
  const emphasis = digest.emphasis.map((e) => `"${e.statement}"`).slice(0, 8);
  const earlier = digest.reinforced.filter((c) => c.firstSeen).slice(0, 8).map((c) => `${c.name} (first taught ${c.firstSeen})`);
  const requirement = [
    `Evening review lesson for a respiratory therapy student, about 15 minutes, on today's ${d.courseCode} lecture "${d.title}" (${d.date}).`,
    `Build the lesson on the slide content in the COURSE NOTES, enriched with what the professor added in class (his explanations, emphasis and stories). Do not contradict the notes; if you add explanation beyond them, say so. Never present items marked UNCONFIRMED as fact. Present stories as stories, not rules.`,
    digest.newConcepts.length ? `New today: ${digest.newConcepts.map((c) => c.name).slice(0, 12).join(', ')}.` : '',
    earlier.length ? `Connect explicitly to earlier lectures: ${earlier.join('; ')}.` : '',
    emphasis.length ? `The instructor emphasized (likely exam material): ${emphasis.join(' ')}` : '',
    weak.length ? `Include quiz questions that also revisit concepts the student has been missing: ${weak.map((w) => w.canonical_name).join(', ')}.` : '',
    `Use short clinical scenarios to build reasoning, and finish with a quiz.`,
  ]
    .filter(Boolean)
    .join('\n');
  return { requirement, notes, conceptIds: ids };
}

export interface LessonClientOptions {
  baseUrl: string;
  accessCode?: string;
  pollMs?: number;
  timeoutMs?: number;
  onProgress?: (message: string, progress: number) => void;
}

async function accessCookie(opts: LessonClientOptions): Promise<string | undefined> {
  if (!opts.accessCode) return undefined;
  const res = await fetch(`${opts.baseUrl}/api/access-code/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: opts.accessCode }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!res.ok || !cookie) throw new Error(`Access code rejected by ${opts.baseUrl} (${res.status})`);
  return cookie;
}

/** Submit the brief to OpenMAIC and wait for the classroom URL. */
export async function generateClassroom(brief: LessonBrief, opts: LessonClientOptions): Promise<string> {
  const cookie = await accessCookie(opts);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
  const res = await fetch(`${opts.baseUrl}/api/generate-classroom`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ requirement: brief.requirement, pdfContent: { text: brief.notes, images: [] } }),
  });
  const started = (await res.json()) as { success: boolean; jobId?: string; error?: string };
  if (!res.ok || !started.jobId) throw new Error(`Lesson generation rejected: ${started.error ?? res.status}`);
  const deadline = Date.now() + (opts.timeoutMs ?? 45 * 60_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 5000));
    const poll = await fetch(`${opts.baseUrl}/api/generate-classroom/${started.jobId}`, { headers });
    const job = (await poll.json()) as {
      status: string; progress?: number; message?: string; done?: boolean; error?: string; result?: { url?: string };
    };
    opts.onProgress?.(job.message ?? job.status, job.progress ?? 0);
    if (job.done) {
      if (job.status === 'succeeded' && job.result?.url) return job.result.url;
      throw new Error(`Lesson generation failed: ${job.error ?? 'unknown error'}`);
    }
  }
  throw new Error('Lesson generation timed out');
}
