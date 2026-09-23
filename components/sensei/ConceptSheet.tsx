'use client';

import { useState } from 'react';

import { api, fmtDate, fmtTime, humanNote, useApi, type ConceptDetail, type SenseiAnswer } from './api';
import { ArrowUpIcon, BackChevron, CloseIcon, PlayIcon } from './icons';
import { useSensei } from './store';
import { TermText } from './TermText';
import { Row, Section, Skeleton } from './ui';

type Rec = ConceptDetail['records'][number];

const TEACHING = new Set(['definition', 'mechanism', 'clinical', 'formula', 'calculation', 'relationship', 'detail', 'analogy', 'misconception']);

const RELATION_LABEL: Record<string, { out: string; in: string }> = {
  prerequisite_of: { out: 'Unlocks', in: 'Understand first' },
  causes: { out: 'Causes', in: 'Caused by' },
  affects: { out: 'Affects', in: 'Affected by' },
  measured_by: { out: 'Measured by', in: 'Measures' },
  applied_in: { out: 'Used in', in: 'Uses' },
  extends: { out: 'Builds on', in: 'Built on by' },
  contradicts: { out: 'Disagrees with', in: 'Disagrees with' },
  confused_with: { out: 'Often confused with', in: 'Often confused with' },
  related_to: { out: 'Related', in: 'Related' },
};

const TYPE_LABEL: Record<string, string> = {
  definition: 'Definition', mechanism: 'Why it happens', clinical: 'In the clinic', formula: 'Formula',
  calculation: 'Calculation', relationship: 'Connection', anecdote: 'Story from class', emphasis: 'Stressed in class',
  exam_hint: 'Exam hint', misconception: 'Common mistake', analogy: 'Analogy', backref: 'Callback', foreshadow: 'Coming later',
  detail: 'Detail',
};

export function ConceptSheetBody({ id, canGoBack, onBack, onClose }: { id: string; canGoBack: boolean; onBack: () => void; onClose: () => void }) {
  const { data: c, error } = useApi<ConceptDetail>(`concept/${id}`);
  return (
    <>
      <div className="s-sheet-bar">
        {canGoBack ? (
          <button className="s-back" onClick={onBack}>
            <BackChevron />
            Back
          </button>
        ) : (
          <span />
        )}
        <button aria-label="Close" onClick={onClose} style={{ width: 30, height: 30 }}>
          <CloseIcon />
        </button>
      </div>
      {error && <p className="s-foot">{error}</p>}
      {!c ? <div style={{ paddingTop: 20 }}><Skeleton lines={4} /></div> : <ConceptContent c={c} />}
    </>
  );
}

