const CACHE_NAME = 'midi-seq-pro-v1';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './main.js',
    './audio.js',
    './ui.js',
    './input.js',
    './transport.js',
    './sf2parser.js',
    './midi_encoder.js',
    './icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
