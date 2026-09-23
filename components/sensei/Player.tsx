'use client';

import { useEffect, useState } from 'react';

import { fmtTime } from './api';
import { CloseIcon, PauseIcon, PlayIcon, SkipIcon } from './icons';
import { sharedAudio, useSensei } from './store';

function seekBy(delta: number) {
  const el = sharedAudio();
  el.currentTime = Math.max(0, el.currentTime + delta);
}

function seekTo(t: number) {
  sharedAudio().currentTime = t;
}

/** Floating now-playing bar for lecture audio (above the tab bar, or over a sheet). */
export function Player({ inSheet }: { inSheet?: boolean }) {
  const { track, stopPlayer } = useSensei();
  const [, force] = useState(0);
  useEffect(() => {
    if (!track) return;
    const a = sharedAudio();
    const tick = () => force((n) => n + 1);
    const events = ['timeupdate', 'play', 'pause', 'loadedmetadata', 'ended', 'waiting', 'playing'];
    events.forEach((e) => a.addEventListener(e, tick));
    return () => events.forEach((e) => a.removeEventListener(e, tick));
  }, [track]);
  if (!track) return null;
  const a = sharedAudio();
  const dur = Number.isFinite(a.duration) ? a.duration : 0;
  return (
    <div className={`s-player${inSheet ? ' in-sheet' : ''}`} role="region" aria-label="Lecture audio">
      <div className="s-player-row">
        <button
          className="s-iconbtn"
          style={{ width: 36, height: 36, background: 'var(--tint)', color: 'var(--on-tint)' }}
          aria-label={a.paused ? 'Play' : 'Pause'}
          onClick={() => {
            const el = sharedAudio();
            if (el.paused) void el.play();
            else el.pause();
          }}
        >
          {a.paused ? <PlayIcon style={{ width: 14, height: 14, marginLeft: 2 }} /> : <PauseIcon style={{ width: 14, height: 14 }} />}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-sub clamp1" style={{ fontWeight: 600 }}>
            {track.label}
          </div>
          <div className="t-foot c2 num">
            {fmtTime(a.currentTime * 1000)} / {dur ? fmtTime(dur * 1000) : '–:––'}
          </div>
        </div>
        <button className="s-iconbtn" style={{ width: 36, height: 36 }} aria-label="Back 15 seconds" onClick={() => seekBy(-15)}>
          <SkipIcon back />
        </button>
        <button className="s-iconbtn" style={{ width: 36, height: 36 }} aria-label="Forward 15 seconds" onClick={() => seekBy(15)}>
          <SkipIcon />
        </button>
        <button aria-label="Close player" onClick={stopPlayer} style={{ width: 30, height: 30 }}>
          <CloseIcon />
        </button>
      </div>
      {dur > 0 && (
        <input
          type="range"
          min={0}
          max={dur}
          step={1}
          value={a.currentTime}
          aria-label="Seek"
          onChange={(e) => seekTo(Number(e.target.value))}
        />
      )}
    </div>
  );
}
