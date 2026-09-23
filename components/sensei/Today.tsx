'use client';

import { useState } from 'react';

import { api, fmtDate, fmtTime, humanNote, invalidate, relDay, useApi, type Job, type TodayData } from './api';
import { PersonIcon, PlayIcon, PlusIcon, WaveGlyph } from './icons';
import { useSensei } from './store';
import { TermText } from './TermText';
import { BreathWave, CourseTag, Ring, Row, Screen, Section, Skeleton } from './ui';

export function Today() {
  const { openSheet, push } = useSensei();
  // Poll quickly only while a lecture is being processed.
  const { data } = useApi<TodayData>('today', {
    pollMs: (d) => (d?.jobs.some((j) => j.status === 'running' || j.status === 'queued') ? 4000 : 60_000),
  });

  const now = new Date();
  const subtitle = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const actions = (
    <>
      <button className="s-iconbtn" aria-label="Add a lecture" onClick={() => openSheet({ kind: 'add' })}>
        <PlusIcon />
      </button>
      <button className="s-iconbtn" aria-label="Classes and settings" onClick={() => openSheet({ kind: 'settings' })}>
        <PersonIcon />
      </button>
    </>
  );

  if (!data) {
    return (
      <Screen title="Today" subtitle={subtitle} actions={actions}>
        <div style={{ marginTop: 16 }}>
          <Skeleton lines={5} />
        </div>
      </Screen>
    );
  }

  const empty = data.lectures.length === 0 && data.jobs.length === 0;
  const d = data.digest;

  return (
    <Screen title="Today" subtitle={subtitle} actions={actions}>
      {!data.hasKey && (
        <div className="s-card" style={{ marginTop: 8, borderLeft: '4px solid var(--orange)' }}>
          <div className="t-headline">Sensei is waiting for its AI key</div>
          <div className="t-sub c2" style={{ marginTop: 4 }}>
            Lectures you add are saved and will be processed as soon as the Gemini key is set up on the Mac.
          </div>
        </div>
      )}

      {data.system.workerSeen && !data.system.workerAlive && (
        <div className="s-card" style={{ marginTop: 8, borderLeft: '4px solid var(--red)' }}>
          <div className="t-headline">The Mac isn’t processing lectures</div>
          <div className="t-sub c2" style={{ marginTop: 4 }}>
            Sensei’s worker on the Mac stopped. Recordings are safe and will be processed once it’s running again. Restarting the Mac fixes it.
          </div>
        </div>
      )}
      {data.system.update?.state === 'failed' && (
        <div className="s-card" style={{ marginTop: 8, borderLeft: '4px solid var(--orange)' }}>
          <div className="t-headline">Last update was skipped</div>
          <div className="t-sub c2" style={{ marginTop: 4 }}>{data.system.update.message} Sensei keeps running the previous version.</div>
        </div>
      )}

      {data.jobs.map((j) => (
        <JobCard key={j.id} job={j} courses={data.courses.map((c) => c.code)} />
      ))}

      {empty ? (
        <Welcome hasCourses={data.courses.length > 0} />
      ) : (
        <>
          {d && (
            <section className="s-hero" style={{ marginTop: 12 }}>
              <BreathWave week={data.week} />
              <div className="s-hero-body">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <CourseTag code={d.lecture.courseCode} color={d.lecture.courseColor} />
                  <span className="t-foot c2">{relDay(d.lecture.date)}</span>
                </div>
                <h2 className="t-title2" style={{ marginTop: 6 }}>{d.lecture.title}</h2>
                <LectureSummary lectureId={d.lecture.id} />
                <div className="s-actions">
                  {d.lecture.classroomUrl ? (
                    <button className="s-btn" onClick={() => openSheet({ kind: 'lesson', url: d.lecture.classroomUrl!, title: d.lecture.title })}>
                      Start tonight’s lesson
                    </button>
                  ) : (
                    <button className="s-btn" onClick={() => push({ name: 'lecture', id: d.lecture.id })}>
                      Open lecture
                    </button>
                  )}
                </div>
                {d.lecture.classroomUrl && (
                  <button className="s-link t-sub" style={{ marginTop: 12, display: 'block', width: '100%' }} onClick={() => push({ name: 'lecture', id: d.lecture.id })}>
                    See the transcript and everything from this class
                  </button>
                )}
              </div>
            </section>
          )}

          <ReviewNudge stats={data.stats} />

          {d && d.newConcepts.length > 0 && (
            <Section title="New today" more={<span className="t-sub c2">{d.newConcepts.length}</span>}>
              <ConceptChips items={d.newConcepts} />
            </Section>
          )}

          {d && d.emphasis.length > 0 && (
            <Section title="Your professor stressed" footer="Things said to matter, or likely to be on the exam.">
              <div className="s-list">
                {d.emphasis.slice(0, 6).map((e) => (
                  <EmphasisRow key={e.recordId} e={e} lectureTitle={d.lecture.title} lectureId={d.lecture.id} />
                ))}
              </div>
            </Section>
          )}

          {d && d.reinforced.length > 0 && (
            <Section title="Came up again" footer="Concepts from earlier classes that today built on.">
              <ReinforcedList items={d.reinforced} />
            </Section>
          )}

          {data.flagged.length > 0 && <CheckThese items={data.flagged} />}

          <Section title="Recent lectures">
            <div className="s-list">
              {data.lectures.slice(0, 5).map((l) => (
                <Row
                  key={l.id}
                  leading={<span className="s-dot" style={{ background: l.courseColor ?? 'var(--tint)' }} />}
                  inset={36}
                  title={l.title}
                  sub={`${l.courseCode}, ${relDay(l.date)}${l.conceptCount ? `, ${l.conceptCount} concepts` : ''}`}
                  onClick={() => push({ name: 'lecture', id: l.id })}
                />
              ))}
            </div>
          </Section>

          <div className="s-stats" style={{ marginTop: 28 }}>
            <div className="s-stat">
              <div className="v">{data.stats.concepts}</div>
              <div className="l">Concepts</div>
            </div>
            <div className="s-stat">
              <div className="v">{data.stats.lectures}</div>
              <div className="l">Lectures</div>
            </div>
            <div className="s-stat">
              <div className="v">{data.stats.activeDays}<span className="t-sub c2">/7</span></div>
              <div className="l">Days studied</div>
            </div>
          </div>
        </>
      )}
    </Screen>
  );
}

