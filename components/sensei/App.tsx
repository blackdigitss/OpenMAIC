'use client';

import { AnimatePresence } from 'motion/react';

import { ConceptSheetBody } from './ConceptSheet';
import { LibraryIcon, ReviewIcon, TodayIcon } from './icons';
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

function Shell() {
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
