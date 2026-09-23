/**
 * Sensei's service worker, served at /sensei-sw.js and registered with scope
 * /sensei so it covers the home-screen app. Push + notification tap only; no
 * fetch handler, so it can never serve a stale app after an update.
 */
export const dynamic = 'force-static';

const SW = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Sensei';
  // iOS requires every push to show a notification.
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || undefined,
    data: { url: data.url || '/sensei' },
    icon: '/sensei/apple-icon',
    badge: '/sensei/apple-icon',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/sensei';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
`;

export function GET() {
  return new Response(SW, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'service-worker-allowed': '/sensei',
    },
  });
}
