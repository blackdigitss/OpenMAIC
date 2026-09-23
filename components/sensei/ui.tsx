'use client';

import { motion, useDragControls, type PanInfo } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { BackChevron, Chevron } from './icons';
import { useSensei } from './store';

/** Large-title screen whose compact bar fades in once the title scrolls under it. */
export function Screen({
  title,
  subtitle,
  back,
  actions,
  children,
  push,
}: {
  title: string;
  subtitle?: ReactNode;
  back?: { label: string; onBack: () => void };
  actions?: ReactNode;
  children: ReactNode;
  push?: boolean;
}) {
  const [compact, setCompact] = useState(false);
  const { track } = useSensei();
  useEffect(() => {
    const onScroll = () => setCompact(window.scrollY > 44);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <main className={`s-screen${push ? ' s-push' : ''}`} data-player={track ? '1' : undefined}>
      <div className="s-navbar" data-show={compact ? '1' : undefined} aria-hidden={!compact}>
        {back && (
          <div className="s-navbar-side l">
            <button className="s-back" onClick={back.onBack}>
              <BackChevron />
              {back.label}
            </button>
          </div>
        )}
        <div className="t-headline">{title}</div>
        {actions && <div className="s-navbar-side r">{actions}</div>}
      </div>
      <header className="s-header">
        <div className="s-header-row">
          {back ? (
            <button className="s-back" onClick={back.onBack}>
              <BackChevron />
              {back.label}
            </button>
          ) : (
            <span />
          )}
          <div className="s-header-actions">{actions}</div>
        </div>
        <h1 className="t-large">{title}</h1>
        {subtitle && <div className="s-subtitle t-sub c2">{subtitle}</div>}
      </header>
      {children}
    </main>
  );
}

export function Section({ title, more, footer, children, className }: { title?: ReactNode; more?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`s-section ${className ?? ''}`}>
      {title && (
        <div className="s-section-head">
          <h2 className="t-title3">{title}</h2>
          {more}
        </div>
      )}
      {children}
      {footer && <p className="s-foot">{footer}</p>}
    </section>
  );
}

export function Row({
  title,
  sub,
  leading,
  trailing,
  onClick,
  chevron,
  inset,
  subClamp = 1,
}: {
  title: ReactNode;
  sub?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  inset?: number;
  subClamp?: 1 | 2 | 0;
}) {
  const content = (
    <>
      {leading}
      <div className="s-row-main">
        <div className="s-row-title">{title}</div>
        {sub && <div className={`s-row-sub ${subClamp === 1 ? 'clamp1' : subClamp === 2 ? 'clamp2' : ''}`}>{sub}</div>}
      </div>
      {trailing && <div className="s-trail">{trailing}</div>}
      {(chevron ?? !!onClick) && <Chevron />}
    </>
  );
  const style = inset ? ({ '--inset': `${inset}px` } as React.CSSProperties) : undefined;
  return onClick ? (
    <button className="s-row" onClick={onClick} style={style}>
      {content}
    </button>
  ) : (
    <div className="s-row" style={style}>
      {content}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const i = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="s-seg" role="group">
      <div className="s-seg-thumb" style={{ left: `calc(2px + ${i} * (100% - 4px) / ${options.length})`, width: `calc((100% - 4px) / ${options.length})` }} />
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Ring({ value, size = 44, stroke = 5, color = 'var(--tint)', children }: { value: number; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: size, height: size }} className="s-ring">
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(1, Math.max(0, value)))}
        />
      </svg>
      {children && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>{children}</div>}
    </div>
  );
}

/**
 * Signature element: the last 7 days drawn as a ventilator pressure trace.
 * Each class day is one breath whose peak height is the concepts learned;
 * days without class stay flat at baseline, like PEEP between breaths.
 */
export function BreathWave({ week }: { week: { date: string; concepts: number }[] }) {
  const W = 360;
  const H = 88;
  const base = H - 14;
  const byDay = new Map<string, number>();
  for (const w of week) byDay.set(w.date, (byDay.get(w.date) ?? 0) + w.concepts);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return byDay.get(key) ?? 0;
  });
  const max = Math.max(8, ...days);
  const slot = W / 7;
  let d = `M0 ${base}`;
  days.forEach((concepts, i) => {
    if (!concepts) return;
    const x = slot * i + slot * 0.12;
    const peak = base - 14 - (concepts / max) * (base - 24);
    const rise = slot * 0.1;
    const plateau = slot * 0.24;
    const fall = slot * 0.5;
    d += ` L${x} ${base} C${x + rise * 0.3} ${peak + 6} ${x + rise * 0.6} ${peak} ${x + rise} ${peak}`;
    d += ` L${x + rise + plateau} ${peak + 4}`;
    d += ` C${x + rise + plateau + fall * 0.15} ${base} ${x + rise + plateau + fall * 0.4} ${base} ${x + rise + plateau + fall} ${base}`;
  });
  d += ` L${W} ${base}`;
  const labels = Array.from({ length: 7 }, (_, i) => {
    const dt = new Date();
    dt.setDate(dt.getDate() - (6 - i));
    return dt.toLocaleDateString(undefined, { weekday: 'narrow' });
  });
  return (
    <div style={{ position: 'relative' }}>
      <svg className="s-hero-wave" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label={`Concepts learned per class day this week: ${days.join(', ')}`} role="img">
        <defs>
          <linearGradient id="s-wave-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className="fill" d={`${d} L${W} ${H} L0 ${H} Z`} fill="url(#s-wave-fill)" />
        <path className="trace" d={d} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" pathLength={1} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="s-wave-days" aria-hidden>
        {labels.map((l, i) => (
          <span key={i} data-on={days[i] ? '1' : undefined}>{l}</span>
        ))}
      </div>
    </div>
  );
}

/** Card-style sheet (iOS page sheet): slides up, drag the grabber or bar down to dismiss. */
export function Sheet({ onClose, bar, children, playerPad }: { onClose: () => void; bar?: ReactNode; children: ReactNode; playerPad?: boolean }) {
  const controls = useDragControls();
  const bodyRef = useRef<HTMLDivElement>(null);
  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 140 || info.velocity.y > 600) onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <motion.div className="s-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="s-sheet"
        role="dialog"
        aria-modal="true"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 34, stiffness: 340, mass: 0.9 }}
        drag="y"
        dragControls={controls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.9 }}
        onDragEnd={onDragEnd}
      >
        <div className="s-sheet-grab" onPointerDown={(e) => controls.start(e)} />
        {bar && (
          <div className="s-sheet-bar" onPointerDown={(e) => controls.start(e)}>
            {bar}
          </div>
        )}
        <div className="s-sheet-body" ref={bodyRef} data-player={playerPad ? '1' : undefined}>
          {children}
        </div>
      </motion.div>
    </>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="s-list" style={{ padding: 16, display: 'grid', gap: 10 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="s-skel" style={{ height: 14, width: `${90 - i * 17}%` }} />
      ))}
    </div>
  );
}

export function CourseTag({ code, color }: { code: string; color: string | null }) {
  return (
    <span className="s-course">
      <span className="s-dot" style={{ background: color ?? 'var(--tint)' }} />
      {code}
    </span>
  );
}
