'use client';

/**
 * Tiny data layer: cached GETs with stale-while-revalidate, refresh on focus,
 * optional polling. No new dependency (DECISIONS A12).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { ConceptDetail, GlossaryEntry, LectureDigest, LectureSummary, LectureUnitView, TermLink } from '@/lib/sensei/queries';
import type { SenseiAnswer } from '@/lib/sensei/ask';

export type { ConceptDetail, GlossaryEntry, LectureDigest, LectureSummary, LectureUnitView, TermLink, SenseiAnswer };

export interface Course {
  id: string;
  code: string;
  title: string;
  color: string | null;
  schedule: { id: string; weekday: number; start: string; end: string }[];
}

export interface Job {
  id: string;
  status: 'queued' | 'running' | 'failed' | 'needs_course';
  step: string | null;
  progress: number;
  detail: string | null;
  error: string | null;
  files: string[];
  title: string | null;
}

export interface TodayData {
  lectures: LectureSummary[];
  digest: LectureDigest | null;
  flagged: {
    recordId: string; conceptId: string; conceptName: string; statement: string; notes: string[];
    quote: string | null; startMs: number | null; audioSourceId: string | null; lectureTitle: string | null;
  }[];
  stats: { concepts: number; facts: number; lectures: number; due: number; newCards: number; activeDays: number; reviewedToday: number };
  jobs: Job[];
  week: { date: string; concepts: number }[];
  courses: Course[];
  hasKey: boolean;
  system: { workerAlive: boolean; workerSeen: boolean; update: { state: string; message: string; at: string } | null };
}

export interface ReviewCard {
  id: string;
  conceptId: string;
  conceptName: string;
  competency: 'recall' | 'explain' | 'calculate' | 'apply';
  front: string;
  back: string;
  isNew: boolean;
  intervals: Record<1 | 2 | 3 | 4, string>;
}

export interface LectureView extends LectureDigest {
  summary: string | null;
  units: LectureUnitView[];
  audioSourceId: string | null;
}

const cache = new Map<string, unknown>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  listeners.forEach((l) => l());
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/sensei/${path}`, {
    ...init,
    headers: { ...(init?.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

/** Invalidate cached GETs whose path starts with any prefix (or all). */
export function invalidate(...prefixes: string[]) {
  for (const key of [...cache.keys()]) {
    if (prefixes.length === 0 || prefixes.some((p) => key.startsWith(p))) cache.delete(key);
  }
  bump();
}

export function useApi<T>(path: string | null, opts: { pollMs?: number | ((data: T | undefined) => number) } = {}) {
  const v = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => 0,
  );
  const [data, setData] = useState<T | undefined>(() => (path ? (cache.get(path) as T | undefined) : undefined));
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (!path || inflight.current) return;
    inflight.current = true;
    try {
      const d = await api<T>(path);
      cache.set(path, d);
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inflight.current = false;
    }
  }, [path]);

  useEffect(() => {
    if (!path) return;
    const cached = cache.get(path) as T | undefined;
    if (cached !== undefined) setData(cached);
    void load();
  }, [path, load, v]);

  useEffect(() => {
    const onFocus = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const pollMs = typeof opts.pollMs === 'function' ? opts.pollMs(data) : opts.pollMs;
  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => void load(), pollMs);
    return () => clearInterval(t);
  }, [pollMs, load]);

  return { data, error, reload: load };
}

export function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

export function relDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const then = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((today - then) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Date(then).toLocaleDateString(undefined, { weekday: 'long' });
  return fmtDate(iso);
}

export const COURSE_COLORS = ['#0A84FF', '#30B0C7', '#34C759', '#FF9500', '#FF2D55', '#AF52DE', '#5856D6', '#A2845E'];

/** Turn a pipeline verification note into a sentence for the student. */
export function humanNote(note: string): string {
  let m: RegExpMatchArray | null;
  if ((m = note.match(/^transcript uncertain about "(.+)"$/))) return `Sensei wasn’t sure it heard “${m[1]}” correctly.`;
  if (note === 'numbers differ from an earlier lecture') return 'An earlier class gave a different number.';
  if ((m = note.match(/^(?:second listen: )?number (\S+).* not found in source$/))) return `The number ${m[1]} doesn’t match what was said.`;
  if (/unit mismatch/.test(note)) return 'The units don’t match what was said.';
  if (note.startsWith('second listen')) return 'A second listen didn’t match.';
  return note;
}
