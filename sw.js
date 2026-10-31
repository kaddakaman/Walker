// Service worker: caches the app so it opens instantly (and offline), and
// keeps recently viewed map tiles for patchy signal on walks.
const APP_CACHE = 'walker-app-v1';
const TILE_CACHE = 'walker-tiles-v1';
const MAX_TILES = 600;
const APP_FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/geo.js', 'js/tracker.js', 'js/steps.js', 'js/storage.js', 'js/share.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== APP_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    // Map tiles: cache first, then network.
    e.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') {
          cache.put(req, res.clone());
          trimTiles();
        }
        return res;
      })
    );
    return;
  }

  // App files: network first so updates arrive, fall back to cache offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (url.origin === location.origin || url.hostname === 'unpkg.com')) {
          const copy = res.clone();
          caches.open(APP_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
