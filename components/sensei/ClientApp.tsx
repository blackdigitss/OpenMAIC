'use client';

import dynamic from 'next/dynamic';

/** The app is fully data-driven on the client (storage, audio, gestures), so skip SSR. */
export const ClientSenseiApp = dynamic(() => import('./App').then((m) => m.SenseiApp), {
  ssr: false,
  loading: () => <div style={{ minHeight: '100dvh' }} />,
});
