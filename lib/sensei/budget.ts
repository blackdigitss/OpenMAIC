/**
 * Monthly AI spend, priced from OpenMAIC's own usage log (data/usage/YYYY-MM.jsonl),
 * which records every model call — Sensei's and OpenMAIC's lesson generation alike.
 * Sensei calls are tagged `sensei:<purpose>[:<lectureId>]`.
 */
import { readUsageRecords, type UsageRecord } from '@/lib/server/usage-storage';

import { callCost, priceFor } from './pricing';

export const PURPOSE_LABEL: Record<string, string> = {
  transcribe: 'Transcribing recordings',
  extract: 'Reading slides and lectures',
  verify: 'Double-checking numbers',
  summarize: 'Summaries',
  cards: 'Review cards',
  cases: 'Case practice',
  ask: 'Ask Sensei',
  gaps: 'Textbook gap-filling',
  reels: 'Professor reels',
  lessons: 'Tonight’s lessons (OpenMAIC)',
  other: 'Other',
};

export function purposeOf(source: string): string {
  if (!source.startsWith('sensei:')) return 'lessons';
  const p = source.split(':')[1];
  if (p === 'fast' || p === 'strong') return 'other';
  return PURPOSE_LABEL[p] ? p : 'other';
}

export interface MonthSpend {
  month: string;
  total: number;
  byPurpose: { purpose: string; label: string; usd: number }[];
  /** Projected spend for the whole month at the current daily pace (null until 3 days of data). */
  projected: number | null;
  daysWithData: number;
  unknownModels: string[];
}

export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function summarize(records: UsageRecord[], now = new Date()): MonthSpend {
  const by = new Map<string, number>();
  const days = new Set<string>();
  const unknown = new Set<string>();
  let total = 0;
  for (const r of records) {
    if (r.kind && r.kind !== 'llm') continue;
    const purpose = purposeOf(r.source);
    const usd = callCost(r.modelId, r.inputTokens, r.outputTokens, purpose === 'transcribe' || purpose === 'verify');
    if (!priceFor(r.modelId).known) unknown.add(r.modelId);
    by.set(purpose, (by.get(purpose) ?? 0) + usd);
    total += usd;
    days.add(new Date(r.createdAt).toISOString().slice(0, 10));
  }
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    month: monthKey(now),
    total,
    byPurpose: [...by.entries()]
      .map(([purpose, usd]) => ({ purpose, label: PURPOSE_LABEL[purpose] ?? purpose, usd }))
      .sort((a, b) => b.usd - a.usd),
    projected: dayOfMonth >= 3 ? (total / dayOfMonth) * daysInMonth : null,
    daysWithData: days.size,
    unknownModels: [...unknown],
  };
}

export async function monthSpend(now = new Date()): Promise<MonthSpend> {
  return summarize(await readUsageRecords({ months: [monthKey(now)] }), now);
}
