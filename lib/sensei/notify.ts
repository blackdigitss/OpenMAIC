/**
 * One place to tell the student something: Web Push to every installed Sensei
 * (iPhone/iPad home-screen apps). Respects the per-type toggles in Settings.
 */
import type { Db } from './db/types';
import { sendPush, type PushMessage, type VapidKeys } from './push';
import { getSettings } from './settings';

export type NotifyKind = 'digest' | 'failures' | 'budget' | 'test';

export function vapidFromEnv(env: NodeJS.ProcessEnv = process.env): { keys: VapidKeys; subject: string } | null {
  const publicKey = env.SENSEI_VAPID_PUBLIC;
  const privateKey = env.SENSEI_VAPID_PRIVATE;
  if (!publicKey || !privateKey) return null;
  return { keys: { publicKey, privateKey }, subject: env.SENSEI_PUBLIC_URL || 'https://sensei.walkersnotary.com' };
}

export async function notifyStudent(db: Db, kind: NotifyKind, message: PushMessage): Promise<number> {
  const vapid = vapidFromEnv();
  if (!vapid) return 0;
  if (kind !== 'test') {
    const settings = await getSettings(db);
    if (!settings.notify[kind]) return 0;
  }
  const { rows } = await db.query<{ endpoint: string; keys: { p256dh: string; auth: string } }>(
    'SELECT endpoint, keys FROM sensei_push_subscription',
  );
  let delivered = 0;
  for (const sub of rows) {
    const result = await sendPush(sub, { url: '/sensei', ...message }, vapid.keys, vapid.subject);
    if (result === 'ok') {
      delivered++;
      await db.query('UPDATE sensei_push_subscription SET last_ok_at = now(), failures = 0 WHERE endpoint = $1', [sub.endpoint]);
    } else if (result === 'gone') {
      await db.query('DELETE FROM sensei_push_subscription WHERE endpoint = $1', [sub.endpoint]);
    } else {
      await db.query('UPDATE sensei_push_subscription SET failures = failures + 1 WHERE endpoint = $1', [sub.endpoint]);
    }
  }
  return delivered;
}
