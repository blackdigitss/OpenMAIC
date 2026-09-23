/**
 * Sensei app API — one catch-all route so the branch adds a single file under
 * app/api. Protected by the app-wide ACCESS_CODE middleware like every /api route.
 */
import { createReadStream } from 'fs';
import { appendFile, mkdir, readFile, rename, stat } from 'fs/promises';
import { basename, join } from 'path';
import { Readable } from 'stream';
import { NextRequest, NextResponse } from 'next/server';

import { askSensei } from '@/lib/sensei/ask';
import { senseiConfig } from '@/lib/sensei/config';
import { senseiDb } from '@/lib/sensei/db/pool';
import type { Rating } from '@/lib/sensei/fsrs';
import { previewIntervals } from '@/lib/sensei/fsrs';
import { enqueueLecture, recordedAtFromFile, retryJob, setJobCourse } from '@/lib/sensei/jobs';
import { dueCards, reviewCard } from '@/lib/sensei/learn';
import { geminiLlm, MissingApiKeyError } from '@/lib/sensei/llm';
import {
  conceptDetail,
  flaggedForReview,
  glossary,
  lectureDigest,
  lectureTranscript,
  listLectures,
  resolveFlag,
  stats,
  termDictionary,
} from '@/lib/sensei/queries';
import { ensureCourse } from '@/lib/sensei/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ path: string[] }> };
const ok = (data: unknown, init?: ResponseInit) => NextResponse.json(data, init);
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });
const UUID = /^[0-9a-f-]{36}$/i;

