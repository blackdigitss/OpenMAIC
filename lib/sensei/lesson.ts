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
    // Private markers guide emphasis; where a fact came from is deliberately left out
    // (the lesson teaches the material, it doesn't narrate its sources).
    const marker =
      r.verification === 'flagged'
        ? ' [UNCONFIRMED: do not teach as fact]'
        : r.type === 'exam_hint' || r.type === 'emphasis'
          ? ' [stressed in class]'
          : r.type === 'anecdote'
            ? ' [the professor\'s story]'
            : r.type === 'analogy'
              ? ' [the professor\'s analogy]'
              : '';
    lines.push(`- ${r.statement}${marker}`);
  }
  if (prereqs.length) {
    lines.push('\n## Prerequisites to recap briefly');
    for (const p of prereqs) lines.push(`- ${p.canonical_name} (needed for ${p.for_name})${p.short_definition ? `: ${p.short_definition}` : ''}`);
  }
  // Textbook: the ground-truth reference, a page or so for each new concept (bounded).
  const refLines: string[] = [];
  let refBudget = 9_000;
  for (const c of digest.newConcepts.slice(0, 6)) {
    if (refBudget <= 0) break;
    // Prefer the prepared "what the textbook adds" note; else a raw page.
    const { rows: gap } = await db.query<{ adds: string | null; citations: { book: string; cite: string }[] }>(
      'SELECT adds, citations FROM sensei_concept_textbook WHERE concept_id = $1 AND adds IS NOT NULL',
      [c.id],
    );
    if (gap[0]?.adds) {
      const cite = gap[0].citations.map((x) => `${x.book}, ${x.cite}`).join('; ');
      refLines.push(`- ${c.name} (${cite}): ${gap[0].adds}`);
      refBudget -= gap[0].adds.length;
      continue;
    }
    const [p] = await textbookPassages(db, [c.name], 1);
    if (!p) continue;
    const text = p.text.slice(0, Math.min(1500, refBudget));
    refBudget -= text.length;
    refLines.push(`- ${c.name}, ${p.book}, ${p.cite}: ${text}`);
  }
  const reference = refLines.length ? `\n\nBACKGROUND FROM THE TEXTBOOK (for accuracy and depth; don't cite pages aloud):\n${refLines.join('\n')}` : '';
  const notes = `COURSE MATERIAL TO TEACH. Bracketed markers are private guidance; never read them out or mention them.\n${lines.join('\n')}${reference}`.slice(0, 70_000);

  const d = digest.lecture;
  const x = await lessonInsights(db, lectureId, ids);
  const isLab = /\blab\b/i.test(d.title);
  const teacher = isLab ? 'the lab instructor' : (x.instructor ?? 'the professor');
  const requirement = [
    `A 15-minute ${isLab ? 'lab' : 'lecture'} on ${d.title.replace(/^(Lab|Lecture)\s+[\d/.]+$/i, 'the material below')} for a first-year respiratory therapy student, taught live by ${teacher}${isLab ? '' : ' (the teacher agent\'s name)'}.`,
    ``,
    `TEACH, DON'T NARRATE. The teacher is ${teacher}, in the room, teaching this material right now: first person, present tense, warm and direct ("Look at this gauge with me", "Here's what I want you to notice"). Explain the ideas, give examples, check understanding. Never talk about the lesson itself: no "tonight's review", no "this lesson covers", no agenda slides, no "this was said in class" or "from an earlier lecture", no talk of modules, apps, study strategy or where facts came from.`,
    `Every so often, and briefly, the teacher steps outside the moment the way a good teacher does: "See how I keep coming back to that number? That's me telling you it's going to be on the test." Use this for items marked [stressed in class], a few times per lesson, never as a formula.`,
    `Tell the professor's stories and analogies (marked in the material) as the teacher's own, in first person. The VOICE SAMPLES show how the teacher really talks; match that tone and reuse phrases naturally.`,
    `Two or three classmates with English names and distinct personalities share the room (one asks what everyone is wondering, one relates things to clinicals, one gets something slightly wrong so the teacher can correct it). Keep their lines short and natural.`,
    ``,
    `CONTENT. Teach only what's in the COURSE MATERIAL, explained clearly and accurately; the textbook background is for depth. Do not contradict the material, and never teach items marked UNCONFIRMED as fact. Use short clinical scenarios to build reasoning.`,
    x.procedures.length ? `Walk through ${x.procedures.slice(0, 2).join(' and ')} step by step, asking the student what comes next before revealing each step, and point out the common mistake.` : '',
    x.calcs.length ? `Work one ${x.calcs[0]} example out loud with realistic numbers.` : '',
    x.disagreements.length ? `If it comes up naturally, note in one sentence where the textbook puts something differently: ${x.disagreements.slice(0, 2).join(' ')}` : '',
    weak.length ? `In the closing quiz, include questions on: ${weak.map((w) => w.canonical_name).slice(0, 4).join(', ')} (only if they fit this material).` : '',
    `Finish with a short quiz on the material.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
  const voice = x.voiceSamples.length
    ? `\n\nVOICE SAMPLES: the professor's own words in class (tone, phrasing, stories; reuse naturally, don't recite):\n${x.voiceSamples.map((q) => `- "${q}"`).join('\n')}`
    : '';
  const notesWithVoice = `${notes}${voice}`.slice(0, 75_000);
  return { requirement, notes: notesWithVoice, conceptIds: ids };
}

export interface LessonClientOptions {
  baseUrl: string;
  accessCode?: string;
  pollMs?: number;
  timeoutMs?: number;
  onProgress?: (message: string, progress: number) => void;
  /** Model for this lesson ("provider:model"); default is the server's DEFAULT_MODEL. */
  model?: string;
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

export function publicOriginHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const pub = env.SENSEI_PUBLIC_URL;
  if (!pub) return {};
  const u = new URL(pub);
  return { 'x-forwarded-host': u.host, 'x-forwarded-proto': u.protocol.replace(':', '') };
}

/** Submit the brief to OpenMAIC and wait for the classroom URL. */
export async function generateClassroom(brief: LessonBrief, opts: LessonClientOptions): Promise<string> {
  const cookie = await accessCookie(opts);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
    ...(opts.model ? { 'x-model': opts.model } : {}),
    // Narration clips are saved under absolute URLs built from the request's origin;
    // build them for the public address so the phone can play them (not localhost).
    ...publicOriginHeaders(),
  };
  const res = await fetch(`${opts.baseUrl}/api/generate-classroom`, {
    method: 'POST',
    headers,
    // enableTTS: narration is recorded when the lesson is built (the local Kokoro voice),
    // instead of relying on the browser's own speech, which iOS keeps silent.
    // agentMode 'generate': the teacher and classmates are created from the requirement
    // (the professor's identity, a few classmates), instead of OpenMAIC's stock characters.
    body: JSON.stringify({ requirement: brief.requirement, pdfContent: { text: brief.notes, images: [] }, enableTTS: true, agentMode: 'generate' }),
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

interface LessonInsights {
  instructor: string | null;
  disagreements: string[];
  procedures: string[];
  calcs: string[];
  voiceSamples: string[];
}

/** Material that makes the teaching sharper: lab procedures, calculations, textbook differences, the professor's own words. */
async function lessonInsights(db: Db, lectureId: string, conceptIds: string[]): Promise<LessonInsights> {
  const { rows: mod } = await db.query<{ instructor: string | null }>(
    `SELECT m.instructor FROM sensei_lecture l JOIN sensei_module m ON m.course_id = l.course_id AND l.lecture_date BETWEEN m.start_date AND m.end_date
      WHERE l.id = $1`,
    [lectureId],
  );
  const { rows: gaps } = await db.query<{ name: string; disagreement: string }>(
    `SELECT c.canonical_name AS name, t.disagreement FROM sensei_concept_textbook t JOIN sensei_concept c ON c.id = t.concept_id
      WHERE t.concept_id = ANY($1::uuid[]) AND t.disagreement IS NOT NULL AND t.disagreement <> '' LIMIT 2`,
    [conceptIds],
  );
  const { rows: drills } = await db.query<{ front: string }>(
    `SELECT front FROM sensei_card WHERE concept_id = ANY($1::uuid[]) AND content_key LIKE 'drill:order:%' AND NOT suspended`,
    [conceptIds],
  );
  const { rows: calcs } = await db.query<{ formula_id: string }>(
    `SELECT DISTINCT formula_id FROM sensei_card WHERE concept_id = ANY($1::uuid[]) AND formula_id IS NOT NULL`,
    [conceptIds],
  );
  const { formulaById } = await import('./calc/formulas');
  // The professor's voice: short verbatim quotes behind the stories, analogies and emphasis.
  const { rows: quotes } = await db.query<{ quote: string }>(
    `SELECT DISTINCT e.quote FROM sensei_record_evidence e JOIN sensei_knowledge_record r ON r.id = e.record_id
       JOIN sensei_source_unit u ON u.id = e.unit_id
      WHERE e.lecture_id = $1 AND e.superseded_at IS NULL AND u.kind = 'segment'
        AND r.type IN ('anecdote','analogy','emphasis','exam_hint') AND length(e.quote) BETWEEN 25 AND 400
      LIMIT 14`,
    [lectureId],
  );
  return {
    instructor: mod[0]?.instructor ?? null,
    disagreements: gaps.map((g) => `${g.name}: ${g.disagreement.replace(/\s*\[T\d+\]/g, '')}`),
    procedures: drills.map((x) => x.front.replace(/^Put the steps in order:\s*/, '')).slice(0, 4),
    calcs: calcs.map((c) => formulaById(c.formula_id)?.name).filter((n): n is string => !!n),
    voiceSamples: quotes.map((q) => q.quote.replace(/\s+/g, ' ').trim()),
  };
}
