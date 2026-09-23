const CACHE_NAME = 'midi-seq-pro-v2';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './main.js',
    './audio.js',
    './ui.js',
    './input.js',
    './transport.js',
    './scheduler.js',
    './vendor/spessasynth/spessasynth_lib.min.js',
    './vendor/spessasynth/spessasynth_processor.min.js',
    './midi_encoder.js',
    './icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
    self.skipWaiting();
});

// Delete caches from older versions so stale files are never served
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
