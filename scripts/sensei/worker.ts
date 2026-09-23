/**
 * Sensei worker — runs forever under launchd.
 * - Watches the Inbox folder (iCloud Drive/Files drop) and enqueues finished files.
 * - Runs queued lecture jobs one at a time.
 * Usage: pnpm exec tsx scripts/sensei/worker.ts [--once]
 */
import { loadEnv } from './env';
import { execFile } from 'child_process';
import { mkdir, readdir, rename, stat } from 'fs/promises';
import { basename, extname, join } from 'path';
import { promisify } from 'util';

loadEnv();

const run = promisify(execFile);
const once = process.argv.includes('--once');

async function main() {
  const { senseiConfig } = await import('@/lib/sensei/config');
  const { senseiDb } = await import('@/lib/sensei/db/pool');
  const { claimJob, enqueueLecture, recordedAtFromFile, runJob } = await import('@/lib/sensei/jobs');
  const { geminiLlm } = await import('@/lib/sensei/llm');

  const config = senseiConfig();
  const db = await senseiDb();
  const llm = geminiLlm(config);
  const appUrl = process.env.SENSEI_APP_URL ?? 'http://localhost:3000';
  const notify = async (message: string) => {
    const handle = process.env.SENSEI_NOTIFY_IMESSAGE;
    log(message);
    if (!handle) return;
    const script = `tell application "Messages" to send ${JSON.stringify(message)} to participant ${JSON.stringify(handle)} of (1st account whose service type = iMessage)`;
    await run('osascript', ['-e', script]).catch((e) => log(`iMessage failed: ${e.message}`));
  };

  const seen = new Map<string, number>();
  const processed = join(config.inboxDir, '.processed');
  await mkdir(processed, { recursive: true });

  async function scanInbox() {
    const names = await readdir(config.inboxDir).catch(() => [] as string[]);
    for (const name of names) {
      if (name.startsWith('.') || name.endsWith('.icloud')) continue;
      const path = join(config.inboxDir, name);
      const s = await stat(path).catch(() => null);
      if (!s?.isFile()) continue;
      // Wait until the size is stable across two scans (iCloud writes large files in pieces).
      if (seen.get(path) !== s.size) {
        seen.set(path, s.size);
        continue;
      }
      const ext = extname(name).toLowerCase();
      if (ext !== '.pdf' && !['.txt', '.vtt', '.srt'].includes(ext)) {
        try {
          await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
        } catch {
          continue; // not readable yet
        }
      }
      const dest = join(processed, `${Date.now()}-${basename(name)}`);
      await rename(path, dest);
      seen.delete(path);
      const recordedAt = (await recordedAtFromFile(dest)) ?? s.birthtimeMs ?? s.mtimeMs;
      const job = await enqueueLecture(db, { files: [dest], recordedAt });
      log(`inbox: ${name} → job ${job.jobId} (${job.status})`);
    }
  }

  log(`worker up · inbox ${config.inboxDir} · app ${appUrl}`);
  for (;;) {
    await scanInbox().catch((e) => log(`inbox scan failed: ${e.message}`));
    const job = await claimJob(db);
    if (job) {
      log(`job ${job.id} started`);
      await runJob({ db, llm, appUrl, accessCode: process.env.ACCESS_CODE, notify }, job)
        .then(() => log(`job ${job.id} done`))
        .catch((e) => log(`job ${job.id} failed: ${e.message}`));
      continue;
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  process.exit(0);
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
