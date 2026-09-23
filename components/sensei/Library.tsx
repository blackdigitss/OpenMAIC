'use client';

import { useDeferredValue, useMemo, useState } from 'react';

import { fmtDate, fmtTime, relDay, useApi, type GlossaryEntry, type LectureSummary, type LectureView } from './api';
import { PlayIcon, SearchIcon } from './icons';
import { useSensei } from './store';
import { TermText } from './TermText';
import { CourseTag, Row, Screen, Section, Segmented, Skeleton } from './ui';

export function Library() {
  const { openConcept, push } = useSensei();
  const [mode, setMode] = useState<'concepts' | 'lectures'>('concepts');
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const { data: all } = useApi<GlossaryEntry[]>('glossary');
  const { data: found } = useApi<GlossaryEntry[]>(query ? `glossary?q=${encodeURIComponent(query)}` : null);
  const { data: lectures } = useApi<LectureSummary[]>(mode === 'lectures' ? 'lectures' : null);
  const { data: books } = useApi<{ id: string; title: string; pages: number }[]>(mode === 'lectures' ? 'textbooks' : null);

  const sections = useMemo(() => {
    const map = new Map<string, GlossaryEntry[]>();
    for (const e of all ?? []) {
      const letter = /[a-z]/i.test(e.name[0]) ? e.name[0].toUpperCase() : '#';
      map.set(letter, [...(map.get(letter) ?? []), e]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
  }, [all]);

  const byCourse = useMemo(() => {
    const map = new Map<string, LectureSummary[]>();
    for (const l of lectures ?? []) map.set(l.courseCode, [...(map.get(l.courseCode) ?? []), l]);
    return [...map.entries()];
  }, [lectures]);

  return (
    <Screen title="Library" subtitle={all ? `${all.length} concepts from your classes` : undefined}>
      <label className="s-search">
        <SearchIcon />
        <input
          type="search"
          placeholder="Search terms, drugs, formulas"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (e.target.value) setMode('concepts');
          }}
          enterKeyHint="search"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </label>
      {!q && (
        <Segmented
          options={[
            { value: 'concepts', label: 'Concepts' },
            { value: 'lectures', label: 'Lectures' },
          ]}
          value={mode}
          onChange={setMode}
        />
      )}

      {query ? (
        <Section>
          {!found ? (
            <Skeleton />
          ) : found.length === 0 ? (
            <p className="s-foot" style={{ textAlign: 'center', paddingTop: 24 }}>
              Nothing yet for “{query}”. It will appear once a lecture covers it.
            </p>
          ) : (
            <div className="s-list">
              {found.map((e) => (
                <ConceptRow key={e.id} e={e} onClick={() => openConcept(e.id)} />
              ))}
            </div>
          )}
        </Section>
      ) : mode === 'concepts' ? (
        !all ? (
          <Section>
            <Skeleton lines={6} />
          </Section>
        ) : all.length === 0 ? (
          <p className="s-foot" style={{ textAlign: 'center', paddingTop: 40 }}>
            Concepts appear here after your first lecture is processed.
          </p>
        ) : (
          sections.map(([letter, items]) => (
            <Section key={letter} title={letter} className="tight">
              <div className="s-list">
                {items.map((e) => (
                  <ConceptRow key={e.id} e={e} onClick={() => openConcept(e.id)} />
                ))}
              </div>
            </Section>
          ))
        )
      ) : !lectures ? (
        <Section>
          <Skeleton lines={5} />
        </Section>
      ) : (
        byCourse.map(([code, ls]) => (
          <Section key={code} title={code}>
            <div className="s-list">
              {ls.map((l) => (
                <Row
                  key={l.id}
                  title={l.title}
                  sub={`${l.kind === 'deck' ? 'Slides, added ' : ''}${fmtDate(l.date, { weekday: 'short', month: 'short', day: 'numeric' })}${l.kind === 'session' && l.slideFrom != null ? `, slides ${l.slideFrom}–${l.slideTo}` : ''}${l.conceptCount ? `, ${l.conceptCount} concepts` : ''}${l.status === 'failed' ? ', needs attention' : l.status === 'processing' ? ', processing' : ''}`}
                  trailing={l.kind === 'deck' ? <span className="s-pill tint">Slides</span> : undefined}
                  onClick={() => push({ name: 'lecture', id: l.id })}
                />
              ))}
            </div>
          </Section>
        ))
      )}
      {mode === 'lectures' && !query && books && books.length > 0 && (
        <Section title="Textbooks" footer="Searched automatically when a concept needs more depth.">
          <div className="s-list">
            {books.map((b) => (
              <Row key={b.id} title={b.title} sub={`${b.pages} pages`} chevron={false} />
            ))}
          </div>
        </Section>
      )}
    </Screen>
  );
}

