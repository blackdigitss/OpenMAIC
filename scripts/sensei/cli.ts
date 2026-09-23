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
      const report = await processLecture(db, geminiLlm(), args[0], {
        onProgress: (d, n) => process.stdout.write(`\r${d}/${n} windows`),
      });
      console.log('\n', report);
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
      console.log(`Tagged ${await backfillBoardTags(db, geminiLlm())} concepts; +${await syncCalcCards(db)} calc and +${await syncCaseCards(db)} case cards.`);
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
      const config = senseiConfig();
      const dir = join(config.home, 'backups');
      await mkdir(dir, { recursive: true });
      const file = join(dir, `sensei-${new Date().toISOString().slice(0, 10)}.dump`);
      await promisify(execFile)('pg_dump', ['-Fc', '-f', file, config.databaseUrl]);
      // Keep 14 local dumps.
      const { readdir, rm, copyFile } = await import('fs/promises');
      const dumps = (await readdir(dir)).filter((f) => f.endsWith('.dump')).sort();
      for (const old of dumps.slice(0, -14)) await rm(join(dir, old));
      // Off the Mac: iCloud Drive keeps the latest dump and a mirror of every recording/slide/textbook.
      const cloud = process.env.SENSEI_BACKUP_DIR ?? join(process.env.HOME ?? '', 'Library/Mobile Documents/com~apple~CloudDocs/Sensei Backups');
      await mkdir(join(cloud, 'database'), { recursive: true });
      await copyFile(file, join(cloud, 'database', 'sensei-latest.dump'));
      await copyFile(file, join(cloud, 'database', `sensei-${new Date().toISOString().slice(0, 7)}.dump`)); // one per month
      await promisify(execFile)('rsync', ['-a', '--ignore-existing', `${config.libraryDir}/`, join(cloud, 'files')]);
      console.log(`Backed up to ${file} and ${cloud}`);
      break;
    }
    default:
      console.log('Commands: migrate | course | schedule | add | reprocess | stats | backup');
  }
  await closeSenseiDb();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
