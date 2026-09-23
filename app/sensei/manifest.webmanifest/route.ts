export const dynamic = 'force-static';

export function GET() {
  return Response.json(
    {
      name: 'Sensei',
      short_name: 'Sensei',
      description: 'Your respiratory therapy study companion.',
      start_url: '/sensei',
      scope: '/',
      display: 'standalone',
      background_color: '#f2f2f7',
      theme_color: '#f2f2f7',
      icons: [{ src: '/sensei/apple-icon', sizes: '180x180', type: 'image/png' }],
    },
    { headers: { 'content-type': 'application/manifest+json' } },
  );
}
