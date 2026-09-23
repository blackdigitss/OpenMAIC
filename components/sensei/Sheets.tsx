'use client';

import { useRef, useState } from 'react';

import { api, COURSE_COLORS, invalidate, useApi, type Course } from './api';
import { CloseIcon, DocIcon, MicIcon } from './icons';
import { useSensei } from './store';
import { Section } from './ui';

const CHUNK = 8 * 1024 * 1024; // stays under proxy request limits (Cloudflare: 100 MB)

async function uploadFile(uploadId: string, file: File, onBytes: (n: number) => void) {
  let offset = 0;
  while (offset < file.size) {
    const blob = file.slice(offset, offset + CHUNK);
    let attempt = 0;
    for (;;) {
      try {
        const res = await fetch(`/api/sensei/upload/${uploadId}?name=${encodeURIComponent(file.name)}&offset=${offset}`, {
          method: 'POST',
          body: blob,
        });
        const body = (await res.json()) as { received: number };
        if (!res.ok && res.status !== 409) throw new Error('Upload failed');
        offset = body.received; // server is the source of truth, so a retry resumes where it left off
        break;
      } catch (e) {
        if (++attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    onBytes(offset);
  }
}

/** crypto.randomUUID exists only in secure contexts (HTTPS/localhost); fall back for LAN http. */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function fmtSize(n: number) {
  return n > 1e6 ? `${(n / 1e6).toFixed(n > 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function AddLectureSheet({ onClose }: { onClose: () => void }) {
  const { toast } = useSensei();
  const { data: courses } = useApi<Course[]>('courses');
  const [files, setFiles] = useState<File[]>([]);
  const [course, setCourse] = useState<string>('auto');
  const [sent, setSent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const total = files.reduce((n, f) => n + f.size, 0);
  const hasSchedule = courses?.some((c) => c.schedule.length > 0);

  const add = (list: FileList | null) => list && setFiles((f) => [...f, ...Array.from(list).filter((x) => !f.some((y) => y.name === x.name && y.size === x.size))]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const uploadId = uuid();
      let base = 0;
      for (const f of files) {
        await uploadFile(uploadId, f, (n) => setSent(base + n));
        base += f.size;
      }
      const audio = files.find((f) => !f.name.toLowerCase().endsWith('.pdf'));
      await api(`upload/${uploadId}/done`, {
        method: 'POST',
        body: JSON.stringify({ names: files.map((f) => f.name), courseCode: course === 'auto' ? null : course, lastModified: audio?.lastModified }),
      });
      invalidate('today');
      toast('Added. Sensei is on it.');
      onClose();
    } catch (e) {
      setErr(`${(e as Error).message}. Your connection may have dropped. Tap Add to resume.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="s-sheet-bar">
        <button className="s-link" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <span className="t-headline">Add a lecture</span>
        <button className="s-link" style={{ fontWeight: 600, opacity: files.length && !busy ? 1 : 0.35 }} disabled={!files.length || busy} onClick={submit}>
          Add
        </button>
      </div>
      <p className="t-sub c2" style={{ padding: '8px 20px 0' }}>
        Add today’s recording, and the slides if your professor shared them. Sensei does the rest.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '16px 16px 0' }}>
        <button className="s-card" style={{ display: 'grid', justifyItems: 'center', gap: 8, padding: '20px 12px', margin: 0 }} onClick={() => audioInput.current?.click()}>
          <MicIcon style={{ width: 30, height: 30, color: 'var(--pink)' }} />
          <span className="t-headline">Recording</span>
          <span className="t-foot c2">From Voice Memos or Files</span>
        </button>
        <button className="s-card" style={{ display: 'grid', justifyItems: 'center', gap: 8, padding: '20px 12px', margin: 0 }} onClick={() => pdfInput.current?.click()}>
          <DocIcon style={{ width: 30, height: 30, color: 'var(--tint)' }} />
          <span className="t-headline">Slides</span>
          <span className="t-foot c2">PDF</span>
        </button>
      </div>
      <input ref={audioInput} type="file" accept="audio/*,.m4a,.mp3,.wav,.aac,video/mp4,.txt,.vtt" multiple hidden onChange={(e) => add(e.target.files)} />
      <input ref={pdfInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => add(e.target.files)} />

      {files.length > 0 && (
        <Section title="Files">
          <div className="s-list">
            {files.map((f) => (
              <div key={f.name + f.size} className="s-row">
                {f.name.toLowerCase().endsWith('.pdf') ? <DocIcon style={{ width: 22, height: 22, color: 'var(--tint)' }} /> : <MicIcon style={{ width: 22, height: 22, color: 'var(--pink)' }} />}
                <div className="s-row-main">
                  <div className="s-row-title clamp1">{f.name}</div>
                  <div className="s-row-sub">{fmtSize(f.size)}</div>
                </div>
                {!busy && (
                  <button aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((x) => x !== f))} style={{ width: 26, height: 26 }}>
                    <CloseIcon />
                  </button>
                )}
              </div>
            ))}
          </div>
          {busy && (
            <div style={{ margin: '12px 20px 0' }}>
              <div className="s-progress">
                <div style={{ width: `${total ? (sent / total) * 100 : 0}%` }} />
              </div>
              <p className="t-foot c2 num" style={{ marginTop: 6 }}>
                Uploading {fmtSize(sent)} of {fmtSize(total)}. Keep Sensei open.
              </p>
            </div>
          )}
          {err && <p className="s-foot" style={{ color: 'var(--red)' }}>{err}</p>}
        </Section>
      )}

      <Section title="Class" footer={hasSchedule ? 'Automatic uses your class schedule and the time the recording was made.' : 'Add your class schedule to have this picked automatically.'}>
        <div className="s-chips wrap">
          {hasSchedule && (
            <button className="s-chip" aria-pressed={course === 'auto'} style={course === 'auto' ? { background: 'var(--tint)', color: 'var(--on-tint)' } : undefined} onClick={() => setCourse('auto')}>
              Automatic
            </button>
          )}
          {courses?.map((c) => (
            <button
              key={c.id}
              className="s-chip"
              aria-pressed={course === c.code}
              style={course === c.code ? { background: c.color ?? 'var(--tint)', color: '#fff' } : undefined}
              onClick={() => setCourse(c.code)}
            >
              {c.code}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Faster next time" footer="In Voice Memos, tap Share, then Save to Files, and choose the “Sensei Inbox” folder in iCloud Drive. Sensei picks it up automatically, even if this app is closed.">
        <span />
      </Section>
    </>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const { data: courses, reload } = useApi<Course[]>('courses');
  const [editing, setEditing] = useState<Partial<Course> | null>(null);
  return (
    <>
      <div className="s-sheet-bar">
        {editing ? (
          <button className="s-link" onClick={() => setEditing(null)}>
            Cancel
          </button>
        ) : (
          <span />
        )}
        <span className="t-headline">{editing ? (editing.id ? 'Edit class' : 'New class') : 'Your classes'}</span>
        {editing ? (
          <span style={{ width: 50 }} />
        ) : (
          <button className="s-link" style={{ fontWeight: 600 }} onClick={onClose}>
            Done
          </button>
        )}
      </div>
      {editing ? (
        <CourseForm
          initial={editing}
          onSaved={() => {
            setEditing(null);
            void reload();
            invalidate('today', 'courses');
          }}
        />
      ) : (
        <>
          <Section footer="Sensei uses your schedule to file each recording under the right class automatically.">
            <div className="s-list">
              {courses?.map((c) => (
                <button key={c.id} className="s-row" onClick={() => setEditing(c)}>
                  <span className="s-dot" style={{ background: c.color ?? 'var(--tint)', width: 12, height: 12, borderRadius: 6 }} />
                  <div className="s-row-main">
                    <div className="s-row-title">
                      {c.code} <span className="c2">{c.title !== c.code ? c.title : ''}</span>
                    </div>
                    <div className="s-row-sub">
                      {c.schedule.length ? c.schedule.map((s) => `${DAYS[s.weekday]} ${s.start}`).join(', ') : 'No schedule yet'}
                    </div>
                  </div>
                </button>
              ))}
              <button className="s-row" onClick={() => setEditing({ code: '', title: '', color: COURSE_COLORS[(courses?.length ?? 0) % COURSE_COLORS.length], schedule: [] })}>
                <span className="s-row-title tint">Add a class</span>
              </button>
            </div>
          </Section>
          <Section title="About" footer="Sensei is a study aid. Its explanations are for learning, not for real patient care.">
            <div className="s-list">
              <div className="s-row">
                <div className="s-row-main">
                  <div className="s-row-title">Add to Home Screen</div>
                  <div className="s-row-sub" style={{ whiteSpace: 'normal' }}>
                    In Safari, tap Share, then Add to Home Screen. Sensei opens full screen like any app.
                  </div>
                </div>
              </div>
            </div>
          </Section>
        </>
      )}
    </>
  );
}

function CourseForm({ initial, onSaved }: { initial: Partial<Course>; onSaved: () => void }) {
  const [code, setCode] = useState(initial.code ?? '');
  const [title, setTitle] = useState(initial.title ?? '');
  const [color, setColor] = useState(initial.color ?? COURSE_COLORS[0]);
  const [days, setDays] = useState<number[]>([...new Set((initial.schedule ?? []).map((s) => s.weekday))]);
  const [start, setStart] = useState(initial.schedule?.[0]?.start ?? '09:00');
  const [end, setEnd] = useState(initial.schedule?.[0]?.end ?? '11:00');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    await api('courses', {
      method: 'POST',
      body: JSON.stringify({ code, title: title || code, color, schedule: days.map((weekday) => ({ weekday, start, end })) }),
    });
    setBusy(false);
    onSaved();
  };
  return (
    <>
      <Section>
        <div className="s-list">
          <div className="s-field">
            <label>Short name</label>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="RESP 110" autoCapitalize="characters" disabled={!!initial.id} />
          </div>
          <div className="s-field">
            <label>Full name</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Respiratory Physiology" />
          </div>
        </div>
      </Section>
      <Section title="Color">
        <div className="s-list">
          <div className="s-swatches">
            {COURSE_COLORS.map((c) => (
              <button key={c} className="s-swatch" aria-label={c} aria-pressed={c === color} style={{ background: c, color: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
      </Section>
      <Section title="When it meets" footer="Same time on each selected day. Recordings made within 45 minutes of class are filed here.">
        <div className="s-list">
          <div className="s-days">
            {DAYS.map((d, i) => (
              <button key={d} aria-pressed={days.includes(i)} onClick={() => setDays((all) => (all.includes(i) ? all.filter((x) => x !== i) : [...all, i]))}>
                {d[0]}
              </button>
            ))}
          </div>
          <div className="s-field">
            <label>Starts</label>
            <span style={{ flex: 1 }} />
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="s-field">
            <label>Ends</label>
            <span style={{ flex: 1 }} />
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
      </Section>
      <div style={{ margin: '24px 16px 0' }}>
        <button className="s-btn" disabled={!code.trim() || busy} onClick={save}>
          Save class
        </button>
      </div>
    </>
  );
}
