/**
 * Sensei runtime configuration — one place for paths, database and model routing.
 * Everything is overridable by env; defaults fit the user's Mac layout
 * (`Sensei/OpenMAIC-sensei` next to `Sensei/Library`).
 */
import { homedir } from 'os';
import { join, resolve } from 'path';

export interface SenseiConfig {
  /** Root for the source library, model cache and backups (outside the repo). */
  home: string;
  libraryDir: string;
  cacheDir: string;
  inboxDir: string;
  databaseUrl: string;
  googleApiKey: string | undefined;
  /** Bulk extraction / classification. */
  fastModel: string;
  /** Transcription and verification of flagged clinical items. */
  strongModel: string;
}

export function senseiConfig(env: NodeJS.ProcessEnv = process.env): SenseiConfig {
  const home = resolve(env.SENSEI_HOME ?? join(homedir(), 'Documents', 'Claude MacOs', 'Sensei', 'Library'));
  return {
    home,
    libraryDir: join(home, 'files'),
    cacheDir: join(home, 'cache'),
    inboxDir: resolve(env.SENSEI_INBOX ?? join(home, '..', 'Inbox')),
    databaseUrl: env.SENSEI_DATABASE_URL ?? 'postgresql://localhost:5432/sensei',
    googleApiKey: env.SENSEI_GOOGLE_API_KEY || env.GOOGLE_API_KEY || undefined,
    fastModel: env.SENSEI_MODEL_FAST ?? 'gemini-3.5-flash',
    strongModel: env.SENSEI_MODEL_STRONG ?? 'gemini-3.1-pro-preview',
  };
}
