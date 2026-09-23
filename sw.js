const CACHE_NAME = 'midi-seq-pro-v5';
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
    './song.js',
    './song_view.js',
    './song_input.js',
    './theme.js',
    './tone_editor.js',
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

// Network first (so updates show up on reload), cache as the offline fallback
self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                }
                return response;
            })
            .catch(() => caches.match(request))
    );
});
