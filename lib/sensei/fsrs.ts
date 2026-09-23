/**
 * FSRS-5 scheduler (Free Spaced Repetition Scheduler — the algorithm Anki ships),
 * vendored as one file to keep the `sensei` branch dependency-free (DECISIONS A12).
 * Formulas follow the open-spaced-repetition FSRS-5 specification with its
 * published default parameters; target retention 90%.
 */

export const DEFAULT_W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
  1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

const DECAY = -0.5;
const FACTOR = 19 / 81; // 0.9^(1/DECAY) - 1

export type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy
export const CardState = { New: 0, Learning: 1, Review: 2, Relearning: 3 } as const;

export interface CardMemory {
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: Date | null;
}

export interface ScheduleResult extends CardMemory {
  due: Date;
  retrievability: number | null;
  intervalDays: number;
}

const clampD = (d: number) => Math.min(10, Math.max(1, d));
const DAY = 86_400_000;

export function retrievability(elapsedDays: number, stability: number): number {
  return Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY);
}

export function intervalDays(stability: number, targetRetention = 0.9, maxDays = 365): number {
  const raw = (stability / FACTOR) * (Math.pow(targetRetention, 1 / DECAY) - 1);
  return Math.min(maxDays, Math.max(1, Math.round(raw)));
}

function initDifficulty(w: number[], g: Rating) {
  return clampD(w[4] - Math.exp(w[5] * (g - 1)) + 1);
}

function nextDifficulty(w: number[], d: number, g: Rating) {
  const delta = -w[6] * (g - 3);
  const damped = d + (delta * (10 - d)) / 9;
  return clampD(w[7] * initDifficulty(w, 4) + (1 - w[7]) * damped);
}

function recallStability(w: number[], d: number, s: number, r: number, g: Rating) {
  const hard = g === 2 ? w[15] : 1;
  const easy = g === 4 ? w[16] : 1;
  return s * (Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1) * hard * easy + 1);
}

function forgetStability(w: number[], d: number, s: number, r: number) {
  const sf = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
  // As in ts-fsrs: post-lapse stability never exceeds what a same-day relearn would give.
  return Math.min(sf, s / Math.exp(w[17] * w[18]));
}

function shortTermStability(w: number[], s: number, g: Rating) {
  return s * Math.exp(w[17] * (g - 3 + w[18]));
}

/** Apply one review. "Again" brings the card back in 10 minutes; everything else schedules by stability. */
export function schedule(card: CardMemory, rating: Rating, now = new Date(), w = DEFAULT_W): ScheduleResult {
  let { stability, difficulty } = card;
  let r: number | null = null;
  if (card.state === CardState.New || !card.lastReview) {
    stability = w[rating - 1];
    difficulty = initDifficulty(w, rating);
  } else {
    const elapsed = Math.max(0, (now.getTime() - card.lastReview.getTime()) / DAY);
    r = retrievability(elapsed, stability);
    difficulty = nextDifficulty(w, card.difficulty, rating);
    if (elapsed < 1) stability = shortTermStability(w, stability, rating);
    else if (rating === 1) stability = forgetStability(w, card.difficulty, stability, r);
    else stability = recallStability(w, card.difficulty, stability, r, rating);
  }
  stability = Math.max(0.1, stability);
  const lapsed = rating === 1;
  const days = lapsed ? 0 : intervalDays(stability);
  const due = lapsed ? new Date(now.getTime() + 10 * 60_000) : new Date(now.getTime() + days * DAY);
  return {
    stability,
    difficulty,
    reps: card.reps + 1,
    // A lapse is forgetting a card you had learned; failing again while relearning isn't a new one.
    lapses: card.lapses + (lapsed && card.state === CardState.Review ? 1 : 0),
    state: lapsed
      ? card.state === CardState.Review || card.state === CardState.Relearning
        ? CardState.Relearning
        : CardState.Learning
      : CardState.Review,
    lastReview: now,
    due,
    retrievability: r,
    intervalDays: days,
  };
}

/** Preview the next interval for each rating (shown on the rating buttons, like Anki). */
export function previewIntervals(card: CardMemory, now = new Date(), w = DEFAULT_W): Record<Rating, string> {
  const fmt = (res: ScheduleResult) => {
    const mins = (res.due.getTime() - now.getTime()) / 60_000;
    if (mins < 60) return `${Math.round(mins)}m`;
    const d = mins / 1440;
    if (d < 30) return `${Math.round(d)}d`;
    if (d < 365) return `${Math.round(d / 30)}mo`;
    return `${(d / 365).toFixed(1)}y`;
  };
  return {
    1: fmt(schedule(card, 1, now, w)),
    2: fmt(schedule(card, 2, now, w)),
    3: fmt(schedule(card, 3, now, w)),
    4: fmt(schedule(card, 4, now, w)),
  };
}
