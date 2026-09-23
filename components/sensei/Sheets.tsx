'use client';

import { useRef, useState } from 'react';

import { api, COURSE_COLORS, invalidate, useApi, type BudgetData, type Course, type ModuleInfo, type SettingsData } from './api';
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
  const [roles, setRoles] = useState<Map<File, 'recording' | 'slides' | 'textbook'>>(new Map());
  const [course, setCourse] = useState<string>('auto');
  const [sent, setSent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const bookInput = useRef<HTMLInputElement>(null);
  const onlyBooks = files.length > 0 && files.every((f) => roles.get(f) === 'textbook');
  const total = files.reduce((n, f) => n + f.size, 0);
  const hasSchedule = courses?.some((c) => c.schedule.length > 0);

  const add = (list: FileList | null, role: 'recording' | 'slides' | 'textbook') => {
    if (!list) return;
    const incoming = Array.from(list);
    setFiles((f) => [...f, ...incoming.filter((x) => !f.some((y) => y.name === x.name && y.size === x.size))]);
    setRoles((m) => {
      const next = new Map(m);
      for (const x of incoming) next.set(x, role);
      return next;
    });
  };

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
        body: JSON.stringify({
          names: files.map((f) => f.name),
          roles: Object.fromEntries(files.map((f) => [f.name, roles.get(f) ?? 'recording'])),
          courseCode: course === 'auto' ? null : course,
          lastModified: audio?.lastModified,
        }),
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
        Add each class recording on its own. Add the week’s slides once, whenever you get them. Sensei links them up.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, margin: '16px 16px 0' }}>
        {(
          [
            { role: 'recording', label: 'Recording', sub: 'One class', Icon: MicIcon, color: 'var(--pink)', ref: audioInput },
            { role: 'slides', label: 'Slides', sub: 'The week’s deck', Icon: DocIcon, color: 'var(--tint)', ref: pdfInput },
            { role: 'textbook', label: 'Textbook', sub: 'Reference', Icon: DocIcon, color: 'var(--indigo)', ref: bookInput },
          ] as const
        ).map(({ role, label, sub, Icon, color, ref }) => (
          <button key={role} className="s-card" style={{ display: 'grid', justifyItems: 'center', gap: 6, padding: '16px 6px', margin: 0 }} onClick={() => ref.current?.click()}>
            <Icon style={{ width: 28, height: 28, color }} />
            <span className="t-headline">{label}</span>
            <span className="t-foot c2" style={{ textAlign: 'center' }}>{sub}</span>
          </button>
        ))}
      </div>
      <input ref={audioInput} type="file" accept="audio/*,.m4a,.mp3,.wav,.aac,video/mp4,.txt,.vtt" multiple hidden onChange={(e) => add(e.target.files, 'recording')} />
      <input ref={pdfInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => add(e.target.files, 'slides')} />
      <input ref={bookInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => add(e.target.files, 'textbook')} />

      {files.length > 0 && (
        <Section title="Files">
          <div className="s-list">
            {files.map((f) => (
              <div key={f.name + f.size} className="s-row">
                {roles.get(f) === 'recording' ? (
                  <MicIcon style={{ width: 22, height: 22, color: 'var(--pink)' }} />
                ) : (
                  <DocIcon style={{ width: 22, height: 22, color: roles.get(f) === 'textbook' ? 'var(--indigo)' : 'var(--tint)' }} />
                )}
                <div className="s-row-main">
                  <div className="s-row-title clamp1">{f.name}</div>
                  <div className="s-row-sub">
                    {roles.get(f) === 'textbook' ? 'Textbook' : roles.get(f) === 'slides' ? 'Slides' : 'Recording'}, {fmtSize(f.size)}
                  </div>
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

      {!onlyBooks && <Section title="Class" footer={hasSchedule ? 'Automatic uses your class schedule and the time the recording was made.' : 'Add your class schedule to have this picked automatically.'}>
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
      </Section>}

      {onlyBooks && (
        <p className="s-foot" style={{ paddingTop: 16 }}>
          Textbooks are indexed page by page and used whenever a concept needs more depth, with page numbers. Adding one costs nothing.
        </p>
      )}

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
          <NotificationsSection />
          <BudgetSection />
          <ModulesSection />
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

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className="s-switch" data-on={on ? '1' : undefined} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

function NotificationsSection() {
  const { toast } = useSensei();
  const { data: s, reload } = useApi<SettingsData>('settings');
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const save = async (patch: Partial<SettingsData>) => {
    await api('settings', { method: 'POST', body: JSON.stringify(patch) });
    void reload();
  };
  const enable = async () => {
    setBusy(true);
    try {
      // Must run inside the tap: iOS only shows the permission prompt for a user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('Notifications are off in iPhone Settings');
        return;
      }
      const reg = await navigator.serviceWorker.register('/sensei-sw.js', { scope: '/sensei', updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(s.pushKey!) });
      await api('push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
      await api('push/test', { method: 'POST' });
      toast('Notifications on');
      void reload();
    } catch (e) {
      toast((e as Error).message || 'Couldn’t turn on notifications');
    } finally {
      setBusy(false);
    }
  };
  const canPush = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && isStandalone();
  return (
    <Section
      title="Notifications"
      footer={
        !s.pushKey
          ? 'Notifications will be available after the next Sensei update.'
          : canPush
            ? 'One evening summary with tonight’s lesson and cards, plus a heads-up if something goes wrong. Nothing else.'
            : 'Open Sensei from its Home Screen icon to turn on notifications (iPhone only allows them for home-screen apps).'
      }
    >
      <div className="s-list">
        {s.pushKey && canPush && (
          <div className="s-row">
            <div className="s-row-main">
              <div className="s-row-title">{s.pushDevices > 0 ? 'On for this device' : 'Off'}</div>
              <div className="s-row-sub">{s.pushDevices > 0 ? `${s.pushDevices} device${s.pushDevices === 1 ? '' : 's'} signed up` : 'Get tonight’s summary on your lock screen'}</div>
            </div>
            <button className="s-btn small" disabled={busy} onClick={enable}>
              {s.pushDevices > 0 ? 'Send test' : 'Turn on'}
            </button>
          </div>
        )}
        <div className="s-field">
          <label style={{ width: 'auto', flex: 1 }}>Evening summary</label>
          <input type="time" value={s.digestTime} onChange={(e) => save({ digestTime: e.target.value })} disabled={!s.notify.digest} />
          <Toggle on={s.notify.digest} label="Evening summary" onChange={(v) => save({ notify: { ...s.notify, digest: v } })} />
        </div>
        <div className="s-field">
          <label style={{ width: 'auto', flex: 1 }}>When something goes wrong</label>
          <Toggle on={s.notify.failures} label="Problems" onChange={(v) => save({ notify: { ...s.notify, failures: v } })} />
        </div>
        <div className="s-field">
          <label style={{ width: 'auto', flex: 1 }}>Budget alerts</label>
          <Toggle on={s.notify.budget} label="Budget alerts" onChange={(v) => save({ notify: { ...s.notify, budget: v } })} />
        </div>
      </div>
    </Section>
  );
}

function BudgetSection() {
  const { data: b, reload } = useApi<BudgetData>('budget');
  const { data: s, reload: reloadSettings } = useApi<SettingsData>('settings');
  if (!b || !s) return null;
  const setBudget = async (usd: number) => {
    await api('settings', { method: 'POST', body: JSON.stringify({ budgetUsd: Math.max(5, Math.round(usd)) }) });
    void reload();
    void reloadSettings();
    invalidate('today');
  };
  const pct = Math.min(1, b.total / b.budgetUsd);
  const suggest = b.daysWithData >= 14 && b.projected ? Math.ceil((b.projected * 1.25) / 5) * 5 : null;
  return (
    <Section
      title="Budget"
      footer="Prices come from Google’s published rates, so amounts are close estimates. Sensei never switches to cheaper models on its own; at the limit it only warns you, unless you choose to pause."
    >
      <div className="s-card" style={{ margin: '0 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div className="t-title2 num">≈${b.total.toFixed(2)}</div>
          <div className="t-sub c2">of ${b.budgetUsd} this month</div>
        </div>
        <div className="s-progress" style={{ marginTop: 10 }}>
          <div style={{ width: `${pct * 100}%`, background: pct >= 1 ? 'var(--red)' : pct >= 0.8 ? 'var(--orange)' : undefined }} />
        </div>
        {b.projected != null && <div className="t-foot c2" style={{ marginTop: 6 }}>At this pace: about ${b.projected.toFixed(0)} this month</div>}
        {suggest && Math.abs(suggest - b.budgetUsd) >= 5 && (
          <button className="s-btn small gray" style={{ marginTop: 10 }} onClick={() => setBudget(suggest)}>
            Set budget to ${suggest} (your pace + 25%)
          </button>
        )}
      </div>
      {b.byPurpose.length > 0 && (
        <div className="s-list" style={{ marginTop: 12 }}>
          {b.byPurpose.map((p) => (
            <div key={p.purpose} className="s-row">
              <div className="s-row-main">
                <div className="s-row-title">{p.label}</div>
              </div>
              <span className="s-trail num">${p.usd.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="s-list" style={{ marginTop: 12 }}>
        <div className="s-field">
          <label style={{ width: 'auto', flex: 1 }}>Monthly budget</label>
          <button className="s-btn small gray" aria-label="Lower budget" onClick={() => setBudget(b.budgetUsd - 10)}>−</button>
          <span className="t-headline num" style={{ minWidth: 48, textAlign: 'center' }}>${b.budgetUsd}</span>
          <button className="s-btn small gray" aria-label="Raise budget" onClick={() => setBudget(b.budgetUsd + 10)}>+</button>
        </div>
        <div className="s-field">
          <label style={{ width: 'auto', flex: 1 }}>Pause new lectures at the limit</label>
          <Toggle
            on={s.pauseAtBudget}
            label="Pause at limit"
            onChange={async (v) => {
              await api('settings', { method: 'POST', body: JSON.stringify({ pauseAtBudget: v }) });
              void reloadSettings();
            }}
          />
        </div>
      </div>
    </Section>
  );
}

function ModulesSection() {
  const { data: modules, reload } = useApi<ModuleInfo[]>('modules');
  if (!modules?.length) return null;
  const save = async (m: ModuleInfo, start: string, end: string) => {
    await api('modules', { method: 'POST', body: JSON.stringify({ id: m.id, start, end }) });
    void reload();
    invalidate('today');
  };
  return (
    <Section
      title="Modules"
      footer={modules.some((m) => m.estimated) ? 'Dates marked “estimated” come from the college calendar. Adjust them if your professor’s dates differ.' : 'When a module ends, its one-time details retire from review; foundational concepts keep going.'}
    >
      <div className="s-list">
        {modules.map((m) => (
          <div key={m.id} className="s-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div className="s-row-title">
                {m.courseCode} Module {m.number}
              </div>
              {m.estimated && <span className="s-pill muted">Estimated</span>}
            </div>
            <div className="s-row-sub" style={{ whiteSpace: 'normal' }}>
              {[m.instructor, m.title].filter(Boolean).join(', ')}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} className="s-field-inline">
              <input type="date" defaultValue={m.start} onBlur={(e) => e.target.value !== m.start && save(m, e.target.value, m.end)} aria-label="Starts" />
              <span className="c2">to</span>
              <input type="date" defaultValue={m.end} onBlur={(e) => e.target.value !== m.end && save(m, m.start, e.target.value)} aria-label="Ends" />
            </div>
          </div>
        ))}
      </div>
    </Section>
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
