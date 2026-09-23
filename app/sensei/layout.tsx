import type { Metadata, Viewport } from 'next';

import './sensei.css';

export const metadata: Metadata = {
  title: 'Sensei',
  description: 'Your respiratory therapy study companion.',
  manifest: '/sensei/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Sensei', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f2f2f7' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
};

export default function SenseiLayout({ children }: { children: React.ReactNode }) {
  return <div className="sensei">{children}</div>;
}
