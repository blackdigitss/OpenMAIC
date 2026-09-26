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
  const reference = refLines.length ? `\n\nTEXTBOOK REFERENCE — the program's ground truth; use to fill gaps and deepen explanations, cite as "(textbook p. N)":\n${refLines.join('\n')}` : '';
  const notes = `COURSE NOTES — the slides are the foundation; "said in class" items are the professor's spoken additions (explanations, emphasis, stories).\n${lines.join('\n')}${reference}`.slice(0, 70_000);

  const d = digest.lecture;
  const emphasis = digest.emphasis.map((e) => `"${e.statement}"`).slice(0, 8);
  const earlier = digest.reinforced.filter((c) => c.firstSeen).slice(0, 8).map((c) => `${c.name} (first taught ${c.firstSeen})`);
  const x = await lessonInsights(db, lectureId, ids);
  const professor = x.instructor ?? 'your professor';
  const requirement = [
    `A ${d.courseCode} class on "${d.title}" (${d.date}) for one respiratory therapy student, about 15 minutes, taught live by ${professor}.`,
    ``,
    `WHO IS TEACHING. The teacher IS ${professor}, teaching this class right now in first person and present tense ("Look at this cylinder with me", "Here's what I want you to notice"). Never describe the class from outside ("the professor said", "in today's lecture"). Use the professor's real explanations, analogies, stories and phrases from the COURSE NOTES and the VOICE SAMPLES below as your own. Now and then step outside the moment with a knowing aside, the way a teacher replays their own lecture: "See how I kept hammering that number? That's me telling you it's on the test, don't you think?" or "Remember when I told the story about the sponge? That was about compliance." Keep asides short and natural, a few per lesson. Classmates may ask the questions real students ask; answer them as the professor.`,
    ``,
    `THE ROOM. The teacher agent is ${professor} (use that name). Add two or three classmates with distinct, realistic personalities (for example one who asks the question everyone is thinking, one who connects things to clinicals, one who gets things slightly wrong so the professor can correct them). The classmates speak in English and are studying in the same respiratory therapy program.`,
    ``,
    `CONTENT RULES. Build on the slide content in the COURSE NOTES, enriched by what the professor added in class. Do not contradict the notes; if you explain beyond them, say it's extra. Never present items marked UNCONFIRMED as fact. Stories stay stories, not rules.`,
    digest.newConcepts.length ? `New today: ${digest.newConcepts.map((c) => c.name).slice(0, 12).join(', ')}.` : '',
    earlier.length ? `Connect explicitly to earlier classes: ${earlier.join('; ')}.` : '',
    emphasis.length ? `I emphasized these (treat as likely exam material, and let the student notice the emphasis): ${emphasis.join(' ')}` : '',
    x.examHints.length ? `Exam hints I dropped in class: ${x.examHints.join(' ')}` : '',
    x.examTiming ? x.examTiming : '',
    x.board.length ? `Where this lands on the NBRC RT Exam (2027): ${x.board.join('; ')}. Mention the exam relevance briefly where it fits.` : '',
    x.disagreements.length ? `Where the textbook differs from my slides, teach my version and point out the difference: ${x.disagreements.join(' ')}` : '',
    x.procedures.length ? `Hands-on (lab) procedures in this material: ${x.procedures.join('; ')}. Walk through at least one step by step, asking the student what comes next, and name a common mistake to avoid.` : '',
    x.calcs.length ? `Calculations tied to this material: ${x.calcs.join(', ')}. Work one example out loud with realistic numbers from the notes.` : '',
    weak.length ? `The student keeps missing: ${weak.map((w) => w.canonical_name).join(', ')}. Revisit them where they connect, and include them in the quiz.` : '',
    `Use short clinical scenarios to build reasoning, and finish with a quiz.`,
    `CLOSING. End by telling the student, as the professor, what to do next in their study app (Sensei) tonight: ${x.nextSteps.join('; ')}.`,
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
  examHints: string[];
  examTiming: string | null;
  board: string[];
  disagreements: string[];
  procedures: string[];
  calcs: string[];
  voiceSamples: string[];
  nextSteps: string[];
}

