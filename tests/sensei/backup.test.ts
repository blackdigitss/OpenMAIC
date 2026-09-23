import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { commandError, compareCounts, mirrored, restoreCheck, SCRATCH_DB } from '@/lib/sensei/backup';
import { senseiConfig } from '@/lib/sensei/config';

describe('restore check', () => {
  it('reports the tool’s own error without the command line or any password', () => {
    const e = Object.assign(new Error('Command failed: pg_restore -d postgresql://me:secret@localhost/sensei_restore_check x.dump'), {
      stderr: 'pg_restore: connecting to database\npg_restore: error: could not open input file "x.dump": No such file\n',
    });
    expect(commandError(e)).toBe('pg_restore: error: could not open input file "x.dump": No such file');
    expect(commandError(new Error('Command failed: createdb postgresql://me:secret@localhost/postgres'))).toBe('Command failed: createdb postgresql://localhost/postgres');
  });

  it('reports every table whose restored count differs', () => {
    expect(compareCounts({ a: 3, b: 5 }, { a: 3, b: 5 })).toEqual([]);
    expect(compareCounts({ a: 3, b: 5 }, { a: 2 })).toEqual(['a: expected 3, restored 2', 'b: expected 5, restored missing']);
  });

  it('treats an iCloud-evicted placeholder as present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirror-'));
    await writeFile(join(dir, 'a.m4a'), 'x');
    await writeFile(join(dir, '.b.m4a.icloud'), 'x');
    expect(await mirrored(dir, 'a.m4a')).toBe(true);
    expect(await mirrored(dir, 'b.m4a')).toBe(true);
    expect(await mirrored(dir, 'c.m4a')).toBe(false);
  });

  it('refuses to run against a live database named like the scratch one, and fails cleanly with no backup', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'));
    const db = { query: async () => ({ rows: [] }) };
    const bad = { ...senseiConfig({ SENSEI_HOME: home } as unknown as NodeJS.ProcessEnv), databaseUrl: `postgresql://localhost/${SCRATCH_DB}` };
    expect((await restoreCheck(db, bad)).problems[0]).toMatch(/refusing/);
    const none = { ...senseiConfig({ SENSEI_HOME: home } as unknown as NodeJS.ProcessEnv), databaseUrl: 'postgresql://localhost/sensei' };
    const r = await restoreCheck(db, none);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['no backup found']);
  });
});
