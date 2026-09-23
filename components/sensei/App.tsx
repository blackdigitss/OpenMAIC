'use client';

import { AnimatePresence } from 'motion/react';
import { useEffect } from 'react';

import { ConceptSheetBody } from './ConceptSheet';
import { CalcDrill } from './Calc';
import { CaseDrill } from './Case';
import { CloseIcon, LibraryIcon, ReviewIcon, TodayIcon } from './icons';
import { Library, LecturePage } from './Library';
import { Player } from './Player';
import { ReviewSession, ReviewTab } from './Review';
import { AddLectureSheet, SettingsSheet } from './Sheets';
import { SenseiProvider, useSensei, type Tab } from './store';
import { Today } from './Today';
import { Sheet } from './ui';
import { useApi, type TodayData } from './api';
import { LessonViewer } from './LessonViewer';

export function SenseiApp() {
  return (
    <SenseiProvider>
      <Shell />
    </SenseiProvider>
  );
}

/** Renew the access cookie whenever the app comes to the foreground (at most every 6 hours). */
function useRememberDevice() {
  useEffect(() => {
    const renew = () => {
      if (document.visibilityState !== 'visible') return;
      let last = 0;
      try {
        last = Number(localStorage.getItem('sensei.renewedAt') ?? 0);
      } catch {
        /* private mode */
      }
      if (Date.now() - last < 6 * 3600_000) return;
      void fetch('/api/access-code/sensei-renew', { method: 'POST' }).then((r) => {
        if (!r.ok) return;
        try {
          localStorage.setItem('sensei.renewedAt', String(Date.now()));
        } catch {
          /* ignore */
        }
      });
    };
    renew();
    document.addEventListener('visibilitychange', renew);
    return () => document.removeEventListener('visibilitychange', renew);
  }, []);
}

function Shell() {
  useRememberDevice();
  const { tab, setTab, routes, sheets, popSheet, closeSheets, reviewing, track } = useSensei();
  const route = routes[tab][routes[tab].length - 1];
  const top = sheets[sheets.length - 1];
  const lesson = top?.kind === 'lesson' ? top : null;
  const { data } = useApi<TodayData>('today');
  const due = data ? data.stats.due + Math.min(data.stats.newCards, 15) : 0;

  let screen: React.ReactNode;
  if (route.name === 'lecture') screen = <LecturePage key={route.id} id={route.id} />;
  else if (tab === 'today') screen = <Today />;
  else if (tab === 'review') screen = <ReviewTab />;
  else screen = <Library />;

  const tabs: { id: Tab; label: string; Icon: typeof TodayIcon; badge?: number }[] = [
    { id: 'today', label: 'Today', Icon: TodayIcon },
    { id: 'review', label: 'Review', Icon: ReviewIcon, badge: due },
    { id: 'library', label: 'Library', Icon: LibraryIcon },
  ];

  return (
    <>
      <div className="s-app" data-sheet={top ? '1' : undefined}>
        {screen}
        <nav className="s-tabbar" role="tablist" aria-label="Sensei">
          {tabs.map(({ id, label, Icon, badge }) => (
            <button key={id} role="tab" aria-selected={tab === id} className="s-tab" onClick={() => setTab(id)}>
              <Icon filled={tab === id} />
              {label}
              {!!badge && <span className="s-badge">{badge > 99 ? '99+' : badge}</span>}
            </button>
          ))}
        </nav>
        {!top && !reviewing && <Player />}
      </div>

      <AnimatePresence>{lesson && <LessonViewer key="lesson" url={lesson.url} title={lesson.title} onClose={closeSheets} />}</AnimatePresence>

      <AnimatePresence>
        {top && !lesson && (
          <Sheet key="sheet" onClose={closeSheets} playerPad={!!track}>
            {top.kind === 'concept' ? (
              <ConceptSheetBody key={`${top.id}-${sheets.length}`} id={top.id} canGoBack={sheets.length > 1} onBack={popSheet} onClose={closeSheets} />
            ) : top.kind === 'calc' ? (
              <>
                <div className="s-sheet-bar">
                  <span />
                  <button aria-label="Close" onClick={closeSheets} style={{ width: 30, height: 30 }}>
                    <CloseIcon />
                  </button>
                </div>
                <CalcDrill formulaId={top.formulaId} />
              </>
            ) : top.kind === 'case' ? (
              <>
                <div className="s-sheet-bar">
                  <span />
                  <button aria-label="Close" onClick={closeSheets} style={{ width: 30, height: 30 }}>
                    <CloseIcon />
                  </button>
                </div>
                <CaseDrill family={top.family} />
              </>
            ) : top.kind === 'add' ? (
              <AddLectureSheet onClose={closeSheets} />
            ) : (
              <SettingsSheet onClose={closeSheets} />
            )}
          </Sheet>
        )}
      </AnimatePresence>
      {top && !lesson && !reviewing && <Player inSheet />}

      <AnimatePresence>{reviewing && <ReviewSession key="review" />}</AnimatePresence>
    </>
  );
}