/** What else Sensei knows that makes the lesson sharper: exam timing, NBRC tasks, drills, calcs, the professor's own words. */
async function lessonInsights(db: Db, lectureId: string, conceptIds: string[]): Promise<LessonInsights> {
  const { rows: mod } = await db.query<{ number: number; instructor: string | null; end_date: string; days: number }>(
    `SELECT m.number, m.instructor, m.end_date::text, (m.end_date - current_date) AS days
       FROM sensei_lecture l JOIN sensei_module m ON m.course_id = l.course_id AND l.lecture_date BETWEEN m.start_date AND m.end_date
      WHERE l.id = $1`,
    [lectureId],
  );
  const { rows: hints } = await db.query<{ statement: string }>(
    `SELECT DISTINCT r.statement FROM sensei_record_evidence e JOIN sensei_knowledge_record r ON r.id = e.record_id
      WHERE e.lecture_id = $1 AND e.superseded_at IS NULL AND r.superseded_at IS NULL AND r.type = 'exam_hint' LIMIT 6`,
    [lectureId],
  );
  const { TASKS } = await import('./board/outline');
  const { rows: board } = await db.query<{ task_code: string; n: string }>(
    `SELECT task_code, count(*) AS n FROM sensei_concept_board WHERE concept_id = ANY($1::uuid[]) GROUP BY 1 ORDER BY 2 DESC LIMIT 4`,
    [conceptIds],
  );
  const { rows: gaps } = await db.query<{ name: string; disagreement: string }>(
    `SELECT c.canonical_name AS name, t.disagreement FROM sensei_concept_textbook t JOIN sensei_concept c ON c.id = t.concept_id
      WHERE t.concept_id = ANY($1::uuid[]) AND t.disagreement IS NOT NULL AND t.disagreement <> '' LIMIT 4`,
    [conceptIds],
  );
  const { rows: drills } = await db.query<{ front: string; kind: string }>(
    `SELECT front, payload->>'kind' AS kind FROM sensei_card WHERE concept_id = ANY($1::uuid[]) AND content_key LIKE 'drill:%' AND NOT suspended`,
    [conceptIds],
  );
  const { rows: calcs } = await db.query<{ formula_id: string }>(
    `SELECT DISTINCT formula_id FROM sensei_card WHERE concept_id = ANY($1::uuid[]) AND formula_id IS NOT NULL`,
    [conceptIds],
  );
  const { formulaById } = await import('./calc/formulas');
  // The professor's voice: short verbatim quotes behind the stories, analogies, emphasis and hints.
  const { rows: quotes } = await db.query<{ quote: string }>(
    `SELECT DISTINCT e.quote FROM sensei_record_evidence e JOIN sensei_knowledge_record r ON r.id = e.record_id
       JOIN sensei_source_unit u ON u.id = e.unit_id
      WHERE e.lecture_id = $1 AND e.superseded_at IS NULL AND u.kind = 'segment'
        AND r.type IN ('anecdote','analogy','emphasis','exam_hint') AND length(e.quote) BETWEEN 25 AND 400
      LIMIT 14`,
    [lectureId],
  );
  // Same count as the Review tab: reviews due by tomorrow plus one day's batch of new cards.
  const { rows: due } = await db.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM sensei_card WHERE NOT suspended AND state <> 0 AND due <= now() + interval '1 day')
          + LEAST(15, (SELECT count(*) FROM sensei_card WHERE NOT suspended AND state = 0)) AS n`,
  );
  const m = mod[0];
  const procedures = drills.filter((x) => x.kind === 'order').map((x) => x.front.replace(/^Put the steps in order:\s*/, '')).slice(0, 4);
  const spot = drills.filter((x) => x.kind === 'mcq').length;
  const calcNames = calcs.map((c) => formulaById(c.formula_id)?.name).filter((n): n is string => !!n);
  const nextSteps = [
    `do tonight's review (${Number(due[0]?.n ?? 0)} cards are due)`,
    procedures.length ? `run the step drills (${procedures.slice(0, 2).join(', ')})` : '',
    spot ? `try the spot-the-error lab scenarios` : '',
    calcNames.length ? `practice ${calcNames.slice(0, 2).join(' and ')} in Calculations` : '',
    `listen to the key moments reel if there's a recording`,
  ].filter(Boolean);
  return {
    instructor: m?.instructor ?? null,
    examHints: hints.map((h) => `"${h.statement}"`),
    examTiming: m && m.days >= 0 ? `Module ${m.number} ends ${m.end_date} (${m.days} days away): frame what matters for that exam.` : null,
    board: board.map((b) => {
      const t = TASKS.find((x) => x.code === b.task_code);
      return t ? `${t.code} ${t.title}` : b.task_code;
    }),
    disagreements: gaps.map((g) => `${g.name}: ${g.disagreement}`),
    procedures,
    calcs: calcNames,
    voiceSamples: quotes.map((q) => q.quote.replace(/\s+/g, ' ').trim()),
    nextSteps,
  };
}
