/**
 * Nightly backup and a monthly proof that it restores (DECISIONS V17).
 * - backup(): pg_dump + row-count snapshot, 14 local dumps, iCloud Drive copy of the
 *   latest dump (+ one per month) and a mirror of every original file.
 * - restoreCheck(): restores the newest dump into a scratch database, compares row
 *   counts with that dump's snapshot, checks every original file exists in the iCloud
 *   mirror, then drops the scratch database. It never touches the live database.
 */
import { execFile } from 'child_process';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { promisify } from 'util';

import type { SenseiConfig } from './config';
import type { Db } from './db/types';

const run = promisify(execFile);

export const CORE_TABLES = [
  'sensei_course', 'sensei_lecture', 'sensei_source', 'sensei_source_unit', 'sensei_concept',
  'sensei_knowledge_record', 'sensei_record_evidence', 'sensei_concept_relation', 'sensei_card', 'sensei_review_log',
];
export const SCRATCH_DB = 'sensei_restore_check';

export function cloudBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SENSEI_BACKUP_DIR ?? join(env.HOME ?? '', 'Library/Mobile Documents/com~apple~CloudDocs/Sensei Backups');
}

export async function rowCounts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of CORE_TABLES) {
    const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`);
    out[t] = Number(rows[0].n);
  }
  return out;
}

export async function backup(db: Db, config: SenseiConfig): Promise<{ file: string }> {
  const dir = join(config.home, 'backups');
  await mkdir(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = join(dir, `sensei-${day}.dump`);
  // Counts are taken just before the dump; no writes happen at 3:30 am in practice, and the
  // check compares the restored copy against exactly these numbers.
  await writeFile(file.replace(/\.dump$/, '.counts.json'), JSON.stringify(await rowCounts(db)));
  await run('pg_dump', ['-Fc', '-f', file, config.databaseUrl]);
  const names = (await readdir(dir)).sort();
  for (const old of names.filter((f) => f.endsWith('.dump')).slice(0, -14)) {
    await rm(join(dir, old));
    await rm(join(dir, old.replace(/\.dump$/, '.counts.json')), { force: true });
  }
  const cloud = cloudBackupDir();
  await mkdir(join(cloud, 'database'), { recursive: true });
  await copyFile(file, join(cloud, 'database', 'sensei-latest.dump'));
  await copyFile(file, join(cloud, 'database', `sensei-${day.slice(0, 7)}.dump`));
  await run('rsync', ['-a', '--ignore-existing', `${config.libraryDir}/`, join(cloud, 'files')]);
  return { file };
}

/** Compare restored counts against the snapshot taken with the dump. */
export function compareCounts(expected: Record<string, number>, actual: Record<string, number>): string[] {
  return Object.entries(expected)
    .filter(([t, n]) => actual[t] !== n)
    .map(([t, n]) => `${t}: expected ${n}, restored ${actual[t] ?? 'missing'}`);
}

/** A file counts as mirrored if it's present, or evicted by iCloud to a ".name.icloud" placeholder. */
export async function mirrored(mirrorDir: string, name: string): Promise<boolean> {
  const exists = (p: string) => stat(p).then(() => true, () => false);
  return (await exists(join(mirrorDir, name))) || (await exists(join(mirrorDir, `.${name}.icloud`)));
}

export interface RestoreResult {
  ok: boolean;
  at: string;
  dump: string | null;
  problems: string[];
}

export async function restoreCheck(db: Db, config: SenseiConfig): Promise<RestoreResult> {
  const at = new Date().toISOString();
  const problems: string[] = [];
  const liveDb = new URL(config.databaseUrl).pathname.replace(/^\//, '');
  if (liveDb === SCRATCH_DB) return { ok: false, at, dump: null, problems: ['refusing: scratch database name equals the live database'] };

  const dir = join(config.home, 'backups');
  const dumps = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.dump')).sort();
  const latest = dumps.at(-1);
  if (!latest) return { ok: false, at, dump: null, problems: ['no backup found'] };
  const dump = join(dir, latest);

  const scratchUrl = new URL(config.databaseUrl);
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = '/postgres';
  try {
    await run('dropdb', ['--if-exists', '--maintenance-db', adminUrl.toString(), SCRATCH_DB]);
    await run('createdb', ['--maintenance-db', adminUrl.toString(), SCRATCH_DB]);
    await run('pg_restore', ['--no-owner', '-d', scratchUrl.toString(), dump]);
    const expected = JSON.parse(await readFile(dump.replace(/\.dump$/, '.counts.json'), 'utf8').catch(() => '{}')) as Record<string, number>;
    if (!Object.keys(expected).length) problems.push('no row-count snapshot for this backup');
    const { Pool } = await import('pg');
    const scratch = new Pool({ connectionString: scratchUrl.toString(), max: 1 });
    try {
      problems.push(...compareCounts(expected, await rowCounts(scratch as unknown as Db)));
    } finally {
      await scratch.end();
    }
  } catch (e) {
    problems.push(`restore failed: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    await run('dropdb', ['--if-exists', '--maintenance-db', adminUrl.toString(), SCRATCH_DB]).catch(() => undefined);
  }

  // Every original file must exist in the iCloud mirror.
  const { rows } = await db.query<{ stored_path: string }>(`SELECT stored_path FROM sensei_source WHERE kind <> 'transcript'`);
  const mirrorDir = join(cloudBackupDir(), 'files');
  let missing = 0;
  for (const r of rows) {
    if (dirname(r.stored_path) !== config.libraryDir) continue;
    if (!(await mirrored(mirrorDir, basename(r.stored_path)))) missing++;
  }
  if (missing) problems.push(`${missing} original file(s) not yet in the iCloud mirror`);
  return { ok: problems.length === 0, at, dump: latest, problems };
}
