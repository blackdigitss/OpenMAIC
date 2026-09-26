import type { Db } from './db/types';

/** Defaults for every setting the app exposes; stored values override them. */
export const SETTING_DEFAULTS = {
  /** Evening digest time, local "HH:MM". */
  digestTime: '19:00',
  /** Which pushes to send. */
  notify: { digest: true, failures: true, budget: true },
  /** Monthly AI budget in USD, and whether to hold new lectures once it's reached. */
  budgetUsd: 60,
  pauseAtBudget: false,
  /** Use spacing tuned to this student once there's enough evidence (DECISIONS V16). */
  personalSpacing: true,
  /**
   * Where audio work runs: 'local' = whisper.cpp + Kokoro on this Mac (free, uses its CPU);
   * 'cloud' = OpenAI whisper-1 + OpenAI voice (paid, no load). The other is the automatic backup.
   */
  audioEngine: 'local',
} as const;

export type Settings = {
  digestTime: string;
  notify: { digest: boolean; failures: boolean; budget: boolean };
  budgetUsd: number;
  pauseAtBudget: boolean;
  personalSpacing: boolean;
  audioEngine: 'local' | 'cloud';
};

/** The voice service reads the engine from this file (it has no database connection). */
export function audioEngineFile(home: string): string {
  return `${home}/settings/audio-engine`;
}

export async function getSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM sensei_setting');
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    ...(SETTING_DEFAULTS as unknown as Settings),
    ...stored,
    notify: { ...SETTING_DEFAULTS.notify, ...((stored.notify as object) ?? {}) },
  } as Settings;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO sensei_setting (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/** Internal state (e.g. "digest sent on 2026-09-23") kept in the same table under a "state:" prefix. */
export async function getState<T>(db: Db, key: string): Promise<T | null> {
  const { rows } = await db.query<{ value: T }>('SELECT value FROM sensei_setting WHERE key = $1', [`state:${key}`]);
  return rows[0]?.value ?? null;
}

export async function setState(db: Db, key: string, value: unknown): Promise<void> {
  await setSetting(db, `state:${key}`, value);
}
