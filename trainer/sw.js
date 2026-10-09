// The phone trainer's service worker (#327): offline once opened online.
// The page itself is fetched afresh when online (so an update arrives on the
// next start) and from the cache when not; the hashed assets, the icons and
// the manifest are served from the cache once fetched — a new build has new
// asset names. No requests leave for anywhere else.

const CACHE = "lpdo-trainer-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./manifest.webmanifest", "./icon-180.png", "./icon-192.png"])));
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
