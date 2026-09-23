/**
 * Personal spacing (DECISIONS V16): tune FSRS's four initial stabilities (w0–w3,
 * one per first rating) to how this student actually remembers.
 *
 * Only the safe subset of the FSRS optimizer: each card's first-day rating and
 * whether it was recalled at the first review on a later day. Same-day repeats
 * are skipped, and calculate/apply cards are excluded (fresh numbers or a new case
 * each time, so they don't measure memory of one fact). The fit is kept only if it
 * beats the defaults on the most recent 20% of data in at least 80% of bootstrap
 * resamples. Everything else in FSRS stays at its published defaults.
 */
import type { Db } from './db/types';
import { DEFAULT_W, retrievability } from './fsrs';
import { getSettings, getState, setState } from './settings';

export const MIN_FIRST_REVIEWS = 300;
const MIN_PER_RATING = 20;
const BOOTSTRAPS = 200;
const WIN_RATE = 0.8;
const S_MIN = 0.1;
const S_MAX = 100;
/** Pull toward the default stability, in log space (keeps sparse ratings sensible). */
const PRIOR = 0.3;

export interface Observation {
  rating: 1 | 2 | 3 | 4;
  days: number;
  recalled: boolean;
  at: Date;
}

export interface SpacingState {
  /** Tuned w0–w3, or null when the defaults fit better. */
  w: number[] | null;
  checkedAt: string;
  observations: number;
  /** Share of bootstrap resamples in which the tuned values predicted better. */
  winRate: number;
  /** Relative log-loss improvement on the held-out reviews. */
  improvement: number;
}

/** One observation per eligible card: first rating, whole days to the first later-day review, and the outcome. */
export async function firstReviewObservations(db: Db): Promise<Observation[]> {
  const { rows } = await db.query<{ first_rating: number; first_day: string; next_day: string; next_rating: number; first_at: Date }>(
    `WITH logs AS (
       SELECT l.card_id, l.rating, l.reviewed_at, l.reviewed_at::date AS day,
              row_number() OVER (PARTITION BY l.card_id ORDER BY l.reviewed_at) AS n
         FROM sensei_review_log l JOIN sensei_card k ON k.id = l.card_id
        WHERE k.competency IN ('recall', 'explain')),
     firsts AS (SELECT card_id, rating, day, reviewed_at FROM logs WHERE n = 1),
     nexts AS (
       SELECT DISTINCT ON (l.card_id) l.card_id, l.rating, l.day
         FROM logs l JOIN firsts f ON f.card_id = l.card_id
        WHERE l.day > f.day ORDER BY l.card_id, l.reviewed_at)
     SELECT f.rating AS first_rating, f.day::text AS first_day, x.day::text AS next_day, x.rating AS next_rating, f.reviewed_at AS first_at
       FROM firsts f JOIN nexts x ON x.card_id = f.card_id
      ORDER BY f.reviewed_at`,
  );
  return rows.map((r) => ({
    rating: Number(r.first_rating) as Observation['rating'],
    days: Math.round((Date.parse(r.next_day) - Date.parse(r.first_day)) / 86_400_000),
    recalled: Number(r.next_rating) > 1,
    at: new Date(r.first_at),
  }));
}

const clampP = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));

function logLoss(obs: Observation[], w: number[]): number {
  if (obs.length === 0) return 0;
  let sum = 0;
  for (const o of obs) {
    const p = clampP(retrievability(o.days, w[o.rating - 1]));
    sum -= o.recalled ? Math.log(p) : Math.log(1 - p);
  }
  return sum / obs.length;
}

/** Best stability for one rating: log-loss plus a pull toward the default, by ternary search on log S. */
function fitOne(obs: Observation[], fallback: number): number {
  if (obs.length < MIN_PER_RATING) return fallback;
  const cost = (logS: number) => {
    const s = Math.exp(logS);
    let sum = 0;
    for (const o of obs) {
      const p = clampP(retrievability(o.days, s));
      sum -= o.recalled ? Math.log(p) : Math.log(1 - p);
    }
    return sum / obs.length + (PRIOR * Math.abs(logS - Math.log(fallback))) / Math.sqrt(obs.length);
  };
  let lo = Math.log(S_MIN);
  let hi = Math.log(S_MAX);
  for (let i = 0; i < 80; i++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (cost(a) < cost(b)) hi = b;
    else lo = a;
  }
  return Math.exp((lo + hi) / 2);
}

/** w0–w3 fitted to the observations, kept in order (Again ≤ Hard ≤ Good ≤ Easy). */
export function fitInitialStability(obs: Observation[]): number[] {
  const w = [1, 2, 3, 4].map((g, i) => fitOne(obs.filter((o) => o.rating === g), DEFAULT_W[i]));
  for (let i = 1; i < 4; i++) w[i] = Math.max(w[i], w[i - 1]);
  return w;
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fit on the older 80%, test on the newest 20%, and bootstrap the test set. */
export function evaluate(obs: Observation[]): Omit<SpacingState, 'checkedAt'> {
  const sorted = [...obs].sort((a, b) => a.at.getTime() - b.at.getTime());
  const cut = Math.floor(sorted.length * 0.8);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  const tuned = [...fitInitialStability(train), ...DEFAULT_W.slice(4)];
  const base = logLoss(test, DEFAULT_W);
  const improvement = base > 0 ? (base - logLoss(test, tuned)) / base : 0;
  const rand = rng(test.length * 7919 + 17);
  let wins = 0;
  for (let b = 0; b < BOOTSTRAPS; b++) {
    const sample = test.map(() => test[Math.floor(rand() * test.length)]);
    if (logLoss(sample, tuned) < logLoss(sample, DEFAULT_W)) wins++;
  }
  const winRate = wins / BOOTSTRAPS;
  // Keep a fit from all the data once it has proved itself on the holdout.
  const w = winRate >= WIN_RATE && improvement > 0 ? fitInitialStability(sorted) : null;
  return { w, observations: obs.length, winRate, improvement };
}

/** Refit at most once a week once there's enough data. Returns the new state, or null if nothing ran. */
export async function maybeTuneSpacing(db: Db, now = new Date(), force = false): Promise<SpacingState | null> {
  const prev = await getState<SpacingState>(db, 'spacing');
  if (!force && prev && now.getTime() - Date.parse(prev.checkedAt) < 7 * 86_400_000) return null;
  const obs = await firstReviewObservations(db);
  if (obs.length < MIN_FIRST_REVIEWS) return null;
  const state: SpacingState = { ...evaluate(obs), checkedAt: now.toISOString() };
  await setState(db, 'spacing', state);
  return state;
}

/** The weights reviews should use: tuned w0–w3 when available and switched on, defaults otherwise. */
export async function activeWeights(db: Db): Promise<number[]> {
  const [settings, state] = await Promise.all([getSettings(db), getState<SpacingState>(db, 'spacing')]);
  if (!settings.personalSpacing || !state?.w) return DEFAULT_W;
  return [...state.w, ...DEFAULT_W.slice(4)];
}

/** What Settings shows. */
export async function spacingStatus(db: Db) {
  const [settings, state, obs] = await Promise.all([getSettings(db), getState<SpacingState>(db, 'spacing'), firstReviewObservations(db)]);
  return {
    enabled: settings.personalSpacing,
    collected: obs.length,
    needed: MIN_FIRST_REVIEWS,
    tuned: state?.w ? { w: state.w, default: DEFAULT_W.slice(0, 4), checkedAt: state.checkedAt, improvement: state.improvement } : null,
    checkedAt: state?.checkedAt ?? null,
  };
}
