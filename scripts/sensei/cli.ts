/**
 * Sensei admin CLI.
 *   tsx scripts/sensei/cli.ts migrate
 *   tsx scripts/sensei/cli.ts add <file...> --course RESP101 [--date 2026-09-23] [--title "..."] [--role slides|textbook|recording]
 *   tsx scripts/sensei/cli.ts course <CODE> "<Title>" [--color "#0A84FF"]
 *   tsx scripts/sensei/cli.ts schedule <CODE> <weekday 0-6> <HH:MM> <HH:MM>
 *   tsx scripts/sensei/cli.ts reprocess <lectureId>
 *   tsx scripts/sensei/cli.ts stats
 *   tsx scripts/sensei/cli.ts backup
 */
import { loadEnv } from './env';
import { execFile } from 'child_process';
import { mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { promisify } from 'util';

loadEnv();

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { senseiConfig } = await import('@/lib/sensei/config');
  const { senseiDb, closeSenseiDb } = await import('@/lib/sensei/db/pool');
  const db = await senseiDb();
  switch (cmd) {
    case 'migrate':
      console.log('Schema up to date.');
      break;
    case 'course': {
      const color = flag(args, 'color');
      const { ensureCourse } = await import('@/lib/sensei/store');
      const id = await ensureCourse(db, args[0], args[1] ?? args[0]);
      await db.query('UPDATE sensei_course SET title = $2, color = COALESCE($3, color) WHERE id = $1', [id, args[1] ?? args[0], color ?? null]);
      console.log(`Course ${args[0]} ready.`);
      break;
    }
    case 'schedule': {
      const [code, weekday, start, end] = args;
      await db.query(
        `INSERT INTO sensei_schedule (course_id, weekday, start_time, end_time)
         SELECT id, $2, $3, $4 FROM sensei_course WHERE code = $1`,
        [code, Number(weekday), start, end],
      );
      console.log(`Scheduled ${code} on day ${weekday} ${start}–${end}.`);
      break;
    }
    case 'add': {
      const course = flag(args, 'course');
      const date = flag(args, 'date');
      const title = flag(args, 'title');
      const role = flag(args, 'role'); // slides | textbook | recording
      const { enqueueLecture } = await import('@/lib/sensei/jobs');
      const files = args.map((f) => resolve(f));
      const roles = role ? Object.fromEntries(files.map((f) => [f, role])) : null;
      const job = await enqueueLecture(db, { files, courseCode: course, date, title, roles, bookOnly: role === 'textbook' });
      console.log(`Queued job ${job.jobId} (${job.status}). The worker will pick it up.`);
      break;
    }
    case 'reprocess': {
      const { processLecture } = await import('@/lib/sensei/pipeline');
      const { geminiLlm } = await import('@/lib/sensei/llm');
      const { briefProvider } = await import('@/lib/sensei/brief');
      const report = await processLecture(db, geminiLlm(undefined, undefined, briefProvider(db)), args[0], {
        onProgress: (d, n) => process.stdout.write(`\r${d}/${n} windows`),
      });
      console.log('\n', report);
      break;
    }
    case 'retranscribe': {
      // Hear a class again with the current transcriber, and rebuild its facts.
      const { retranscribeLecture } = await import('@/lib/sensei/jobs');
      const job = await retranscribeLecture(db, args[0]);
      console.log(job ? `Queued job ${job}; the worker will transcribe it again.` : 'No job found for that lecture.');
      break;
    }
    case 'drills': {
      // Lab drills for one lecture, or every processed lecture ('all').
      const { generateLabDrills } = await import('@/lib/sensei/drills');
      const { senseiLlm } = await import('@/lib/sensei/llm');
      const { briefProvider } = await import('@/lib/sensei/brief');
      const llm = senseiLlm(undefined, undefined, briefProvider(db));
      const { rows } = await db.query<{ id: string; title: string }>(
        args[0] === 'all' ? `SELECT id, title FROM sensei_lecture WHERE status = 'ready' ORDER BY lecture_date` : 'SELECT id, title FROM sensei_lecture WHERE id = $1',
        args[0] === 'all' ? [] : [args[0]],
      );
      for (const l of rows) console.log(l.title, await generateLabDrills(db, llm, l.id));
      break;
    }
    case 'lesson-voice': {
      // Record narration for lessons built before the lesson voice existed ('all' or a classroom id).
      // Run from the live app folder so OpenMAIC's classroom store resolves to the real data.
      const { readClassroom, persistClassroom, CLASSROOMS_DIR } = await import('@/lib/server/classroom-storage');
      const { generateTTSForClassroom } = await import('@/lib/server/classroom-media-generation');
      const { readdir } = await import('fs/promises');
      const pub = process.env.SENSEI_PUBLIC_URL;
      if (!pub) throw new Error('SENSEI_PUBLIC_URL is not set');
      const ids = args[0] === 'all' ? (await readdir(CLASSROOMS_DIR)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [args[0]];
      for (const id of ids) {
        const c = await readClassroom(id);
        if (!c) continue;
        const speech = c.scenes.flatMap((s) => (s as { actions?: { type: string; audioUrl?: string }[] }).actions ?? []).filter((a) => a.type === 'speech');
        if (speech.length && speech.every((a) => a.audioUrl)) {
          console.log(`${id}: already has narration`);
          continue;
        }
        const coverage = await generateTTSForClassroom(c.scenes, id, pub.replace(/\/$/, ''));
        await persistClassroom({ id, stage: c.stage, scenes: c.scenes }, pub.replace(/\/$/, ''));
        console.log(`${id}: narration`, coverage);
      }
      break;
    }
    case 'notify': {
      // Used by the shell scripts (updater, backup): cli.ts notify failures "message"
      const { notifyStudent } = await import('@/lib/sensei/notify');
      const kind = (['failures', 'budget', 'digest', 'test'].includes(args[0]) ? args[0] : 'failures') as 'failures';
      const n = await notifyStudent(db, kind, { title: 'Sensei', body: args.slice(1).join(' ') || args[0], tag: kind });
      console.log(`Delivered to ${n} device(s).`);
      break;
    }
    case 'push-keys': {
      // One-time: create the VAPID key pair used to sign notifications.
      const { generateVapidKeys } = await import('@/lib/sensei/push');
      const k = generateVapidKeys();
      console.log(`SENSEI_VAPID_PUBLIC=${k.publicKey}\nSENSEI_VAPID_PRIVATE=${k.privateKey}`);
      break;
    }
    case 'board-tags': {
      // Tag concepts that predate board tagging, and create any calc/case cards now unlocked.
      const { backfillBoardTags } = await import('@/lib/sensei/board/tagging');
      const { geminiLlm } = await import('@/lib/sensei/llm');
      const { syncCalcCards } = await import('@/lib/sensei/calc/unlock');
      const { syncCaseCards } = await import('@/lib/sensei/cases/unlock');
      const { briefProvider } = await import('@/lib/sensei/brief');
      console.log(`Tagged ${await backfillBoardTags(db, geminiLlm(undefined, undefined, briefProvider(db)))} concepts; +${await syncCalcCards(db)} calc and +${await syncCaseCards(db)} case cards.`);
      break;
    }
    case 'spacing': {
      // Check personal spacing now instead of waiting for the weekly check.
      const { maybeTuneSpacing, spacingStatus } = await import('@/lib/sensei/spacing');
      const run = await maybeTuneSpacing(db, new Date(), true);
      console.log(run ?? `Collecting data (${(await spacingStatus(db)).collected}/300 first reviews).`);
      break;
    }
    case 'import-questions': {
      // A practice-question PDF → multiple-choice review cards, checked against your course facts.
      const { importPracticeQuestions } = await import('@/lib/sensei/practice');
      const { senseiLlm } = await import('@/lib/sensei/llm');
      const { briefProvider } = await import('@/lib/sensei/brief');
      const report = await importPracticeQuestions(db, senseiLlm(undefined, undefined, briefProvider(db)), resolve(args[0]), flag(args, 'label') ?? 'practice questions');
      console.log(report);
      break;
    }
    case 'textbook-pages': {
      // One-time for textbooks indexed before printed pages existed.
      const { setPrintedPages } = await import('@/lib/sensei/ingest');
      const { rows } = await db.query<{ id: string; title: string }>(`SELECT id, title FROM sensei_source WHERE kind = 'textbook'`);
      for (const r of rows) console.log(`${r.title}: ${await setPrintedPages(db, r.id)} pages numbered`);
      break;
    }
    case 'stats': {
      const { stats } = await import('@/lib/sensei/queries');
      console.log(await stats(db));
      break;
    }
    case 'backup': {
      // Nightly (launchd 3:30). Once every 28 days, or with --verify, also prove it restores.
      const config = senseiConfig();
      const { backup, restoreCheck } = await import('@/lib/sensei/backup');
      const { getState, setState } = await import('@/lib/sensei/settings');
      const { file } = await backup(db, config);
      await setState(db, 'lastBackup', { at: new Date().toISOString(), file });
      console.log(`Backed up to ${file}`);
      // A failed check is retried nightly until it passes.
      const last = await getState<{ at: string; ok: boolean }>(db, 'restoreCheck');
      if (args.includes('--verify') || !last?.ok || Date.now() - Date.parse(last.at) > 28 * 86_400_000) {
        const updating = await promisify(execFile)('pgrep', ['-f', 'sensei/ops/update.sh']).then(() => true, () => false);
        if (updating && !args.includes('--verify')) {
          console.log('Restore check skipped: an update is running; will run tomorrow.');
          break;
        }
        const result = await restoreCheck(db, config);
        await setState(db, 'restoreCheck', result);
        console.log(result.ok ? `Restore check passed (${result.dump}).` : `Restore check FAILED: ${result.problems.join('; ')}`);
        if (!result.ok) {
          const { notifyStudent } = await import('@/lib/sensei/notify');
          await notifyStudent(db, 'failures', { title: 'Backup check failed', body: result.problems.join('; ').slice(0, 180), tag: 'backup' });
        }
      }
      break;
    }
    default:
      console.log('Commands: migrate | course | schedule | add | reprocess | stats | backup [--verify] | notify | push-keys | board-tags');
  }
  await closeSenseiDb();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
