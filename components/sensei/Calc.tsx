'use client';

import { useMemo, useState } from 'react';

import { formulaById, generate, grade, type Graded } from '@/lib/sensei/calc/formulas';

import { CheckIcon } from './icons';

/**
 * One calculation problem with fresh numbers. Graded by code (never a model):
 * any accepted method counts, and the worked solution follows the method you used.
 */
export function CalcProblem({ formulaId, seed, onDone, doneLabel = 'Next' }: { formulaId: string; seed: number; onDone: (correct: boolean) => void; doneLabel?: string }) {
  const formula = formulaById(formulaId)!;
  const values = useMemo(() => generate(formula, seed), [formula, seed]);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<Graded | null>(null);
  if (!formula) return null;
  const check = () => {
    const x = Number(answer.replace(',', '.').replace(/[^\d.-]/g, ''));
    if (!answer.trim() || !Number.isFinite(x)) return;
    setResult(grade(formula, values, x));
  };
  const shown = result?.matched ?? result?.primary;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="t-title3" style={{ fontWeight: 600, lineHeight: '27px' }}>
        {formula.question(values)}
      </div>
      {!result ? (
        <>
          <div className="s-calc-input">
            <input
              inputMode="decimal"
              enterKeyHint="done"
              autoFocus
              placeholder="Your answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && check()}
              aria-label={`Answer in ${formula.unit}`}
            />
            {formula.unit && <span className="c2">{formula.unit}</span>}
          </div>
          <button className="s-btn" disabled={!answer.trim()} onClick={check}>
            Check
          </button>
        </>
      ) : (
        <>
          <div className="s-card" style={{ margin: 0, background: result.correct ? 'color-mix(in srgb, var(--green) 12%, var(--cell))' : 'color-mix(in srgb, var(--red) 10%, var(--cell))', boxShadow: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {result.correct && <CheckIcon style={{ width: 22, height: 22, color: 'var(--green)' }} />}
              <span className="t-headline" style={{ color: result.correct ? 'var(--green)' : 'var(--red)' }}>
                {result.correct ? 'Correct' : `Not quite: ${result.expected} ${formula.unit}`}
              </span>
            </div>
            {result.correct && result.matched && result.matched.id !== result.primary.id && (
              <div className="t-foot c2" style={{ marginTop: 4 }}>
                Matches the “{result.matched.label}” method. Egan’s uses {result.primary.label.toLowerCase()}: {result.primary.compute(values).toFixed(formula.decimals)} {formula.unit}.
              </div>
            )}
          </div>
          <ol className="s-steps-list">
            {shown && formula.steps(values, shown).map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          {formula.interpret?.(result.expected, values) && <p className="t-sub c2">{formula.interpret(result.expected, values)}</p>}
          {formula.source && <p className="t-foot c3">{formula.source}</p>}
          <button className="s-btn" onClick={() => onDone(result.correct)}>
            {doneLabel}
          </button>
        </>
      )}
    </div>
  );
}

/** Unlimited practice on one formula (not scheduled). */
export function CalcDrill({ formulaId }: { formulaId: string }) {
  const [seed, setSeed] = useState(() => Date.now());
  const [score, setScore] = useState({ right: 0, total: 0 });
  const formula = formulaById(formulaId);
  if (!formula) return null;
  return (
    <div style={{ padding: '4px 20px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <h1 className="t-title2">{formula.name}</h1>
        {score.total > 0 && (
          <span className="t-sub c2 num">
            {score.right}/{score.total}
          </span>
        )}
      </div>
      <CalcProblem
        key={seed}
        formulaId={formulaId}
        seed={seed}
        onDone={(correct) => {
          setScore((s) => ({ right: s.right + (correct ? 1 : 0), total: s.total + 1 }));
          setSeed(Date.now());
        }}
        doneLabel="Another one"
      />
    </div>
  );
}