function LectureSummary({ lectureId }: { lectureId: string }) {
  const { data } = useApi<{ summary: string | null }>(`lecture/${lectureId}`);
  if (!data?.summary) return null;
  return (
    <p className="t-callout c2" style={{ marginTop: 6 }}>
      <TermText text={data.summary} />
    </p>
  );
}

function ReviewNudge({ stats }: { stats: TodayData['stats'] }) {
  const { startReview } = useSensei();
  const total = stats.due + stats.newCards;
  if (total === 0 && stats.reviewedToday === 0) return null;
  const done = stats.reviewedToday;
  const frac = total + done > 0 ? done / (total + done) : 1;
  return (
    <div className="s-card" style={{ marginTop: 12 }}>
      <div className="s-status">
        <Ring value={frac} size={52} stroke={6} color={total === 0 ? 'var(--green)' : 'var(--tint)'}>
          <span className="t-foot num" style={{ fontWeight: 700 }}>{total}</span>
        </Ring>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-headline">{total === 0 ? 'Review done for today' : `${total} card${total === 1 ? '' : 's'} to review`}</div>
          <div className="t-sub c2">
            {total === 0 ? `${done} reviewed. Come back tomorrow.` : `About ${Math.max(1, Math.round(total * 0.25))} min, spaced so you remember.`}
          </div>
        </div>
        {total > 0 && (
          <button className="s-btn small" onClick={() => startReview()}>
            Start
          </button>
        )}
      </div>
    </div>
  );
}

