/* SF Symbols–style glyphs, drawn to match iOS weights. Filled variants for selected tabs. */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { filled?: boolean };

export const TodayIcon = ({ filled, ...p }: P) => (
  <svg viewBox="0 0 28 26" fill="none" {...p}>
    <rect x="3" y="3.5" width="22" height="20" rx="4.5" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" />
    <path d="M3 9.5h22" stroke={filled ? 'var(--bar-solid, #fff)' : 'currentColor'} strokeWidth="1.8" opacity={filled ? 0.9 : 1} />
    <path d="M9 2v4M19 2v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path
      d="M7 17h3l1.6-3.5 2.4 6 2-4.5H21"
      stroke={filled ? 'var(--bar-solid, #fff)' : 'currentColor'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const ReviewIcon = ({ filled, ...p }: P) => (
  <svg viewBox="0 0 28 26" fill="none" {...p}>
    <rect x="7" y="2" width="14" height="4" rx="1.5" fill="currentColor" opacity="0.45" />
    <rect x="5" y="5" width="18" height="4" rx="1.5" fill="currentColor" opacity="0.7" />
    <rect x="3" y="8.5" width="22" height="15" rx="3.5" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" />
    <path
      d="M10 16.2l2.8 2.8 5.4-5.8"
      stroke={filled ? 'var(--bar-solid, #fff)' : 'currentColor'}
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const LibraryIcon = ({ filled, ...p }: P) => (
  <svg viewBox="0 0 28 26" fill="none" {...p}>
    <rect x="3" y="4" width="5.5" height="19" rx="1.6" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" />
    <rect x="11" y="4" width="5.5" height="19" rx="1.6" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" />
    <path d="M19 6.4l4.6-1.3 4 16.6-4.6 1.3z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" transform="translate(-2 0)" />
  </svg>
);

export const Chevron = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 8 14" className="s-chevron" fill="none" {...p}>
    <path d="M1.5 1.5L6.5 7l-5 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const BackChevron = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 13 21" fill="none" {...p}>
    <path d="M11 2L2.5 10.5 11 19" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PlusIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" {...p}>
    <circle cx="12" cy="12" r="11" fill="currentColor" />
    <path d="M12 7v10M7 12h10" stroke="var(--on-tint, #fff)" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

export const PersonIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" {...p}>
    <circle cx="12" cy="12" r="10.5" stroke="currentColor" strokeWidth="1.7" />
    <circle cx="12" cy="9.5" r="3.4" stroke="currentColor" strokeWidth="1.7" />
    <path d="M5.6 19c1.5-2.6 3.8-3.8 6.4-3.8s4.9 1.2 6.4 3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

export const SearchIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 17 17" fill="none" {...p}>
    <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.9" />
    <path d="M11.2 11.2L15.5 15.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

export const PlayIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 12 12" {...p}>
    <path d="M2.5 1.3v9.4c0 .5.5.8.9.5l7.4-4.7c.4-.3.4-.8 0-1L3.4.8c-.4-.3-.9 0-.9.5z" fill="currentColor" />
  </svg>
);

export const PauseIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 12 12" {...p}>
    <rect x="2" y="1" width="3" height="10" rx="1" fill="currentColor" />
    <rect x="7" y="1" width="3" height="10" rx="1" fill="currentColor" />
  </svg>
);

export const SkipIcon = ({ back, ...p }: SVGProps<SVGSVGElement> & { back?: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" {...p} style={{ transform: back ? 'scaleX(-1)' : undefined }}>
    <path d="M19 12a7 7 0 11-2.05-4.95" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M17.5 3.5v4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <text x="12" y="15.2" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" fontFamily="-apple-system, system-ui">15</text>
  </svg>
);

export const CloseIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 30 30" {...p}>
    <circle cx="15" cy="15" r="15" fill="var(--fill)" />
    <path d="M10.5 10.5l9 9M19.5 10.5l-9 9" stroke="var(--label-2)" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

export const ArrowUpIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 18 18" fill="none" {...p}>
    <path d="M9 15V3M4 8l5-5 5 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const WaveGlyph = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 64 64" fill="none" {...p}>
    <rect width="64" height="64" rx="16" fill="currentColor" opacity="0.12" />
    <path d="M8 44h7c2 0 3-22 7-23h12c3 0 4 3 6 11 3 10 8 12 16 12" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const MicIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 28 28" fill="none" {...p}>
    <rect x="9.5" y="3" width="9" height="14" rx="4.5" fill="currentColor" />
    <path d="M6 13.5a8 8 0 0016 0M14 21.5V25" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const DocIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 28 28" fill="none" {...p}>
    <path d="M7 3h9.5L22 8.5V23a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z" fill="currentColor" />
    <path d="M16 3v6h6" stroke="var(--cell, #fff)" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M9 14h9M9 18h6" stroke="var(--cell, #fff)" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const CheckIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 20 20" fill="none" {...p}>
    <path d="M4.5 10.5l3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
