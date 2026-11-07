// مصاريفي – service worker: lets the app open without internet (network first, cache as fallback).
// API calls (Supabase, OpenStreetMap) are never cached.
const CACHE = 'masarifi-v2.0.1';
const SHELL = [
  './',
  './app.css',
  './app.js',
  './lib.js',
  './config.js',
  './vendor/supabase.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => { /* first install offline – ignore */ })
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
  event.respondWith(
    // always revalidate with the server (no stale files from the 10-minute browser cache after an update)
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok && res.type === 'basic' && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const shell = await caches.match('./');
          if (shell) return shell;
        }
        return new Response('offline', { status: 503, statusText: 'offline' });
      }),
  );
});
