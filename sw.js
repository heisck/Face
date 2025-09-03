/* Service Worker for Face Attendance PWA */
const CACHE_NAME = 'face-attendance-v1';
const APP_SHELL = [
  './',
  './face.html',
  './face-api.js',
  './vendor/face-api.min.js',
  './manifest.webmanifest',
  './style.css',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-256.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  // CDN dependencies
  'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(APP_SHELL);
    } catch (e) {
      // Some resources (like CDN) might fail during install; ignore to avoid breaking install
      console.warn('[SW] Some shell resources failed to cache on install:', e);
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

// Helper: decide if request targets our models directory
function isModelRequest(url) {
  try {
    const u = new URL(url);
    return u.pathname.includes('/models/');
  } catch {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET
  if (req.method !== 'GET') return;

  // Strategy: cache-first for same-origin app shell
  const cacheFirst = async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreVary: true });
    if (cached) return cached;
    const res = await fetch(req);
    // Cache successful responses
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  };

  // Strategy: stale-while-revalidate for models and CDN
  const staleWhileRevalidate = async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreVary: true });
    const networkFetch = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || networkFetch;
  };

  if (url.origin === location.origin) {
    if (isModelRequest(req.url)) {
      event.respondWith(staleWhileRevalidate());
    } else {
      event.respondWith(cacheFirst());
    }
  } else {
    // Cross-origin (e.g., CDN): SWR
    event.respondWith(staleWhileRevalidate());
  }
});
