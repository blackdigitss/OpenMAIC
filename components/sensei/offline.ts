'use client';

/**
 * Offline support (DECISIONS V18): the service worker keeps the last copy of every
 * screen you opened; this file keeps review ratings made without a connection and
 * sends them, in order and with their original time, once you're back online.
 */
import { useEffect, useSyncExternalStore } from 'react';

const KEY = 'sensei.pendingRatings';

interface PendingRating {
  cardId: string;
  rating: 1 | 2 | 3 | 4;
  at: string;
}

function readQueue(): PendingRating[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as PendingRating[];
  } catch {
    return [];
  }
}

function writeQueue(q: PendingRating[]) {
  try {
    if (q.length) localStorage.setItem(KEY, JSON.stringify(q));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: ratings stay in memory for this session only */
  }
}

type Sent =
  | { outcome: 'done'; body: { remediated?: string[] } }
  | { outcome: 'rejected' }
  | { outcome: 'retry'; status: number | null };

/** One attempt. Always carries the rating's own time, so a replay of the same rating is ignored by the server. */
async function send(item: PendingRating): Promise<Sent> {
  const res = await fetch('/api/sensei/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(item),
  }).catch(() => null);
  if (!res) return { outcome: 'retry', status: null };
  if (res.ok)
    return {
      outcome: 'done',
      body: (await res.json().catch(() => ({}))) as { remediated?: string[] },
    };
  // Only a rating the server refuses outright is final; an expired code (401), rate limit or a
  // restarting/asleep Mac (5xx) keeps it waiting.
  if (res.status === 400 || res.status === 404) return { outcome: 'rejected' };
  return { outcome: 'retry', status: res.status };
}

/** Save a rating now, or keep it on the device and send it later. */
export async function postRating(
  cardId: string,
  rating: 1 | 2 | 3 | 4,
): Promise<{ remediated?: string[]; queued?: boolean; needsCode?: boolean }> {
  const item: PendingRating = { cardId, rating, at: new Date().toISOString() };
  // Keep order: older waiting ratings go first.
  if (readQueue().length && navigator.onLine) await flushRatings();
  if (readQueue().length || !navigator.onLine) {
    writeQueue([...readQueue(), item]);
    return { queued: true };
  }
  const r = await send(item);
  if (r.outcome === 'done') return r.body;
  if (r.outcome === 'rejected') throw new Error('Rating rejected');
  writeQueue([...readQueue(), item]);
  return { queued: true, needsCode: r.status === 401 };
}

let flushing = false;

/** Send waiting ratings in order. Stops at the first failure and tries again later. */
export async function flushRatings(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (;;) {
      const next = readQueue()[0];
      if (!next) break;
      const r = await send(next);
      if (r.outcome === 'retry') break;
      // Remove exactly the one we sent: ratings may have been added while it was in flight.
      const q = readQueue();
      if (q[0]?.cardId === next.cardId && q[0].at === next.at) writeQueue(q.slice(1));
      sent++;
    }
  } finally {
    flushing = false;
  }
  return sent;
}

/** Cards rated on this device that the server hasn't heard about yet (hidden from a saved review list). */
export function pendingCardIds(): Set<string> {
  return new Set(readQueue().map((r) => r.cardId));
}

export function pendingRatings(): number {
  return readQueue().length;
}

/** Tracks the connection; flushes waiting ratings whenever it comes back. */
export function useOnline(): boolean {
  const online = useSyncExternalStore(
    (l) => {
      window.addEventListener('online', l);
      window.addEventListener('offline', l);
      return () => {
        window.removeEventListener('online', l);
        window.removeEventListener('offline', l);
      };
    },
    () => navigator.onLine,
    () => true,
  );
  useEffect(() => {
    if (!online) return;
    void flushRatings();
    // Also retry on return to the app and every 30 s while anything is waiting (e.g. after a 401 or a restart).
    const onVisible = () => document.visibilityState === 'visible' && void flushRatings();
    document.addEventListener('visibilitychange', onVisible);
    const t = setInterval(() => pendingRatings() > 0 && void flushRatings(), 30_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(t);
    };
  }, [online]);
  return online;
}

/** Register the service worker (it also handles notifications) so screens you've opened work offline. */
export function useServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator) || location.hostname === 'localhost') return;
    navigator.serviceWorker
      .register('/sensei-sw.js', { scope: '/sensei', updateViaCache: 'none' })
      .catch(() => undefined);
  }, []);
}
