import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/** Home-screen icon: a single ventilator breath on the oxygen tint. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(160deg, #1aa6e6 0%, #0a6fb0 100%)',
        }}
      >
        <svg width="132" height="96" viewBox="0 0 132 96" fill="none">
          <path
            d="M6 78 H24 C28 78 30 22 38 20 L70 20 C76 20 78 26 82 44 C88 70 100 78 126 78"
            stroke="white"
            strokeWidth="10"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    ),
    size,
  );
}
