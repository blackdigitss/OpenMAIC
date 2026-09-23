'use client';

/**
 * Offline support (DECISIONS V18): the service worker keeps the last copy of every
 * screen you opened; this file keeps review ratings made without a connection and
 * sends them, in order and with their original time, once you're back online.
 */
import { useEffect, useSyncExternalStore } from 'react';

import { api } from './api';

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

/** Save a rating now, or keep it for later if there's no connection. */
export async function postRating(cardId: string, rating: 1 | 2 | 3 | 4): Promise<{ remediated?: string[]; queued?: boolean }> {
  const item: PendingRating = { cardId, rating, at: new Date().toISOString() };
  // Keep order: if older ratings are still waiting, this one waits behind them.
  if (readQueue().length || !navigator.onLine) {
    writeQueue([...readQueue(), item]);
    return { queued: true };
  }
  try {
    return await api<{ remediated: string[] }>('review', { method: 'POST', body: JSON.stringify({ cardId, rating }) });
  } catch (e) {
    // fetch throws TypeError when the network is unreachable; server errors are real errors.
    if (!(e instanceof TypeError)) throw e;
    writeQueue([...readQueue(), item]);
    return { queued: true };
  }
}

let flushing = false;

/** Send waiting ratings in order. Stops at the first network failure and tries again later. */
export async function flushRatings(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (;;) {
      const [next, ...rest] = readQueue();
      if (!next) break;
      const res = await fetch('/api/sensei/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) }).catch(() => null);
      // Keep it on no connection, an expired code (401) or a server hiccup; drop only a rating the server rejects outright.
      if (!res || !(res.ok || res.status === 400 || res.status === 404 || res.status === 409)) break;
      writeQueue(rest);
      sent++;
    }
  } finally {
    flushing = false;
  }
  return sent;
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
    if (online) void flushRatings();
  }, [online]);
  return online;
}

/** Register the service worker (it also handles notifications) so screens you've opened work offline. */
export function useServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator) || location.hostname === 'localhost') return;
    navigator.serviceWorker.register('/sensei-sw.js', { scope: '/sensei', updateViaCache: 'none' }).catch(() => undefined);
  }, []);
}
