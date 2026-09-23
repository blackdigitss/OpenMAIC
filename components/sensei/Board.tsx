'use client';

import { useApi } from './api';
import { useSensei } from './store';
import { Section, Skeleton } from './ui';

interface BoardData {
  sections: {
    code: string;
    title: string;
    items: number;
    coveredItems: number;
    readiness: number | null;
    tasks: { code: string; title: string; items: number; concepts: number; recall: number | null; topConcepts: { id: string; name: string }[] }[];
  }[];
  conditions: { code: string; group: string; title: string; items: number; correct: number; total: number }[];
  source: { name: string; url: string };
}

const level = (r: number | null, concepts: number) =>
  concepts === 0 ? { label: 'Not taught yet', color: 'var(--fill-2)' } : r == null ? { label: 'Taught, not reviewed', color: 'var(--tint-soft)' } : r < 0.7 ? { label: 'Shaky', color: 'var(--orange)' } : r < 0.9 ? { label: 'Learning', color: 'var(--tint)' } : { label: 'Solid', color: 'var(--green)' };

/** Where you stand on the new NBRC RT Exam (2027): every section, weighted like the real exam. */
export function BoardMap() {
  const { openConcept } = useSensei();
  const { data } = useApi<BoardData>('board');
  if (!data) return <Section><Skeleton lines={6} /></Section>;
  return (
    <>
      <p className="s-foot" style={{ padding: '14px 20px 0' }}>
        The NBRC’s new RT Exam replaces the TMC and CSE for your class: one 160-question exam, weighted like the bars below. Concepts from your classes are mapped onto it as you learn them.
      </p>
      {data.sections.map((s) => (
        <Section key={s.code} title={`${s.code}. ${s.title}`} more={<span className="t-sub c2 num">{s.items} Qs</span>}>
          <div className="s-list">
            {s.tasks.map((t) => {
              const l = level(t.recall, t.concepts);
              return (
                <div key={t.code} className="s-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <div className="s-row-title">
                      <span className="c2 num">{t.code}</span> {t.title}
                    </div>
                    <span className="t-foot c2 num" style={{ flexShrink: 0 }}>{t.items} Qs</span>
                  </div>
                  <div className="s-progress" style={{ height: 6 }}>
                    <div style={{ width: `${t.concepts === 0 ? 0 : Math.max(8, (t.recall ?? 0.15) * 100)}%`, background: l.color }} />
                  </div>
                  <div className="t-foot c2">
                    {l.label}
                    {t.concepts > 0 ? `, ${t.concepts} concept${t.concepts === 1 ? '' : 's'}` : ''}
                  </div>
                  {t.topConcepts.length > 0 && (
                    <div className="s-chips wrap" style={{ padding: 0 }}>
                      {t.topConcepts.map((c) => (
                        <button key={c.id} className="s-chip" style={{ height: 28, fontSize: 13 }} onClick={() => openConcept(c.id)}>
                          {c.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      ))}
      <Section title="Clinical judgment" more={<span className="t-sub c2">60 Qs</span>} footer="Portion B is all scenarios: what to check next, what to do or recommend. Case practice feeds these.">
        <div className="s-list">
          {data.conditions.map((c) => (
            <div key={c.code} className="s-row">
              <div className="s-row-main">
                <div className="s-row-title">{c.title}</div>
                <div className="s-row-sub">{c.group}, {c.items} Qs</div>
              </div>
              <span className="s-trail num">{c.total ? `${Math.round((c.correct / c.total) * 100)}% of ${c.total}` : 'No cases yet'}</span>
            </div>
          ))}
        </div>
      </Section>
      <p className="s-foot" style={{ padding: '10px 20px 0' }}>
        Source: {data.source.name}.
      </p>
    </>
  );
}
