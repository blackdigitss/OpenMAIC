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
  openaiApiKey: string | undefined;
  /** Claude Code CLI, for routes that use your Claude subscription ("claude:opus"). */
  claudeBin: string;
  /**
   * Model routes, each "provider:model" (google | openai), or a comma-separated list
   * tried in order: a provider that is out of credits or rejects the key falls
   * through to the next, so adding credits later switches back automatically.
   */
  /** Quick, mechanical work: titles, tagging, answering questions in the app. */
  fastModel: string;
  /** Work that decides what you learn: fact extraction, flashcards, textbook notes. */
  strongModel: string;
  /** Listening to class recordings (needs a model that takes audio). */
  audioModel: string;
}

export function senseiConfig(env: NodeJS.ProcessEnv = process.env): SenseiConfig {
  const home = resolve(env.SENSEI_HOME ?? join(homedir(), 'Documents', 'Claude MacOs', 'Sensei', 'Library'));
  return {
    home,
    libraryDir: join(home, 'files'),
    cacheDir: join(home, 'cache'),
    // iCloud Drive → "Sensei Inbox": Voice Memos can Save to Files there from the phone.
    inboxDir: resolve(env.SENSEI_INBOX ?? join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Sensei Inbox')),
    databaseUrl: env.SENSEI_DATABASE_URL ?? 'postgresql://localhost:5432/sensei',
    googleApiKey: env.SENSEI_GOOGLE_API_KEY || env.GOOGLE_API_KEY || undefined,
    openaiApiKey: env.SENSEI_OPENAI_API_KEY || env.OPENAI_API_KEY || undefined,
    claudeBin: env.SENSEI_CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude'),
    fastModel: env.SENSEI_MODEL_FAST || 'google:gemini-3.8-flash',
    strongModel: env.SENSEI_MODEL_STRONG || 'google:gemini-3.1-pro-preview',
    audioModel: env.SENSEI_MODEL_AUDIO || 'google:gemini-3.1-pro-preview',
  };
}
