/* Samba service worker — conservative offline support.
 *
 * Strategy:
 *  - Pages + same-origin API GETs: network-first, falling back to the last
 *    cached copy when offline (agents in the field get last-known
 *    availability instead of a dead page; index.html shows an offline
 *    banner so stale data is never mistaken for live).
 *  - Static assets (images incl. Drive photos, fonts, icons): cache-first.
 *  - Versioned cache names; old caches are dropped on activate.
 */
/* NOTE: images are cached cache-first, so replacing an image's content under
 * the SAME filename requires bumping VERSION or returning visitors keep the
 * old pixels forever (bit us with the 2026-08 retina re-exports). */
const VERSION = 'v10-signin-devices';
const RUNTIME = 'samba-runtime-' + VERSION;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== RUNTIME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  const isAsset = req.destination === 'image' || req.destination === 'font' ||
    /\.(png|webp|jpg|jpeg|svg|ico|woff2?)$/.test(url.pathname) ||
    url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

  if (isAsset) {
    // Cache-first: photos and fonts basically never change under the same URL.
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') {
          const c = await caches.open(RUNTIME);
          c.put(req, res.clone());
        }
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }

  if (url.origin === location.origin) {
    // Network-first: always prefer live pages/data, keep the last good copy.
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const c = await caches.open(RUNTIME);
          c.put(req, res.clone());
        }
        return res;
      } catch (err) {
        const hit = await caches.match(req);
        if (hit) return hit;
        throw err;
      }
    })());
  }
});
