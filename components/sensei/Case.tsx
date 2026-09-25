'use client';

import { useMemo, useState } from 'react';

import { familyById } from '@/lib/sensei/cases/families';

import { CheckIcon } from './icons';

/** One clinical-judgment question (single best answer), generated fresh and keyed by code. */
export function CaseQuestion({ family, seed, onDone, doneLabel = 'Next' }: { family: string; seed: number; onDone: (correct: boolean) => void; doneLabel?: string }) {
  const fam = familyById(family);
  const item = useMemo(() => fam?.generate(seed), [fam, seed]);
  if (!fam || !item) return null;
  return <ChoiceQuestion stem={item.stem} options={item.options} answer={item.answer} rationale={item.rationale} onDone={onDone} doneLabel={doneLabel} />;
}

/** A single-best-answer question: tap an option, see the key and why, then continue. */
export function ChoiceQuestion({
  stem,
  options,
  answer,
  rationale,
  footnote,
  onDone,
  doneLabel = 'Next',
}: {
  stem: string;
  options: string[];
  answer: number;
  rationale: string[];
  footnote?: string;
  onDone: (correct: boolean) => void;
  doneLabel?: string;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const answered = chosen != null;
  const correct = chosen === answer;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p className="s-prose" style={{ margin: 0 }}>
        {stem}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {options.map((opt, i) => {
          const isKey = i === answer;
          const state = !answered ? '' : isKey ? 'right' : i === chosen ? 'wrong' : 'dim';
          return (
            <button key={i} className="s-option" data-state={state || undefined} disabled={answered} onClick={() => setChosen(i)}>
              <span className="s-option-letter">{String.fromCharCode(65 + i)}</span>
              <span style={{ flex: 1, textAlign: 'left' }}>{opt}</span>
              {answered && isKey && <CheckIcon style={{ width: 20, height: 20, color: 'var(--green)' }} />}
            </button>
          );
        })}
      </div>
      {answered && (
        <>
          <div className="t-headline" style={{ color: correct ? 'var(--green)' : 'var(--red)' }}>
            {correct ? 'Correct' : `The best answer is ${String.fromCharCode(65 + answer)}`}
          </div>
          <ul className="s-steps-list" style={{ listStyle: 'disc' }}>
            {rationale.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {footnote && <p className="t-foot c3" style={{ margin: 0 }}>{footnote}</p>}
          <button className="s-btn" onClick={() => onDone(correct)}>
            {doneLabel}
          </button>
        </>
      )}
    </div>
  );
}

export function CaseDrill({ family }: { family: string }) {
  const [seed, setSeed] = useState(() => Date.now());
  const [score, setScore] = useState({ right: 0, total: 0 });
  const fam = familyById(family);
  if (!fam) return null;
  return (
    <div style={{ padding: '4px 20px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <h1 className="t-title2">{fam.name}</h1>
        {score.total > 0 && (
          <span className="t-sub c2 num">
            {score.right}/{score.total}
          </span>
        )}
      </div>
      <CaseQuestion
        key={seed}
        family={family}
        seed={seed}
        onDone={(c) => {
          setScore((s) => ({ right: s.right + (c ? 1 : 0), total: s.total + 1 }));
          setSeed(Date.now());
        }}
        doneLabel="Another case"
      />
    </div>
  );
}
