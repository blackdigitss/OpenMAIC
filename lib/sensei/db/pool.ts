import { Pool } from 'pg';

import { senseiConfig } from '../config';
import { runMigrations } from './migrations';
import type { Db } from './types';

const globalForSensei = globalThis as unknown as { __senseiPool?: Pool; __senseiMigrated?: Promise<void> };

/** Process-wide pool (survives Next dev hot reloads). Migrations run once per process on first use. */
export async function senseiDb(): Promise<Db> {
  if (!globalForSensei.__senseiPool) {
    globalForSensei.__senseiPool = new Pool({ connectionString: senseiConfig().databaseUrl, max: 5 });
  }
  const pool = globalForSensei.__senseiPool;
  globalForSensei.__senseiMigrated ??= (async () => {
    const client = await pool.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
    }
  })();
  await globalForSensei.__senseiMigrated;
  return pool as unknown as Db;
}

export async function closeSenseiDb(): Promise<void> {
  await globalForSensei.__senseiPool?.end();
  globalForSensei.__senseiPool = undefined;
  globalForSensei.__senseiMigrated = undefined;
}
