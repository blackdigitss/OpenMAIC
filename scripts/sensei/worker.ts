/**
 * Sensei worker — runs forever under launchd.
 * - Watches the Inbox folder (iCloud Drive/Files drop) and enqueues finished files.
 * - Runs queued lecture jobs one at a time.
 * Usage: pnpm exec tsx scripts/sensei/worker.ts [--once]
 */
import { loadEnv } from './env';
import { execFile } from 'child_process';
import { mkdir, readdir, rename, stat, writeFile } from 'fs/promises';
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
  const { notifyStudent } = await import('@/lib/sensei/notify');
  const { getSettings, getState, setState } = await import('@/lib/sensei/settings');
  const notify = async (kind: 'ready' | 'failed', message: string) => {
    log(message);
    if (kind === 'failed') {
      await notifyStudent(db, 'failures', { title: 'Sensei needs you', body: message, tag: 'failure' }).catch((e) => log(`push failed: ${e.message}`));
    } else if (await getState<string>(db, 'digestSentOn') === localDateString()) {
      // After tonight's summary went out, a newly finished lesson gets its own note.
      await notifyStudent(db, 'digest', { title: 'Lesson ready', body: message, tag: 'ready' }).catch((e) => log(`push failed: ${e.message}`));
    }
  };

  const { monthSpend } = await import('@/lib/sensei/budget');
  let lastBudgetCheck = 0;
  let budgetPaused = false;
  /** Every 10 minutes: warn at 80% and 100% of the monthly budget (once each per month). */
  async function checkBudget() {
    if (Date.now() - lastBudgetCheck < 10 * 60_000) return;
    lastBudgetCheck = Date.now();
    const settings = await getSettings(db);
    const spend = await monthSpend();
    const pct = spend.total / settings.budgetUsd;
    budgetPaused = settings.pauseAtBudget && pct >= 1;
    for (const level of [0.8, 1] as const) {
      const key = `budgetAlert:${spend.month}:${level}`;
      if (pct >= level && !(await getState(db, key))) {
        await setState(db, key, true);
        await notifyStudent(db, 'budget', {
          title: level === 1 ? 'Monthly AI budget reached' : 'Budget 80% used',
          body: `About $${spend.total.toFixed(2)} of your $${settings.budgetUsd} for ${spend.month}.${level === 1 ? (settings.pauseAtBudget ? ' New lectures will wait until you raise it.' : ' Sensei keeps working; change the budget in Settings.') : ''}`,
          tag: 'budget',
        }).catch((e) => log(`push failed: ${e.message}`));
      }
    }
  }

  /** One evening summary: tonight's lesson + cards due. Sent once a day at the chosen time. */
  async function maybeSendDigest() {
    const settings = await getSettings(db);
    const today = localDateString();
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm < settings.digestTime || (await getState<string>(db, 'digestSentOn')) === today) return;
    await setState(db, 'digestSentOn', today);
    const { rows: lessons } = await db.query<{ title: string }>(
      `SELECT title FROM sensei_lecture WHERE kind = 'session' AND status = 'ready' AND lecture_date >= current_date - 1
        ORDER BY lecture_date DESC, created_at DESC LIMIT 2`,
    );
    const { stats } = await import('@/lib/sensei/queries');
    const s = await stats(db);
    const cards = s.due + Math.min(s.newCards, 15);
    if (!lessons.length && cards === 0) return;
    const parts = [
      lessons.length ? `${lessons.map((l) => `“${l.title}”`).join(' and ')} lesson${lessons.length > 1 ? 's' : ''} ready` : '',
      cards ? `${cards} card${cards === 1 ? '' : 's'} to review` : '',
    ].filter(Boolean);
    await notifyStudent(db, 'digest', { title: 'Tonight in Sensei', body: parts.join(' · '), tag: 'digest' }).catch((e) => log(`push failed: ${e.message}`));
  }

  const seen = new Map<string, number>();
  // Move out of iCloud into local staging: iCloud may evict files to placeholders later,
  // and lecture audio shouldn't use iCloud storage twice. The job deletes staging once
  // the file is safely in the content-addressed library.
  const processed = join(config.home, 'staging');
  await mkdir(processed, { recursive: true });

  async function scanInbox() {
    const names = await readdir(config.inboxDir).catch(() => [] as string[]);
    for (const name of names) {
      if (name.endsWith('.icloud')) {
        // Cloud-only placeholder (".Name.m4a.icloud"): ask iCloud to download it; picked up next scan.
        await run('brctl', ['download', join(config.inboxDir, name)]).catch(() => undefined);
        continue;
      }
      if (name.startsWith('.')) continue;
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
  if (once) {
    // Single pass: two scans so the size-stability check can pass.
    await scanInbox().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));
  }
  for (;;) {
    // Heartbeat: the app shows a warning if this goes stale (worker stopped).
    await writeFile(join(config.home, 'worker-heartbeat'), new Date().toISOString()).catch(() => undefined);
    await scanInbox().catch((e) => log(`inbox scan failed: ${e.message}`));
    await maybeSendDigest().catch((e) => log(`digest failed: ${e.message}`));
    await checkBudget().catch((e) => log(`budget check failed: ${e.message}`));
    // Opt-in: hold new lectures (they stay queued) once the monthly budget is reached.
    const job = budgetPaused ? null : await claimJob(db);
    if (!job) {
      // Between lectures: build any requested reel (one per loop).
      const { buildNextReel } = await import('@/lib/sensei/reels/build');
      if (await buildNextReel(db, log).catch((e) => (log(`reel failed: ${e.message}`), false))) continue;
    }
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

function localDateString(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
