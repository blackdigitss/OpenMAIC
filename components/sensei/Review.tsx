'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';

import type { McqPayload } from '@/lib/sensei/learn';

import {
  api,
  fmtTime,
  invalidate,
  reelUrl,
  useApi,
  type CalcItem,
  type Reel,
  type ReviewCard,
  type TodayData,
} from './api';
import { PlayIcon } from './icons';
import { pendingCardIds, postRating } from './offline';
import { CalcProblem } from './Calc';
import { CaseQuestion, ChoiceQuestion } from './Case';
import { CheckIcon } from './icons';
import { useSensei } from './store';
import { TermText } from './TermText';
import { Ring, Row, Screen, Section } from './ui';

const COMPETENCY: Record<ReviewCard['competency'], string> = {
  recall: 'Remember',
  explain: 'Explain',
  calculate: 'Calculate',
  apply: 'Patient case',
};

export function ReviewTab() {
  const { startReview, openConcept, openSheet } = useSensei();
  const { data } = useApi<TodayData>('today');
  const { data: calc } = useApi<CalcItem[]>('calc');
  const { data: cases } = useApi<{ id: string; name: string; unlocked: boolean }[]>('cases');
  const { data: reels, reload: reloadReels } = useApi<Reel[]>('reels', {
    pollMs: (r) => (r?.some((x) => x.status === 'queued' || x.status === 'building') ? 5000 : 0),
  });
  const { data: weak } =
    useApi<{ id: string; name: string; shortDefinition: string | null; lapses: number }[]>('weak');
  const s = data?.stats;
  const total = s ? s.due + Math.min(s.newCards, 15) : 0;
  const done = s?.reviewedToday ?? 0;
  return (
    <Screen
      title="Review"
      subtitle={
        data?.module
          ? `${data.module.courseCode} Module ${data.module.number}${data.module.instructor ? ` with ${data.module.instructor}` : ''}, plus everything that keeps mattering`
          : 'Spaced practice from your own lectures'
      }
    >
      <div
        className="s-card"
        style={{ marginTop: 8, textAlign: 'center', padding: '24px 16px 18px' }}
      >
        <div style={{ display: 'grid', placeItems: 'center' }}>
          <Ring
            value={total + done > 0 ? done / (total + done) : 1}
            size={132}
            stroke={14}
            color={total === 0 ? 'var(--green)' : 'var(--tint)'}
          >
            <div>
              <div style={{ fontSize: 34, fontWeight: 700, lineHeight: '38px' }} className="num">
                {total}
              </div>
              <div className="t-foot c2">{total === 1 ? 'card' : 'cards'} today</div>
            </div>
          </Ring>
        </div>
        <p className="t-sub c2" style={{ margin: '14px 12px 16px' }}>
          {total === 0
            ? done > 0
              ? `All caught up. ${done} reviewed today.`
              : 'Nothing due. New cards appear after each lecture.'
            : `${[s!.due ? `${s!.due} to review` : '', s!.newCards ? `${Math.min(s!.newCards, 15)} new` : ''].filter(Boolean).join(' and ')}. Each card comes back right before you’d forget it.`}
        </p>
        <button className="s-btn" disabled={total === 0} onClick={() => startReview()}>
          {done > 0 && total > 0 ? 'Keep going' : 'Start review'}
        </button>
      </div>

      <ListenSection data={data} reels={reels} onRequest={reloadReels} />

      {calc && (
        <Section
          title="Calculations"
          footer={
            calc.some((c) => c.unlocked)
              ? `Fresh numbers every time, checked by math, not AI. ${calc.filter((c) => !c.unlocked).length} more unlock as your classes cover them.`
              : 'Formulas unlock as your classes teach them (cylinder duration, FiO2, compliance, and more).'
          }
        >
          {calc.some((c) => c.unlocked) && (
            <div className="s-list">
              {calc
                .filter((c) => c.unlocked)
                .map((c) => (
                  <Row
                    key={c.id}
                    title={c.name}
                    sub={c.conceptName ? `From ${c.conceptName}` : undefined}
                    onClick={() => openSheet({ kind: 'calc', formulaId: c.id })}
                  />
                ))}
            </div>
          )}
        </Section>
      )}

      {cases?.some((c) => c.unlocked) && (
        <Section
          title="Clinical cases"
          footer="Board-style scenarios: one best answer, what the RT should do next. A new case every time, scored by the rules, not by AI."
        >
          <div className="s-list">
            {cases
              .filter((c) => c.unlocked)
              .map((c) => (
                <Row
                  key={c.id}
                  title={c.name}
                  onClick={() => openSheet({ kind: 'case', family: c.id })}
                />
              ))}
          </div>
        </Section>
      )}

      {!!s?.retired && (
        <p className="s-foot" style={{ padding: '10px 20px 0' }}>
          {s.retired} details from finished modules are retired from review. They stay in your
          Library.
        </p>
      )}

      {weak && weak.length > 0 && (
        <Section
          title="Keeps slipping"
          footer="Concepts you’ve missed more than once. Tap one to see what your professor said."
        >
          <div className="s-list">
            {weak.map((w) => (
              <Row
                key={w.id}
                title={w.name}
                sub={w.shortDefinition ?? undefined}
                trailing={<span className="s-pill warn">Missed {w.lapses}×</span>}
                onClick={() => openConcept(w.id)}
              />
            ))}
          </div>
        </Section>
      )}
    </Screen>
  );
}