function ConceptRow({ e, onClick }: { e: GlossaryEntry; onClick: () => void }) {
  return (
    <Row
      title={e.name}
      sub={e.shortDefinition ?? undefined}
      trailing={
        <>
          {e.emphasis > 0 && <span className="s-dot" style={{ background: 'var(--purple)' }} aria-label="Stressed for the exam" />}
          {e.flagged > 0 && <span className="s-dot" style={{ background: 'var(--orange)' }} aria-label="Has an unconfirmed fact" />}
          {e.lectureCount > 1 && <span className="num">{e.lectureCount}×</span>}
        </>
      }
      onClick={onClick}
    />
  );
}

export function LecturePage({ id }: { id: string }) {
  const { pop, play, tab, openSheet } = useSensei();
  const { data } = useApi<LectureView>(`lecture/${id}`);
  const [showAll, setShowAll] = useState(false);
  const back = { label: tab === 'today' ? 'Today' : 'Library', onBack: pop };
  if (!data) {
    return (
      <Screen title="" back={back} push>
        <Skeleton lines={6} />
      </Screen>
    );
  }
  const l = data.lecture;
  const segments = data.units.filter((u) => u.kind === 'segment');
  const pages = data.units.filter((u) => u.kind === 'page');
  const visible = showAll ? segments : segments.slice(0, 40);
  const listen = (ms: number) => data.audioSourceId && play({ sourceId: data.audioSourceId, startMs: ms, label: `${l.title} · ${fmtTime(ms)}` });

  return (
    <Screen
      title={l.title}
      back={back}
      push
      subtitle={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <CourseTag code={l.courseCode} color={l.courseColor} />
          {relDay(l.date)}
        </span>
      }
    >
      {data.summary && (
        <div className="s-card s-prose" style={{ marginTop: 8 }}>
          <TermText text={data.summary} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, margin: '14px 16px 0' }}>
        {l.classroomUrl && (
          <button className="s-btn" onClick={() => openSheet({ kind: 'lesson', url: l.classroomUrl!, title: l.title })}>
            Start lesson
          </button>
        )}
        {data.audioSourceId && (
          <button className={`s-btn${l.classroomUrl ? ' gray' : ''}`} onClick={() => listen(0)}>
            <PlayIcon style={{ width: 14, height: 14 }} />
            Listen
          </button>
        )}
      </div>

      {data.newConcepts.length > 0 && (
        <Section title="New in this class">
          <Chips items={data.newConcepts} />
        </Section>
      )}
      {data.reinforced.length > 0 && (
        <Section title="Built on earlier classes">
          <Chips items={data.reinforced} />
        </Section>
      )}

      {segments.length > 0 && (
        <Section title="Transcript" footer={segments.some((s) => s.uncertainTerms.length) ? 'Wavy underline: Sensei wasn’t sure it heard that word right. Tap a time to listen.' : 'Tap a time to hear that moment.'}>
          <div className="s-list">
            {visible.map((u) => (
              <div key={u.id} className="s-row" style={{ alignItems: 'flex-start', gap: 10 }}>
                {data.audioSourceId && u.startMs != null ? (
                  <button className="s-play" style={{ marginTop: 1, flexShrink: 0 }} onClick={() => listen(u.startMs!)} aria-label={`Play from ${fmtTime(u.startMs)}`}>
                    {fmtTime(u.startMs)}
                  </button>
                ) : (
                  u.startMs != null && <span className="t-foot c2 num" style={{ width: 44, flexShrink: 0, paddingTop: 3 }}>{fmtTime(u.startMs)}</span>
                )}
                <div className="t-callout" style={{ flex: 1, color: u.speaker === 'student' ? 'var(--label-2)' : undefined }}>
                  {u.speaker === 'student' && <span className="t-foot c2">Student: </span>}
                  <TermText text={u.text} uncertain={u.uncertainTerms} />
                </div>
              </div>
            ))}
          </div>
          {segments.length > visible.length && (
            <div style={{ margin: '12px 16px 0' }}>
              <button className="s-btn gray" onClick={() => setShowAll(true)}>
                Show all {segments.length} parts
              </button>
            </div>
          )}
        </Section>
      )}

      {pages.length > 0 && (
        <Section title="Slides" footer={`${pages.length} slides used for this class.`}>
          <div className="s-list">
            {pages.slice(0, showAll ? undefined : 12).map((p) => (
              <div key={p.id} className="s-row" style={{ alignItems: 'flex-start' }}>
                <span className="t-foot c2 num" style={{ width: 28, flexShrink: 0, paddingTop: 2 }}>{p.pageNo}</span>
                <div className="t-sub" style={{ flex: 1, whiteSpace: 'pre-line' }}>
                  <TermText text={p.text.slice(0, 600)} />
                </div>
              </div>
            ))}
          </div>
          {!showAll && pages.length > 12 && (
            <div style={{ margin: '12px 16px 0' }}>
              <button className="s-btn gray" onClick={() => setShowAll(true)}>
                Show all slides
              </button>
            </div>
          )}
        </Section>
      )}
    </Screen>
  );
}

function Chips({ items }: { items: { id: string; name: string }[] }) {
  const { openConcept } = useSensei();
  return (
    <div className="s-chips wrap">
      {items.map((c) => (
        <button key={c.id} className="s-chip" onClick={() => openConcept(c.id)}>
          {c.name}
        </button>
      ))}
    </div>
  );
}
