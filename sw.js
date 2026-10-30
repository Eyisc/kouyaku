/* 口譯 — offline cache.
 * The page is fetched fresh when online (cached copy when offline), and every other file has a
 * versioned URL, so an update can never mix an old page with a new script. API calls are never cached. */
const VERSION = '1.2.1';
const CACHE = `kouyaku-${VERSION}`;
const ASSETS = [
  `styles.css?v=${VERSION}`,
  `app.js?v=${VERSION}`,
  `phrases.js?v=${VERSION}`,
  's2t.js?v=1',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
];

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(['./'].concat(ASSETS).map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // the page itself: newest when online, cached copy when offline or very slow
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await withTimeout(fetch(req.url, { cache: 'no-cache' }), 4000);
        if (res && res.ok) {
          cache.put('./', res.clone());
          return res;
        }
        throw new Error(`HTTP ${res && res.status}`);
      } catch (e) {
        return (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // versioned files never change: cache first, then network
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }));
});