/** "Hear it from your professor": the module's stressed moments, or your trouble spots, in their voice. */
function ListenSection({
  data,
  reels,
  onRequest,
}: {
  data?: TodayData;
  reels?: Reel[];
  onRequest: () => void;
}) {
  const { play, toast } = useSensei();
  const moduleKey = data?.module ? `module:${data.module.id}` : null;
  const options = [
    moduleKey && {
      key: moduleKey,
      title: `${data!.module!.courseCode} Module ${data!.module!.number}: what your professor stressed`,
    },
    { key: 'weak', title: 'Your trouble spots, in your professor’s words' },
  ].filter(Boolean) as { key: string; title: string }[];
  const request = async (key: string, title: string) => {
    await api('reels/request', { method: 'POST', body: JSON.stringify({ key, title }) });
    toast('Sensei is cutting the clips');
    onRequest();
  };
  return (
    <Section
      title="Listen"
      footer="Exact clips of your professor, stitched into one track. Great for the car or the gym."
    >
      <div className="s-list">
        {options.map((o) => {
          const r = reels?.find((x) => x.key === o.key);
          const ready = r?.status === 'ready';
          return (
            <Row
              key={o.key}
              title={o.title}
              sub={
                !r
                  ? 'Tap to make it'
                  : r.status === 'ready'
                    ? `${fmtTime(r.durationMs ?? 0)}, ${r.chapters.length} moments`
                    : r.status === 'empty'
                      ? 'Nothing stressed with audio yet'
                      : r.status === 'failed'
                        ? 'Couldn’t build it. Tap to retry.'
                        : 'Cutting clips…'
              }
              trailing={
                ready ? (
                  <PlayIcon style={{ width: 14, height: 14, color: 'var(--tint)' }} />
                ) : undefined
              }
              onClick={() =>
                ready
                  ? play({ url: reelUrl(r!), startMs: 0, label: r!.title, chapters: r!.chapters })
                  : request(o.key, o.title)
              }
            />
          );
        })}
      </div>
    </Section>
  );
}

/** Stable per card, position and day, so the numbers don't change while you type. */
/** Tap the steps in order; a wrong tap shakes and counts. Mistakes set the rating. */
function OrderCard({ title, steps, why, seed, onDone }: { title: string; steps: string[]; why?: string; seed: number; onDone: (rating: 1 | 2 | 3 | 4) => void }) {
  const shuffled = useMemo(() => {
    const idx = steps.map((_, k) => k);
    let s = seed || 1;
    for (let k = idx.length - 1; k > 0; k--) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      const j = s % (k + 1);
      [idx[k], idx[j]] = [idx[j], idx[k]];
    }
    return idx;
  }, [steps, seed]);
  const [placed, setPlaced] = useState<number[]>([]);
  const [misses, setMisses] = useState(0);
  const [wrong, setWrong] = useState<number | null>(null);
  const done = placed.length === steps.length;
  const tap = (k: number) => {
    if (done || placed.includes(k)) return;
    if (k === placed.length) {
      setPlaced((p) => [...p, k]);
      setWrong(null);
    } else {
      setMisses((m) => m + 1);
      setWrong(k);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p className="s-prose" style={{ margin: 0 }}>
        {title.replace(/^Put the steps in order:\s*/, '')}
      </p>
      <div className="t-foot c2">{done ? 'Done' : `Tap step ${placed.length + 1} of ${steps.length}`}</div>
      {placed.length > 0 && (
        <ol className="s-steps-list">
          {placed.map((k) => (
            <li key={k}>{steps[k]}</li>
          ))}
        </ol>
      )}
      {!done && (
        <div style={{ display: 'grid', gap: 8 }}>
          {shuffled
            .filter((k) => !placed.includes(k))
            .map((k) => (
              <button key={k} className="s-option" data-state={wrong === k ? 'wrong' : undefined} onClick={() => tap(k)}>
                <span style={{ flex: 1, textAlign: 'left' }}>{steps[k]}</span>
              </button>
            ))}
        </div>
      )}
      {done && (
        <>
          <div className="t-headline" style={{ color: misses === 0 ? 'var(--green)' : misses === 1 ? 'var(--orange)' : 'var(--red)' }}>
            {misses === 0 ? 'Perfect order' : `${misses} wrong tap${misses > 1 ? 's' : ''}`}
          </div>
          {why && <p className="t-sub c2" style={{ margin: 0 }}>{why}</p>}
          <button className="s-btn" onClick={() => onDone(misses === 0 ? 3 : misses === 1 ? 2 : 1)}>
            Continue
          </button>
        </>
      )}
    </div>
  );
}

