/* global self, caches */

const CACHE_VERSION = 'api-monitor-pwa-v2';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/logo.svg',
  '/pwa/apple-touch-icon.png',
  '/pwa/icon-192.png',
  '/pwa/icon-512.png',
  '/pwa/icon.svg',
  '/pwa/maskable-icon-192.png',
  '/pwa/maskable-icon-512.png',
  '/pwa/maskable-icon.svg',
  '/pwa/offline.html',
];

const isSameOrigin = (url) => url.origin === self.location.origin;
const isRuntimeAsset = (url) =>
  isSameOrigin(url) &&
  (url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/brand-icons/') ||
    url.pathname.startsWith('/pwa/'));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('api-monitor-pwa-') && ![APP_SHELL_CACHE, RUNTIME_CACHE].includes(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (!isSameOrigin(url)) return;

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1') || url.pathname.startsWith('/sub/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(APP_SHELL_CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(async () => {
          const cachedShell = await caches.match('/index.html');
          return cachedShell || caches.match('/pwa/offline.html');
        })
    );
    return;
  }

  if (isRuntimeAsset(url) || request.destination === 'style' || request.destination === 'script' || request.destination === 'image') {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkFetch;
      })
    );
  }
});
