'use client';

import { motion } from 'motion/react';
import { useState } from 'react';

/**
 * Tonight's OpenMAIC classroom, presented full screen inside Sensei. A home-screen
 * app has no browser back button, so the lesson opens as a same-origin sheet with
 * Done instead of navigating away.
 */
export function LessonViewer({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <motion.div
      className="s-review"
      style={{ zIndex: 55, paddingBottom: 0 }}
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ type: 'spring', damping: 34, stiffness: 320 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 44, padding: '0 16px', flexShrink: 0 }}>
        <button className="s-link" style={{ fontWeight: 600 }} onClick={onClose}>
          Done
        </button>
        <div className="t-headline clamp1" style={{ flex: 1, textAlign: 'center' }}>
          {title}
        </div>
        <span style={{ width: 44 }} />
      </div>
      {!loaded && (
        <div style={{ position: 'absolute', inset: '44px 0 0', display: 'grid', placeItems: 'center' }} className="c2 t-sub">
          Opening your lesson…
        </div>
      )}
      <iframe
        src={url}
        title={title}
        onLoad={() => setLoaded(true)}
        allow="autoplay; fullscreen; microphone"
        style={{ flex: 1, width: '100%', border: 0, background: 'var(--bg)', opacity: loaded ? 1 : 0, transition: 'opacity .3s' }}
      />
    </motion.div>
  );
}
