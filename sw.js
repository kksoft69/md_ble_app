const CACHE = 'md-ble-phone-v2';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest',
                './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys
      .filter(key => key.startsWith('md-ble-phone-') && key !== CACHE)
      .map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin ||
      !url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  event.respondWith(caches.match(request, {ignoreSearch: true}).then(cached => {
    if (cached) return cached;
    if (request.mode === 'navigate') return caches.match('./index.html');
    return fetch(request);
  }));
});
