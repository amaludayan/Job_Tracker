const SHELL_CACHE = 'waypoint-shell-v2'; // bumped: adds flights.js (live air traffic overlay)
const TILE_CACHE = 'waypoint-tiles-v1';

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './flights.js',
  './safe-import.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES).catch(() => {/* best effort, e.g. offline install */}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isTileRequest(url) {
  return /tile\.openstreetmap\.org/.test(url) || /\{s\}\.tile/.test(url);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  // Map tiles: cache-first, then network, and stash a fresh copy whenever we fetch one.
  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const resp = await fetch(req);
          if (resp && resp.status === 200) cache.put(req, resp.clone());
          return resp;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // App shell + fonts + leaflet assets: stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200 && (req.url.startsWith(self.location.origin) || req.url.includes('unpkg.com') || req.url.includes('fonts.g'))) {
            caches.open(SHELL_CACHE).then((cache) => cache.put(req, resp.clone()));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