function ConceptChips({ items }: { items: { id: string; name: string }[] }) {
  const { openConcept } = useSensei();
  return (
    <div className="s-chips">
      {items.map((c) => (
        <button key={c.id} className="s-chip" onClick={() => openConcept(c.id)}>
          {c.name}
        </button>
      ))}
    </div>
  );
}

function EmphasisRow({ e, lectureTitle, lectureId }: { e: NonNullable<TodayData['digest']>['emphasis'][number]; lectureTitle: string; lectureId: string }) {
  const { play } = useSensei();
  const { data } = useApi<{ audioSourceId: string | null }>(`lecture/${lectureId}`);
  const audio = data?.audioSourceId;
  return (
    <div className="s-row" style={{ alignItems: 'flex-start' }}>
      <span className="s-pill exam" style={{ marginTop: 1 }}>Exam</span>
      <div className="s-row-main">
        <div className="t-callout">
          <TermText text={e.statement} />
        </div>
        {audio && e.startMs != null && (
          <div className="s-src">
            <button className="s-play" onClick={() => play({ sourceId: audio, startMs: e.startMs!, label: `${lectureTitle} · ${fmtTime(e.startMs)}` })}>
              <PlayIcon />
              Hear it, {fmtTime(e.startMs)}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReinforcedList({ items }: { items: NonNullable<TodayData['digest']>['reinforced'] }) {
  const { openConcept } = useSensei();
  return (
    <div className="s-list">
      {items.slice(0, 6).map((c) => (
        <Row
          key={c.id}
          title={c.name}
          sub={c.firstSeen ? `First taught ${fmtDate(c.firstSeen)}, now in ${c.lectureCount} classes` : undefined}
          trailing={c.emphasis > 0 ? <span className="s-pill exam">Exam</span> : undefined}
          onClick={() => openConcept(c.id)}
        />
      ))}
    </div>
  );
}

function CheckThese({ items }: { items: TodayData['flagged'] }) {
  const { play, openConcept, toast } = useSensei();
  const [done, setDone] = useState<Set<string>>(new Set());
  const decide = async (id: string, decision: 'confirm' | 'reject') => {
    setDone((s) => new Set(s).add(id));
    await api(`flag/${id}`, { method: 'POST', body: JSON.stringify({ decision }) });
    toast(decision === 'confirm' ? 'Kept in your notes' : 'Removed from your notes');
    invalidate('today', 'concept');
  };
  const left = items.filter((i) => !done.has(i.recordId));
  if (left.length === 0) return null;
  return (
    <Section title="Worth a quick check" footer="Sensei couldn’t confirm these. Listen, then keep or remove each one. Anything you skip stays marked unconfirmed.">
      <div style={{ display: 'grid', gap: 10 }}>
        {left.map((f) => (
          <div key={f.recordId} className="s-card">
            <button className="t-foot tint" style={{ fontWeight: 600 }} onClick={() => openConcept(f.conceptId)}>
              {f.conceptName}
            </button>
            <div className="t-callout" style={{ marginTop: 4 }}>
              <TermText text={f.statement} />
            </div>
            {f.notes[0] && <div className="t-foot" style={{ color: 'var(--orange)', marginTop: 4 }}>{humanNote(f.notes[0])}</div>}
            <div className="s-actions" style={{ marginTop: 12, alignItems: 'center' }}>
              {f.audioSourceId && f.startMs != null && (
                <button className="s-play" style={{ height: 34, borderRadius: 17, padding: '0 12px' }} onClick={() => play({ sourceId: f.audioSourceId!, startMs: f.startMs!, label: `${f.lectureTitle ?? 'Lecture'} · ${fmtTime(f.startMs)}` })}>
                  <PlayIcon />
                  Listen
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button className="s-btn small gray" onClick={() => decide(f.recordId, 'reject')}>
                Remove
              </button>
              <button className="s-btn small" onClick={() => decide(f.recordId, 'confirm')}>
                Keep
              </button>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

const STEP_LABEL: Record<string, string> = {
  ingest: 'Saving', transcribe: 'Transcribing', extract: 'Finding key ideas', verify: 'Checking numbers',
  summarize: 'Summarizing', cards: 'Making review cards', lesson: 'Building tonight’s lesson',
};

function JobCard({ job, courses }: { job: Job; courses: string[] }) {
  const { toast } = useSensei();
  const act = async (action: 'retry' | 'course', courseCode?: string) => {
    await api(`job/${job.id}/${action}`, { method: 'POST', body: JSON.stringify({ courseCode }) });
    invalidate('today');
    toast(action === 'retry' ? 'Trying again' : `Filed under ${courseCode}`);
  };
  const name = job.title && job.title !== 'New lecture' ? job.title : job.files[0] ?? 'Lecture';
  return (
    <div className="s-card" style={{ marginTop: 12 }}>
      <div className="s-status">
        {job.status === 'failed' ? (
          <Ring value={1} color="var(--red)" size={40} stroke={4}>
            <span style={{ color: 'var(--red)', fontWeight: 700 }}>!</span>
          </Ring>
        ) : job.status === 'needs_course' ? (
          <Ring value={0} size={40} stroke={4}>
            <span className="tint" style={{ fontWeight: 700 }}>?</span>
          </Ring>
        ) : (
          <Ring value={Math.max(0.04, job.progress)} size={40} stroke={4} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-headline clamp1">{name}</div>
          <div className="t-sub c2 clamp2">
            {job.status === 'failed'
              ? job.error ?? 'Something went wrong.'
              : job.status === 'needs_course'
                ? 'Which class was this recording from?'
                : job.status === 'queued'
                  ? 'Waiting to start'
                  : job.detail ?? STEP_LABEL[job.step ?? ''] ?? 'Working'}
          </div>
        </div>
        {job.status === 'failed' && (
          <button className="s-btn small" onClick={() => act('retry')}>
            Retry
          </button>
        )}
      </div>
      {job.status === 'needs_course' && (
        <div className="s-chips wrap" style={{ padding: 0, marginTop: 12 }}>
          {courses.length === 0 && <span className="t-sub c2">Add your classes first (tap the person icon).</span>}
          {courses.map((c) => (
            <button key={c} className="s-chip" onClick={() => act('course', c)}>
              {c}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Welcome({ hasCourses }: { hasCourses: boolean }) {
  const { openSheet } = useSensei();
  return (
    <>
      <div className="s-empty">
        <WaveGlyph className="glyph" />
        <h2 className="t-title2">Every lecture, remembered</h2>
        <p className="t-callout c2" style={{ marginTop: 8 }}>
          Sensei listens to your recordings, pulls out what your professor taught, and connects it to everything you’ve learned so far.
        </p>
      </div>
      <div className="s-steps" style={{ marginTop: 20 }}>
        <div className="s-step">
          <span className="s-step-n" />
          <div>
            <div className="t-headline">Add your classes</div>
            <div className="t-sub c2">Once. Sensei then knows which class a recording is from.</div>
          </div>
        </div>
        <div className="s-step">
          <span className="s-step-n" />
          <div>
            <div className="t-headline">Record class, then share it here</div>
            <div className="t-sub c2">Add the recording and the slides. That’s your only job.</div>
          </div>
        </div>
        <div className="s-step">
          <span className="s-step-n" />
          <div>
            <div className="t-headline">Open Sensei tonight</div>
            <div className="t-sub c2">A lesson on today’s class, review cards, and every term explained.</div>
          </div>
        </div>
      </div>
      <div style={{ margin: '20px 16px 0', display: 'grid', gap: 10 }}>
        {!hasCourses && (
          <button className="s-btn" onClick={() => openSheet({ kind: 'settings' })}>
            Add your classes
          </button>
        )}
        <button className={`s-btn${hasCourses ? '' : ' gray'}`} onClick={() => openSheet({ kind: 'add' })}>
          Add a lecture
        </button>
      </div>
    </>
  );
}
