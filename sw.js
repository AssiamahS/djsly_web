const C = 'djsly-v1';
const ASSETS = ['./', './index.html', './style.css', './js/app.js', './js/engine.js', './js/deck-processor.js', './js/analysis-worker.js', './js/library.js', './js/midi.js', './controllers/ddj-sb3.js', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => { if (e.request.method !== 'GET') return; e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request))); });