/** A practice question with its options in a fresh order each time, so you learn the answer, not the letter. */
function McqCard({ payload, stem, seed, onDone }: { payload: McqPayload; stem: string; seed: number; onDone: (correct: boolean) => void }) {
  const order = useMemo(() => {
    const idx = payload.options.map((_, k) => k);
    let s = seed || 1;
    for (let k = idx.length - 1; k > 0; k--) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      const j = s % (k + 1);
      [idx[k], idx[j]] = [idx[j], idx[k]];
    }
    // Keep "all/none of the above" last, where they make sense.
    return [...idx.filter((k) => !/\b(all|none|both) of the above\b/i.test(payload.options[k])), ...idx.filter((k) => /\b(all|none|both) of the above\b/i.test(payload.options[k]))];
  }, [payload.options, seed]);
  return (
    <ChoiceQuestion
      stem={stem}
      options={order.map((k) => payload.options[k])}
      answer={order.indexOf(payload.answer)}
      rationale={payload.rationale}
      footnote={payload.source && !payload.source.startsWith('lab drill') ? `From your ${payload.source}` : undefined}
      onDone={onDone}
      doneLabel="Continue"
    />
  );
}

function seedFor(id: string, i: number): number {
  let h = 2166136261;
  for (const ch of `${id}:${i}:${new Date().toDateString()}`)
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Full-screen review session. */
export function ReviewSession() {
  const { endReview, reviewConcept, openConcept, toast } = useSensei();
  const [cards, setCards] = useState<ReviewCard[] | null>(null);
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [again, setAgain] = useState<ReviewCard[]>([]);

  useEffect(() => {
    // Offline, this list may be a saved copy: leave out cards already rated on this device.
    void api<ReviewCard[]>(`review${reviewConcept ? `?concept=${reviewConcept}` : ''}`).then(
      (c) => {
        const pending = pendingCardIds();
        setCards(c.filter((x) => !pending.has(x.id)));
      },
    );
  }, [reviewConcept]);

  const queue = cards ? [...cards, ...again] : [];
  const card = queue[i];

  const rate = async (rating: 1 | 2 | 3 | 4) => {
    if (!card) return;
    setShown(false);
    setReviewed((n) => n + 1);
    if (rating === 1) setAgain((a) => [...a, card]);
    setI((n) => n + 1);
    // Saved now, or kept on this device and sent when you're back online.
    try {
      const res = await postRating(card.id, rating);
      if (res.remediated?.length) toast(`Added a refresher on ${res.remediated[0]}`);
      if (res.needsCode) toast('Reopen Sensei and enter your code. Your ratings are saved.');
    } catch {
      toast('Couldn’t save that rating. Try again in a moment.');
    }
  };

  const close = () => {
    invalidate('today', 'weak', 'concept');
    endReview();
  };

  return (
    <motion.div
      className="s-review"
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ type: 'spring', damping: 34, stiffness: 320 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px' }}>
        <button className="s-link" style={{ fontWeight: 600 }} onClick={close}>
          Done
        </button>
        <div className="s-progress" style={{ flex: 1 }}>
          <div
            style={{
              width: `${queue.length ? (Math.min(i, queue.length) / queue.length) * 100 : 0}%`,
            }}
          />
        </div>
        <span className="t-foot c2 num" style={{ minWidth: 36, textAlign: 'right' }}>
          {Math.min(i, queue.length)}/{queue.length}
        </span>
      </div>

      {!cards ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center' }} className="c2">
          Loading…
        </div>
      ) : !card ? (
        <div
          style={{
            flex: 1,
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
            padding: 32,
          }}
        >
          <div>
            <div style={{ display: 'grid', placeItems: 'center', marginBottom: 16 }}>
              <Ring value={1} size={88} stroke={10} color="var(--green)">
                <CheckIcon style={{ width: 34, height: 34, color: 'var(--green)' }} />
              </Ring>
            </div>
            <h2 className="t-title2">{reviewed ? 'Nice work' : 'Nothing to review'}</h2>
            <p className="t-callout c2" style={{ marginTop: 6 }}>
              {reviewed
                ? `${reviewed} card${reviewed === 1 ? '' : 's'} reviewed. Sensei will bring each back right before you’d forget it.`
                : 'New cards appear after each lecture.'}
            </p>
            <button className="s-btn" style={{ marginTop: 24 }} onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <AnimatePresence mode="wait">
            <motion.div
              key={`${card.id}-${i}`}
              className="s-review-card"
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.22 }}
              onClick={() => !shown && !card.formulaId && !card.caseFamily && !card.payload && setShown(true)}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="s-pill tint">{COMPETENCY[card.competency]}</span>
                {card.isNew && <span className="s-pill muted">New</span>}
                <span style={{ flex: 1 }} />
                <button
                  className="t-foot tint"
                  onClick={(e) => {
                    e.stopPropagation();
                    openConcept(card.conceptId);
                  }}
                >
                  {card.conceptName}
                </button>
              </div>
              {card.payload?.kind === 'order' ? (
                <div style={{ marginTop: 18 }}>
                  <OrderCard key={`${card.id}:${i}`} title={card.front} steps={card.payload.steps} why={card.payload.why} seed={seedFor(card.id, i)} onDone={rate} />
                </div>
              ) : card.payload?.kind === 'mcq' ? (
                <div style={{ marginTop: 18 }}>
                  <McqCard key={`${card.id}:${i}`} payload={card.payload} stem={card.front} seed={seedFor(card.id, i)} onDone={(correct) => rate(correct ? 3 : 1)} />
                </div>
              ) : card.caseFamily ? (
                <div style={{ marginTop: 18 }}>
                  <CaseQuestion
                    family={card.caseFamily}
                    seed={seedFor(card.id, i)}
                    onDone={(correct) => rate(correct ? 3 : 1)}
                    doneLabel="Continue"
                  />
                </div>
              ) : card.formulaId ? (
                <div style={{ marginTop: 18 }}>
                  <CalcProblem
                    formulaId={card.formulaId}
                    seed={seedFor(card.id, i)}
                    onDone={(correct) => rate(correct ? 3 : 1)}
                    doneLabel="Continue"
                  />
                </div>
              ) : (
                <>
                  <div className="t-title2" style={{ marginTop: 18, fontWeight: 600 }}>
                    {shown ? <TermText text={card.front} /> : card.front}
                  </div>
                  {shown ? (
                    <div
                      style={{ marginTop: 18, paddingTop: 18, borderTop: '0.5px solid var(--sep)' }}
                    >
                      <div className="s-prose">
                        <TermText text={card.back} />
                      </div>
                    </div>
                  ) : (
                    <div style={{ marginTop: 'auto', textAlign: 'center' }} className="t-sub c3">
                      Think of your answer, then tap
                    </div>
                  )}
                </>
              )}
            </motion.div>
          </AnimatePresence>
          {card.formulaId || card.caseFamily || card.payload ? null : shown ? (
            <div className="s-rate">
              <button onClick={() => rate(1)} style={{ color: 'var(--red)' }}>
                Again<span>{card.intervals[1]}</span>
              </button>
              <button onClick={() => rate(2)} style={{ color: 'var(--orange)' }}>
                Hard<span>{card.intervals[2]}</span>
              </button>
              <button onClick={() => rate(3)} style={{ color: 'var(--tint)' }}>
                Good<span>{card.intervals[3]}</span>
              </button>
              <button onClick={() => rate(4)} style={{ color: 'var(--green)' }}>
                Easy<span>{card.intervals[4]}</span>
              </button>
            </div>
          ) : (
            <div style={{ padding: '8px 16px 12px' }}>
              <button className="s-btn" onClick={() => setShown(true)}>
                Show answer
              </button>
            </div>
          )}
        </>
      )}
    </motion.div>
  );
}