async function courses() {
  const db = await senseiDb();
  const { rows: cs } = await db.query<Record<string, unknown>>(
    `SELECT c.id, c.code, c.title, c.color,
            coalesce(json_agg(json_build_object('id', s.id, 'weekday', s.weekday, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI')) ORDER BY s.weekday, s.start_time) FILTER (WHERE s.id IS NOT NULL), '[]') AS schedule
       FROM sensei_course c LEFT JOIN sensei_schedule s ON s.course_id = c.id
      GROUP BY c.id ORDER BY c.code`,
  );
  return cs;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const [head, id] = (await ctx.params).path;
  const db = await senseiDb();
  try {
    switch (head) {
      case 'today': {
        const lectures = await listLectures(db, 12);
        const latest = lectures.find((l) => l.status === 'ready');
        const { rows: jobs } = await db.query<Record<string, unknown>>(
          `SELECT j.id, j.status, j.step, j.progress, j.detail, j.error, j.input->>'files' AS files, j.created_at, l.title
             FROM sensei_job j LEFT JOIN sensei_lecture l ON l.id = j.lecture_id
            WHERE j.status IN ('queued','running','failed','needs_course')
            ORDER BY j.created_at DESC LIMIT 5`,
        );
        const { rows: week } = await db.query<{ lecture_date: string; concepts: string }>(
          `SELECT to_char(l.lecture_date, 'YYYY-MM-DD') AS lecture_date, count(DISTINCT r.concept_id) AS concepts
             FROM sensei_lecture l
             LEFT JOIN sensei_record_evidence e ON e.lecture_id = l.id AND e.superseded_at IS NULL
             LEFT JOIN sensei_knowledge_record r ON r.id = e.record_id AND r.superseded_at IS NULL
            WHERE l.lecture_date > current_date - 7
            GROUP BY l.id ORDER BY l.lecture_date`,
        );
        return ok({
          lectures,
          digest: latest ? await lectureDigest(db, latest.id) : null,
          flagged: await flaggedForReview(db, 3),
          stats: await stats(db),
          jobs: jobs.map((j) => ({
            ...j,
            files: (JSON.parse((j.files as string) ?? '[]') as string[]).map((f) => basename(f).replace(/^\d+-/, '')),
          })),
          week: week.map((w) => ({ date: w.lecture_date, concepts: Number(w.concepts) })),
          courses: await courses(),
          hasKey: Boolean(senseiConfig().googleApiKey),
          system: await systemStatus(),
        });
      }
      case 'terms':
        return ok(await termDictionary(db), { headers: { 'cache-control': 'private, max-age=30' } });
      case 'concept': {
        if (!id || !UUID.test(id)) return fail(400, 'Bad concept id');
        const detail = await conceptDetail(db, id);
        return detail ? ok(detail) : fail(404, 'Concept not found');
      }
      case 'glossary':
        return ok(await glossary(db, req.nextUrl.searchParams.get('q') ?? ''));
      case 'lectures':
        return ok(await listLectures(db, 200));
      case 'lecture': {
        if (!id || !UUID.test(id)) return fail(400, 'Bad lecture id');
        const digest = await lectureDigest(db, id);
        if (!digest) return fail(404, 'Lecture not found');
        const { rows } = await db.query<{ summary: string | null }>('SELECT summary FROM sensei_lecture WHERE id = $1', [id]);
        return ok({ ...digest, summary: rows[0]?.summary ?? null, ...(await lectureTranscript(db, id)) });
      }
      case 'review': {
        const conceptId = req.nextUrl.searchParams.get('concept');
        const cards = await dueCards(db, { conceptId: conceptId && UUID.test(conceptId) ? conceptId : undefined });
        return ok(cards.map((c) => ({ ...c, intervals: previewIntervals(c.memory) })));
      }
      case 'weak': {
        const { rows } = await db.query<Record<string, unknown>>(
          `SELECT c.id, c.canonical_name, c.short_definition, sum(k.lapses) AS lapses
             FROM sensei_card k JOIN sensei_concept c ON c.id = k.concept_id
            WHERE k.lapses > 0 GROUP BY c.id ORDER BY sum(k.lapses) DESC LIMIT 10`,
        );
        return ok(rows.map((r) => ({ id: r.id, name: r.canonical_name, shortDefinition: r.short_definition, lapses: Number(r.lapses) })));
      }
      case 'courses':
        return ok(await courses());
      case 'audio':
        return streamAudio(req, id);
      default:
        return fail(404, 'Unknown endpoint');
    }
  } catch (error) {
    return fail(500, (error as Error).message);
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const [head, id, action] = (await ctx.params).path;
  const db = await senseiDb();
  const config = senseiConfig();
  try {
    switch (head) {
      case 'upload': {
        // Chunked upload: POST /upload/<uploadId>?name=…&offset=… with raw bytes; then POST /upload/<uploadId>/done.
        const uploadId = id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
        if (!uploadId) return fail(400, 'Bad upload id');
        const dir = join(config.home, 'uploads', uploadId);
        await mkdir(dir, { recursive: true });
        if (action === 'done') {
          const body = (await req.json()) as { names: string[]; courseCode?: string; lastModified?: number };
          const files: string[] = [];
          for (const name of body.names) {
            const safe = basename(name).replace(/[^\w.\- ]+/g, '_');
            const part = join(dir, `${safe}.part`);
            const final = join(dir, safe);
            await rename(part, final);
            files.push(final);
          }
          const audio = files.find((f) => !/\.(pdf|txt|vtt|srt)$/i.test(f));
          const recordedAt = (audio && (await recordedAtFromFile(audio))) || body.lastModified || Date.now();
          const job = await enqueueLecture(db, { files, courseCode: body.courseCode || null, recordedAt });
          return ok(job);
        }
        const name = basename(req.nextUrl.searchParams.get('name') ?? 'file').replace(/[^\w.\- ]+/g, '_');
        const offset = Number(req.nextUrl.searchParams.get('offset') ?? 0);
        const part = join(dir, `${name}.part`);
        const size = await stat(part).then((s) => s.size, () => 0);
        if (offset !== size) return ok({ received: size }, { status: 409 });
        await appendFile(part, Buffer.from(await req.arrayBuffer()));
        return ok({ received: (await stat(part)).size });
      }
      case 'job': {
        if (!id || !UUID.test(id)) return fail(400, 'Bad job id');
        const body = (await req.json().catch(() => ({}))) as { courseCode?: string };
        if (action === 'retry') await retryJob(db, id);
        else if (action === 'course' && body.courseCode) await setJobCourse(db, id, body.courseCode);
        else return fail(400, 'Unknown job action');
        return ok({ ok: true });
      }
      case 'review': {
        const body = (await req.json()) as { cardId: string; rating: Rating };
        if (!UUID.test(body.cardId) || ![1, 2, 3, 4].includes(body.rating)) return fail(400, 'Bad review');
        return ok(await reviewCard(db, body.cardId, body.rating));
      }
      case 'flag': {
        const body = (await req.json()) as { decision: 'confirm' | 'reject' };
        if (!id || !UUID.test(id) || !['confirm', 'reject'].includes(body.decision)) return fail(400, 'Bad decision');
        await resolveFlag(db, id, body.decision);
        return ok({ ok: true });
      }
      case 'ask': {
        const body = (await req.json()) as { question: string; conceptId?: string };
        const question = String(body.question ?? '').slice(0, 1000).trim();
        if (!question) return fail(400, 'Ask a question');
        return ok(await askSensei(db, geminiLlm(config), question, body.conceptId && UUID.test(body.conceptId) ? body.conceptId : null));
      }
      case 'courses': {
        const body = (await req.json()) as {
          code: string; title: string; color?: string; schedule?: { weekday: number; start: string; end: string }[];
        };
        const code = String(body.code ?? '').trim().toUpperCase();
        if (!code) return fail(400, 'Course needs a short code');
        const courseId = await ensureCourse(db, code, body.title || code);
        await db.query('UPDATE sensei_course SET title = $2, color = $3 WHERE id = $1', [courseId, body.title || code, body.color ?? null]);
        if (body.schedule) {
          await db.query('DELETE FROM sensei_schedule WHERE course_id = $1', [courseId]);
          for (const s of body.schedule) {
            await db.query(
              'INSERT INTO sensei_schedule (course_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4)',
              [courseId, s.weekday, s.start, s.end],
            );
          }
        }
        return ok(await courses());
      }
      default:
        return fail(404, 'Unknown endpoint');
    }
  } catch (error) {
    if (error instanceof MissingApiKeyError) return fail(503, 'Sensei needs its Gemini key before it can answer.');
    return fail(500, (error as Error).message);
  }
}

/** Is the worker alive, and how did the last automatic update go? */
async function systemStatus() {
  const config = senseiConfig();
  const beat = await stat(join(config.home, 'worker-heartbeat')).then((s) => s.mtimeMs, () => null);
  const update = await readFile(join(config.home, 'update-status.json'), 'utf8').then((t) => JSON.parse(t) as { state: string; message: string; at: string }, () => null);
  return { workerAlive: beat != null && Date.now() - beat < 5 * 60_000, workerSeen: beat != null, update };
}

/** Stream lecture audio with HTTP Range support so iOS can seek to a timestamp. */
async function streamAudio(req: NextRequest, sourceId?: string) {
  if (!sourceId || !UUID.test(sourceId)) return fail(400, 'Bad audio id');
  const db = await senseiDb();
  const { rows } = await db.query<{ stored_path: string; original_name: string }>(
    `SELECT stored_path, original_name FROM sensei_source WHERE id = $1 AND kind = 'audio'`,
    [sourceId],
  );
  if (!rows[0]) return fail(404, 'Audio not found');
  const path = rows[0].stored_path;
  const size = (await stat(path)).size;
  const ext = path.split('.').pop()?.toLowerCase();
  const type = ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : 'audio/mp4';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new NextResponse(stream, {
      status: 206,
      headers: {
        'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`, 'cache-control': 'private, max-age=86400',
      },
    });
  }
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new NextResponse(stream, {
    headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(size), 'cache-control': 'private, max-age=86400' },
  });
}

