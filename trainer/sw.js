// The phone trainer's service worker (#327): offline once opened online.
// Everything the app needs is stored when the worker installs — the build
// writes the list of its files and a version below (vite.trainer.config.ts);
// the first visit's page loaded them before the worker was there, so waiting
// to store them as they are fetched would leave a first visit unable to start
// offline. The page itself is fetched afresh when online (so an update
// arrives on the next start) and from the cache when not. No requests leave
// for anywhere else.

const VERSION = "bdeccb4bdd0c"; // set by the build
const PRECACHE = ["./","./assets/buffer-BM-9UDmO.js","./assets/dist-BQijkPQW.js","./assets/index-BxX2JQGM.js","./assets/index-CJEGJynv.css","./icon-180.png","./icon-192.png","./icon-512.png","./index.html","./manifest.webmanifest"]; // set by the build
const CACHE = `lpdo-trainer-${VERSION}`;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // The page: the network first, the cache offline.
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      void caches.open(CACHE).then((c) => c.put("./", copy));
      return res;
    }).catch(() => caches.match("./")));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); void caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
