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
  deckCoverage,
  listModules,
  listTextbooks,
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
import { isPushEndpoint } from '@/lib/sensei/push';
import { notifyStudent, vapidFromEnv } from '@/lib/sensei/notify';
import { getSettings, setSetting } from '@/lib/sensei/settings';
import { monthSpend } from '@/lib/sensei/budget';
import { activeWeights, spacingStatus } from '@/lib/sensei/spacing';
import { briefProvider } from '@/lib/sensei/brief';

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
        // Tonight's focus is the latest class session; a deck alone shows until a session exists.
        const latest = lectures.find((l) => l.status === 'ready' && l.kind === 'session') ?? lectures.find((l) => l.status === 'ready');
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
          coverage: latest?.kind === 'session' ? await deckCoverage(db, latest.id) : null,
          reel: latest
            ? await db
                .query<Record<string, unknown>>(`SELECT id, title, status, duration_ms, chapters, clip_hash FROM sensei_reel WHERE key = $1`, [`lecture:${latest.id}`])
                .then((r) => (r.rows[0] ? { id: r.rows[0].id, title: r.rows[0].title, status: r.rows[0].status, durationMs: r.rows[0].duration_ms, chapters: r.rows[0].chapters, v: r.rows[0].clip_hash } : null))
            : null,
          flagged: await flaggedForReview(db, 3),
          stats: await stats(db),
          jobs: jobs.map((j) => ({
            ...j,
            files: (JSON.parse((j.files as string) ?? '[]') as string[]).map((f) => basename(f).replace(/^\d+-/, '')),
          })),
          week: week.map((w) => ({ date: w.lecture_date, concepts: Number(w.concepts) })),
          courses: await courses(),
          module:
            (await listModules(db)).find((m) => {
              const t = new Date().toISOString().slice(0, 10);
              return m.start <= t && t <= m.end;
            }) ?? null,
          hasKey: Boolean(senseiConfig().googleApiKey),
          system: await systemStatus(),
          budget: await budgetStatus(db),
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
        const w = await activeWeights(db);
        return ok(cards.map((c) => ({ ...c, intervals: previewIntervals(c.memory, new Date(), w) })));
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
      case 'textbooks':
        return ok(await listTextbooks(db));
      case 'modules':
        return ok(await listModules(db));
      case 'calc': {
        const { unlockedFormulas } = await import('@/lib/sensei/calc/unlock');
        const { FORMULAS } = await import('@/lib/sensei/calc/formulas');
        const unlocked = await unlockedFormulas(db);
        return ok(
          FORMULAS.map((f) => {
            const u = unlocked.find((x) => x.formula.id === f.id);
            return { id: f.id, name: f.name, unlocked: !!u, conceptId: u?.conceptId ?? null, conceptName: u?.conceptName ?? null };
          }),
        );
      }
      case 'board': {
        const { boardReadiness } = await import('@/lib/sensei/board/readiness');
        const { OUTLINE_SOURCE } = await import('@/lib/sensei/board/outline');
        return ok({ ...(await boardReadiness(db)), source: OUTLINE_SOURCE });
      }
      case 'cases': {
        const { unlockedCases } = await import('@/lib/sensei/cases/unlock');
        const { CASE_FAMILIES } = await import('@/lib/sensei/cases/families');
        const unlocked = await unlockedCases(db);
        return ok(CASE_FAMILIES.map((f) => ({ id: f.id, name: f.name, unlocked: unlocked.some((u) => u.family.id === f.id) })));
      }
      case 'budget':
        return ok({ ...(await monthSpend()), budgetUsd: (await getSettings(db)).budgetUsd });
      case 'settings': {
        const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM sensei_push_subscription');
        const { getState } = await import('@/lib/sensei/settings');
        return ok({
          ...(await getSettings(db)),
          pushDevices: Number(rows[0].n),
          pushKey: vapidFromEnv()?.keys.publicKey ?? null,
          lastBackup: await getState(db, 'lastBackup'),
          restoreCheck: await getState(db, 'restoreCheck'),
        });
      }
      case 'audio':
        return streamAudio(req, id);
      case 'spacing':
        return ok(await spacingStatus(db));
      case 'reels': {
        if (id && UUID.test(id)) {
          const { rows } = await db.query<{ file: string | null }>(`SELECT file FROM sensei_reel WHERE id = $1 AND status = 'ready'`, [id]);
          if (!rows[0]?.file) return fail(404, 'Reel not ready');
          return streamFile(req, rows[0].file, 'audio/mp4');
        }
        const { rows } = await db.query<Record<string, unknown>>(
          `SELECT id, key, title, status, duration_ms, chapters, total, dropped, clip_hash, updated_at FROM sensei_reel ORDER BY updated_at DESC LIMIT 50`,
        );
        return ok(rows.map((r) => ({ id: r.id, key: r.key, title: r.title, status: r.status, durationMs: r.duration_ms, chapters: r.chapters, total: r.total, dropped: r.dropped, v: r.clip_hash })));
      }
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
          const body = (await req.json()) as { names: string[]; roles?: Record<string, string>; courseCode?: string; lastModified?: number };
          const files: string[] = [];
          const roles: Record<string, string> = {};
          for (const name of body.names) {
            const safe = basename(name).replace(/[^\w.\- ]+/g, '_');
            const part = join(dir, `${safe}.part`);
            const final = join(dir, safe);
            await rename(part, final);
            files.push(final);
            const role = body.roles?.[name];
            if (role === 'slides' || role === 'textbook' || role === 'recording') roles[final] = role;
          }
          const audio = files.find((f) => !/\.(pdf|txt|vtt|srt)$/i.test(f));
          const recordedAt = (audio && (await recordedAtFromFile(audio))) || body.lastModified || Date.now();
          const onlyBooks = files.every((f) => roles[f] === 'textbook');
          const job = await enqueueLecture(db, { files, roles, courseCode: body.courseCode || null, recordedAt, bookOnly: onlyBooks });
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
        const body = (await req.json()) as { cardId: string; rating: Rating; at?: string };
        if (!UUID.test(body.cardId) || ![1, 2, 3, 4].includes(body.rating)) return fail(400, 'Bad review');
        // Ratings made offline arrive later with the time they were made (up to two weeks back, never ahead).
        const at = body.at ? new Date(body.at) : new Date();
        if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 60_000 || Date.now() - at.getTime() > 14 * 86_400_000) return fail(400, 'Bad review time');
        const { rows: exists } = await db.query('SELECT 1 FROM sensei_card WHERE id = $1', [body.cardId]);
        if (!exists[0]) return fail(404, 'Card not found');
        return ok(await reviewCard(db, body.cardId, body.rating, at));
      }
      case 'concept': {
        // POST /concept/<id>/durability { value: 'core' | 'module' } — the student's call wins.
        const body = (await req.json()) as { value: 'core' | 'module' };
        if (!id || !UUID.test(id) || action !== 'durability' || !['core', 'module'].includes(body.value)) return fail(400, 'Bad request');
        await db.query(`UPDATE sensei_concept SET durability = $2, durability_by = 'user' WHERE id = $1`, [id, body.value]);
        return ok({ ok: true });
      }
      case 'modules': {
        const body = (await req.json()) as { id: string; start: string; end: string };
        if (!UUID.test(body.id) || !/^\d{4}-\d{2}-\d{2}$/.test(body.start) || !/^\d{4}-\d{2}-\d{2}$/.test(body.end)) return fail(400, 'Bad dates');
        await db.query(`UPDATE sensei_module SET start_date = $2, end_date = $3, dates_estimated = false WHERE id = $1`, [body.id, body.start, body.end]);
        return ok(await listModules(db));
      }
      case 'settings': {
        const body = (await req.json()) as Record<string, unknown>;
        const allowed: Record<string, (v: unknown) => boolean> = {
          digestTime: (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
          notify: (v) => typeof v === 'object' && v !== null && Object.values(v).every((x) => typeof x === 'boolean'),
          budgetUsd: (v) => typeof v === 'number' && v >= 1 && v <= 1000,
          pauseAtBudget: (v) => typeof v === 'boolean',
          personalSpacing: (v) => typeof v === 'boolean',
        };
        for (const [k, v] of Object.entries(body)) {
          if (!allowed[k]?.(v)) return fail(400, `Bad setting ${k}`);
          await setSetting(db, k, v);
        }
        return ok(await getSettings(db));
      }
      case 'reels': {
        // POST /reels/request { key: 'module:<id>' | 'weak' | 'lecture:<id>', title }
        const body = (await req.json()) as { key?: string; title?: string };
        if (!body.key || !/^(lecture:[0-9a-f-]{36}|module:[0-9a-f-]{36}|weak)$/.test(body.key)) return fail(400, 'Bad reel');
        const { requestReel } = await import('@/lib/sensei/reels/build');
        await requestReel(db, body.key, String(body.title ?? 'Key moments').slice(0, 120));
        return ok({ ok: true });
      }
      case 'push': {
        if (id === 'subscribe') {
          const body = (await req.json()) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
          if (!body.endpoint || !isPushEndpoint(body.endpoint) || !body.keys?.p256dh || !body.keys?.auth) return fail(400, 'Bad subscription');
          await db.query(
            `INSERT INTO sensei_push_subscription (endpoint, keys, user_agent) VALUES ($1, $2, $3)
             ON CONFLICT (endpoint) DO UPDATE SET keys = EXCLUDED.keys, failures = 0`,
            [body.endpoint, JSON.stringify({ p256dh: body.keys.p256dh, auth: body.keys.auth }), req.headers.get('user-agent')?.slice(0, 200) ?? null],
          );
          return ok({ ok: true });
        }
        if (id === 'unsubscribe') {
          const body = (await req.json()) as { endpoint?: string };
          await db.query('DELETE FROM sensei_push_subscription WHERE endpoint = $1', [body.endpoint ?? '']);
          return ok({ ok: true });
        }
        if (id === 'test') {
          const n = await notifyStudent(db, 'test', { title: 'Sensei', body: 'Notifications are on. You’ll hear from me tonight.', tag: 'test' });
          return n > 0 ? ok({ delivered: n }) : fail(502, 'No device received it. Re-enable notifications on this iPhone.');
        }
        return fail(404, 'Unknown push action');
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
        return ok(await askSensei(db, geminiLlm(config, undefined, briefProvider(db)), question, body.conceptId && UUID.test(body.conceptId) ? body.conceptId : null));
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

async function budgetStatus(db: Awaited<ReturnType<typeof senseiDb>>) {
  const [spend, settings] = await Promise.all([monthSpend(), getSettings(db)]);
  return {
    spent: spend.total,
    budget: settings.budgetUsd,
    projected: spend.projected,
    paused: settings.pauseAtBudget && spend.total >= settings.budgetUsd,
  };
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
  const ext = path.split('.').pop()?.toLowerCase();
  return streamFile(req, path, ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : 'audio/mp4');
}

/** Serve a local file with HTTP Range support (iOS seeks with ranges). */
async function streamFile(req: NextRequest, path: string, type: string) {
  const size = (await stat(path)).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
  if (range && (range[1] || range[2])) {
    // "bytes=-N" is the last N bytes; unsatisfiable ranges get 416, not a crash.
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!range[1]) end = size - 1;
    if (start >= size || start > end) {
      return new NextResponse(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    }
    start = Math.max(0, start);
    end = Math.max(start, end);
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