function ConceptContent({ c }: { c: ConceptDetail }) {
  const { play, startReview } = useSensei();
  const teaching = c.records.filter((r) => TEACHING.has(r.type));
  const hints = c.records.filter((r) => r.type === 'exam_hint' || r.type === 'emphasis');
  const stories = c.records.filter((r) => r.type === 'anecdote');
  const later = c.records.filter((r) => r.type === 'foreshadow' || r.type === 'backref');
  const definition = c.shortDefinition ?? c.records.find((r) => r.type === 'definition')?.statement ?? null;

  const byRelation = new Map<string, { id: string; name: string; shortDefinition: string | null }[]>();
  for (const r of c.relations) {
    const label = RELATION_LABEL[r.type]?.[r.direction] ?? 'Related';
    const list = byRelation.get(label) ?? [];
    if (!list.some((x) => x.id === r.concept.id)) list.push(r.concept);
    byRelation.set(label, list);
  }
  const relationOrder = ['Understand first', 'Unlocks', 'Often confused with', 'Causes', 'Caused by', 'Affects', 'Affected by', 'Measured by', 'Measures', 'Used in', 'Uses', 'Builds on', 'Built on by', 'Disagrees with', 'Related'];

  return (
    <div>
      <header style={{ padding: '4px 20px 0' }}>
        <h1 className="t-title1">{c.name}</h1>
        {c.aliases.length > 0 && <div className="t-sub c2" style={{ marginTop: 2 }}>Also called {c.aliases.join(', ')}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          <span className="s-pill tint">
            {c.signals.lectures === 1 ? 'Taught in 1 class' : `Taught in ${c.signals.lectures} classes`}
          </span>
          {c.signals.emphasis > 0 && <span className="s-pill exam">Stressed {c.signals.emphasis}×</span>}
          {c.signals.courses > 1 && <span className="s-pill muted">{c.signals.courses} courses</span>}
          {c.signals.unlocks > 0 && <span className="s-pill muted">Unlocks {c.signals.unlocks}</span>}
          {c.signals.firstSeen && <span className="s-pill muted">Since {fmtDate(c.signals.firstSeen)}</span>}
        </div>
      </header>

      {definition && (
        <div className="s-card s-prose" style={{ marginTop: 16 }}>
          <TermText text={definition} exclude={c.id} />
        </div>
      )}

      {hints.length > 0 && (
        <Section title="On the exam">
          <div className="s-list">
            {hints.map((r) => (
              <RecordRow key={r.id} r={r} conceptId={c.id} onPlay={play} />
            ))}
          </div>
        </Section>
      )}

      {teaching.length > 0 && (
        <Section title="What your professor taught">
          <div className="s-list">
            {teaching.map((r) => (
              <RecordRow key={r.id} r={r} conceptId={c.id} onPlay={play} showType />
            ))}
          </div>
        </Section>
      )}

      {stories.length > 0 && (
        <Section title="Stories from class" footer="Real cases your professor shared. They illustrate the idea but aren’t general rules.">
          <div className="s-list">
            {stories.map((r) => (
              <RecordRow key={r.id} r={r} conceptId={c.id} onPlay={play} />
            ))}
          </div>
        </Section>
      )}

      <Evolution c={c} />

      {byRelation.size > 0 && (
        <Section title="Connections">
          {relationOrder
            .filter((label) => byRelation.has(label))
            .map((label) => (
              <div key={label} style={{ marginBottom: 14 }}>
                <div className="t-foot c2" style={{ padding: '0 20px 6px' }}>{label}</div>
                <ConnectionList items={byRelation.get(label)!} />
              </div>
            ))}
        </Section>
      )}

      {later.length > 0 && (
        <Section title="Mentioned in passing">
          <div className="s-list">
            {later.map((r) => (
              <RecordRow key={r.id} r={r} conceptId={c.id} onPlay={play} showType />
            ))}
          </div>
        </Section>
      )}

      <Memory c={c} onReview={() => startReview(c.id)} />
      <Ask conceptId={c.id} name={c.name} />
    </div>
  );
}

function ConnectionList({ items }: { items: { id: string; name: string; shortDefinition: string | null }[] }) {
  const { openConcept } = useSensei();
  return (
    <div className="s-list">
      {items.map((x) => (
        <Row key={x.id} title={x.name} sub={x.shortDefinition ?? undefined} onClick={() => openConcept(x.id)} />
      ))}
    </div>
  );
}

function RecordRow({ r, conceptId, onPlay, showType }: { r: Rec; conceptId: string; onPlay: (t: { sourceId: string; startMs: number; label: string }) => void; showType?: boolean }) {
  const ev = r.evidence[0];
  const flagged = r.verification === 'flagged';
  return (
    <div className="s-row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 0 }}>
      {(showType || flagged) && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          {showType && <span className="t-foot c2" style={{ fontWeight: 600 }}>{TYPE_LABEL[r.type] ?? r.type}</span>}
          {flagged && <span className="s-pill warn">Unconfirmed</span>}
          {r.verification === 'human_confirmed' && <span className="s-pill ok">You checked this</span>}
        </div>
      )}
      <div className="s-prose" style={{ fontSize: 16, lineHeight: '22px' }}>
        <TermText text={r.statement} exclude={conceptId} />
      </div>
      {flagged && r.verificationNotes.length > 0 && (
        <div className="t-foot" style={{ color: 'var(--orange)', marginTop: 4 }}>
          {humanNote(r.verificationNotes[0])}
        </div>
      )}
      {ev && (
        <div className="s-src">
          {ev.kind === 'segment' && ev.startMs != null && ev.audioSourceId ? (
            <button
              className="s-play"
              onClick={() => onPlay({ sourceId: ev.audioSourceId!, startMs: ev.startMs!, label: `${ev.lectureTitle} · ${fmtTime(ev.startMs)}` })}
              aria-label={`Play what your professor said at ${fmtTime(ev.startMs)}`}
            >
              <PlayIcon />
              {fmtTime(ev.startMs)}
            </button>
          ) : null}
          <span className="clamp1">
            {ev.courseCode} {fmtDate(ev.lectureDate)}
            {ev.kind === 'page' && ev.pageNo ? `, slide ${ev.pageNo}` : ev.slideNo ? `, slide ${ev.slideNo}` : ''}
            {r.evidence.length > 1 ? ` and ${r.evidence.length - 1} more` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

/** Knowledge evolution: how this concept developed across lectures, oldest first. */
function Evolution({ c }: { c: ConceptDetail }) {
  const byLecture = new Map<string, { title: string; date: string; course: string; items: Rec[] }>();
  for (const r of c.records) {
    for (const e of r.evidence) {
      const g = byLecture.get(e.lectureId) ?? { title: e.lectureTitle, date: e.lectureDate, course: e.courseCode, items: [] };
      if (!g.items.includes(r)) g.items.push(r);
      byLecture.set(e.lectureId, g);
    }
  }
  const groups = [...byLecture.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (groups.length < 2) return null;
  return (
    <Section title="How it developed" footer="Each class where this came up, and what it added.">
      <div className="s-timeline">
        {groups.map((g, i) => (
          <div key={`${g.date}${g.title}`} className={`s-tl-item${i === 0 ? ' first' : ''}`}>
            <div className="t-foot c2">
              {fmtDate(g.date, { month: 'short', day: 'numeric', year: 'numeric' })}, {g.course}
            </div>
            <div className="t-headline" style={{ marginTop: 1 }}>{g.title}</div>
            <div className="t-sub c2" style={{ marginTop: 3 }}>
              {i === 0 ? 'First introduced. ' : ''}
              {g.items
                .slice(0, 2)
                .map((r) => r.statement)
                .join(' ')}
            </div>
            {g.items.some((r) => r.links.some((l) => l.type === 'contradicts')) && (
              <span className="s-pill warn" style={{ marginTop: 6 }}>Differs from an earlier class</span>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

const COMPETENCIES: { key: string; label: string }[] = [
  { key: 'recall', label: 'Remember it' },
  { key: 'explain', label: 'Explain it' },
  { key: 'calculate', label: 'Calculate with it' },
  { key: 'apply', label: 'Use it with a patient' },
];
const LEVELS = ['new', 'shaky', 'learning', 'solid', 'mastered'];

function Memory({ c, onReview }: { c: ConceptDetail; onReview: () => void }) {
  const comps = COMPETENCIES.filter((k) => c.mastery[k.key]);
  if (comps.length === 0) return null;
  return (
    <Section title="Your memory">
      <div className="s-list">
        {comps.map((k) => {
          const m = c.mastery[k.key];
          const lvl = LEVELS.indexOf(m.level);
          return (
            <div key={k.key} className="s-row">
              <div className="s-row-main">
                <div className="s-row-title">{k.label}</div>
                <div className="s-row-sub">{m.level === 'new' ? 'Not reviewed yet' : m.level[0].toUpperCase() + m.level.slice(1)}</div>
              </div>
              <div className={`s-meter${m.level === 'shaky' ? ' warn' : ''}`} aria-label={m.level}>
                {[1, 2, 3, 4].map((n) => (
                  <span key={n} className={lvl >= n ? 'on' : ''} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {c.cards.total > 0 && (
        <div style={{ margin: '12px 16px 0' }}>
          <button className="s-btn gray" onClick={onReview}>
            {c.cards.due > 0 ? `Review ${c.cards.due} due card${c.cards.due === 1 ? '' : 's'}` : 'Practice this concept'}
          </button>
        </div>
      )}
    </Section>
  );
}

function Ask({ conceptId, name }: { conceptId: string; name: string }) {
  const { play, openConcept } = useSensei();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [a, setA] = useState<SenseiAnswer | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setA(await api<SenseiAnswer>('ask', { method: 'POST', body: JSON.stringify({ question: q, conceptId }) }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Ask Sensei">
      <div className="s-ask">
        <textarea
          rows={1}
          value={q}
          placeholder={`Ask about ${name}`}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          aria-label={`Ask about ${name}`}
        />
        <button onClick={submit} disabled={!q.trim() || busy} aria-label="Ask">
          {busy ? <span className="s-spin" style={{ width: 14, height: 14, border: '2px solid currentColor', borderRightColor: 'transparent', borderRadius: 7 }} /> : <ArrowUpIcon />}
        </button>
      </div>
      {!a && !busy && (
        <div className="s-chips" style={{ marginTop: 10 }}>
          {[`Why does ${name} matter clinically?`, `Explain ${name} simply`, `What’s ${name} often confused with?`].map((s) => (
            <button key={s} className="s-chip" onClick={() => setQ(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {err && <p className="s-foot" style={{ color: 'var(--red)' }}>{err}</p>}
      {a && (
        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          {a.taught && (
            <div className="s-card">
              <div className="s-answer-label tint">From your lectures</div>
              <div className="s-prose" style={{ fontSize: 16 }}>
                <TermText text={a.taught.replace(/\s*\[\d+(?:,\s*\d+)*\]/g, '')} />
              </div>
              {a.sources.length > 0 && (
                <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                  {a.sources.map((s) => (
                    <div key={s.recordId} className="s-src" style={{ marginTop: 0 }}>
                      {s.audioSourceId && s.startMs != null && (
                        <button className="s-play" onClick={() => play({ sourceId: s.audioSourceId!, startMs: s.startMs!, label: `${s.lectureTitle} · ${fmtTime(s.startMs)}` })}>
                          <PlayIcon />
                          {fmtTime(s.startMs)}
                        </button>
                      )}
                      <button className="clamp1 tint" onClick={() => openConcept(s.conceptId)} style={{ textAlign: 'left' }}>
                        {s.conceptName}
                        {s.lectureTitle ? `, ${s.lectureTitle}` : ''}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {a.added && (
            <div className="s-card">
              <div className="s-answer-label" style={{ color: 'var(--indigo)' }}>Sensei’s explanation (not from your lectures)</div>
              <div className="s-prose" style={{ fontSize: 16 }}>
                <TermText text={a.added} />
              </div>
            </div>
          )}
          <p className="s-foot" style={{ paddingTop: 0 }}>For studying only, not for real patient care.</p>
        </div>
      )}
    </Section>
  );
}
