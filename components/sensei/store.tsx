'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import { useApi, type TermLink } from './api';

export type Tab = 'today' | 'review' | 'library';
export type Route = { name: 'root' } | { name: 'lecture'; id: string };
export type SheetEntry =
  | { kind: 'concept'; id: string }
  | { kind: 'add' }
  | { kind: 'settings' };

export interface PlayerTrack {
  sourceId: string;
  startMs: number;
  label: string;
}

interface Store {
  tab: Tab;
  setTab: (t: Tab) => void;
  routes: Record<Tab, Route[]>;
  push: (r: Route) => void;
  pop: () => void;
  sheets: SheetEntry[];
  openSheet: (s: SheetEntry) => void;
  pushSheet: (s: SheetEntry) => void;
  popSheet: () => void;
  closeSheets: () => void;
  openConcept: (id: string) => void;
  terms: TermLink[];
  play: (t: PlayerTrack) => void;
  track: PlayerTrack | null;
  stopPlayer: () => void;
  toast: (msg: string) => void;
  reviewConcept: string | null;
  startReview: (conceptId?: string | null) => void;
  endReview: () => void;
  reviewing: boolean;
}

const Ctx = createContext<Store | null>(null);

let audioEl: HTMLAudioElement | null = null;
let audioSource: string | null = null;
const NO_TERMS: TermLink[] = [];
/** One shared <audio>; started synchronously inside the tap so iOS allows playback. */
export function sharedAudio(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'metadata';
  }
  return audioEl;
}

function startAudio(t: PlayerTrack) {
  const a = sharedAudio();
  const url = `/api/sensei/audio/${t.sourceId}`;
  // Start 5 s early so the sentence is heard from its beginning (DECISIONS A8).
  const at = Math.max(0, t.startMs / 1000 - 5);
  if (audioSource !== url) {
    audioSource = url;
    a.src = `${url}#t=${at}`;
  } else {
    a.currentTime = at;
  }
  void a.play().catch(() => undefined);
}

export function useSensei(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSensei outside provider');
  return s;
}

function readTab(): Tab {
  try {
    const t = localStorage.getItem('sensei.tab');
    if (t === 'today' || t === 'review' || t === 'library') return t;
  } catch {
    /* private mode */
  }
  return 'today';
}

export function SenseiProvider({ children }: { children: ReactNode }) {
  const [tab, setTabState] = useState<Tab>(readTab);
  const [routes, setRoutes] = useState<Record<Tab, Route[]>>({ today: [{ name: 'root' }], review: [{ name: 'root' }], library: [{ name: 'root' }] });
  const [sheets, setSheets] = useState<SheetEntry[]>([]);
  const [track, setTrack] = useState<PlayerTrack | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewConcept, setReviewConcept] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { data: terms } = useApi<TermLink[]>('terms');

  const setTab = useCallback(
    (t: Tab) => {
      // Tapping the selected tab pops to its root, like iOS.
      if (t === tab) setRoutes((r) => ({ ...r, [t]: [{ name: 'root' }] }));
      setTabState(t);
      try {
        localStorage.setItem('sensei.tab', t);
      } catch {
        /* ignore */
      }
      window.scrollTo({ top: 0 });
    },
    [tab],
  );

  const store = useMemo<Store>(
    () => ({
      tab,
      setTab,
      routes,
      push: (r) => {
        setRoutes((all) => ({ ...all, [tab]: [...all[tab], r] }));
        window.scrollTo({ top: 0 });
      },
      pop: () => setRoutes((all) => ({ ...all, [tab]: all[tab].length > 1 ? all[tab].slice(0, -1) : all[tab] })),
      sheets,
      openSheet: (s) => setSheets([s]),
      pushSheet: (s) => setSheets((all) => [...all, s]),
      popSheet: () => setSheets((all) => all.slice(0, -1)),
      closeSheets: () => setSheets([]),
      openConcept: (id) =>
        setSheets((all) => {
          const top = all[all.length - 1];
          if (top?.kind === 'concept' && top.id === id) return all;
          return top?.kind === 'concept' ? [...all, { kind: 'concept', id }] : [{ kind: 'concept', id }];
        }),
      terms: terms ?? NO_TERMS,
      play: (t) => {
        startAudio(t);
        setTrack(t);
      },
      track,
      stopPlayer: () => {
        sharedAudio().pause();
        setTrack(null);
      },
      toast: (msg) => {
        setToastMsg(msg);
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
      },
      reviewConcept,
      reviewing,
      startReview: (conceptId) => {
        setReviewConcept(conceptId ?? null);
        setSheets([]);
        setReviewing(true);
      },
      endReview: () => {
        setReviewing(false);
        setReviewConcept(null);
      },
    }),
    [tab, setTab, routes, sheets, terms, track, reviewing, reviewConcept],
  );

  return (
    <Ctx.Provider value={store}>
      {children}
      {toastMsg && (
        <div className="s-toast" role="status">
          {toastMsg}
        </div>
      )}
    </Ctx.Provider>
  );
}
