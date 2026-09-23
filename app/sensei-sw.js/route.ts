/**
 * Sensei's service worker, served at /sensei-sw.js and registered with scope
 * /sensei so it covers the home-screen app: push, notification taps, and offline
 * reading (DECISIONS V18).
 *
 * Offline is network-first: with a connection you always get the live app and
 * data, and each successful response is kept as the fallback for when you don't.
 * Nothing is precached. Build files (/_next/static) are content-hashed, so a kept
 * copy can never be stale. The cache is named after this build and older caches
 * are deleted when a new build's worker activates. A 401 (enter your code) is
 * passed through, never replaced with a saved page.
 */
export const dynamic = 'force-static';

// Evaluated at build time (force-static), so every build gets its own cache.
const BUILD = process.env.SENSEI_BUILD_SHA || String(Date.now());

const SW = `
const CACHE = 'sensei-${BUILD}';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('sensei-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

function keepable(url, req) {
  if (req.method !== 'GET' || req.headers.has('range')) return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/_next/static/')) return true;
  // Audio streams are large and ranged; they need a connection.
  if (url.pathname.startsWith('/api/sensei/audio') || url.pathname.startsWith('/api/sensei/reels/')) return false;
  return url.pathname === '/sensei' || url.pathname.startsWith('/sensei/') || url.pathname.startsWith('/api/sensei/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (!keepable(url, req)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(req) || (req.mode === 'navigate' ? await cache.match('/sensei') : undefined);
      if (hit) return hit;
      throw err;
    }
  })());
});

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
