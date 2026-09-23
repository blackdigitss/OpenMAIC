/** Load .env / .env.local into process.env (shell values win), like Next does for the app. */
import { readFileSync } from 'fs';
import { join } from 'path';

export function loadEnv(dir = process.cwd()): void {
  for (const file of ['.env', '.env.local']) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || m[2] === '') continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}
