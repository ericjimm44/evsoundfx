/* EV Roar — offline-capable service worker.
   Strategy:
   - App shell (html/css/js/manifest/pack.json): NETWORK-FIRST with cache
     fallback, so every deploy shows up on the next refresh while the app
     still works offline.
   - Sound files (samples/*.wav etc): CACHE-FIRST — they're immutable
     (new packs use new filenames), so never re-download them.
*/
const CACHE = "ev-roar-v8";
const ASSETS = [
  ".",
  "index.html",
  "css/style.css",
  "js/app.js",
  "manifest.webmanifest",
  "samples/pack.json",
  "icons/favicon-64.png",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS).then(() => precacheSamples(c)))
      .then(() => self.skipWaiting())
  );
});

/* Pull every sound listed in pack.json at install time, so ALL voices work
   offline — not just the ones the user happened to tap while online.
   Best-effort: a failure here must never block the install. */
function precacheSamples(cache) {
  return fetch("samples/pack.json")
    .then((r) => r.json())
    .then((j) => {
      const files = new Set();
      (j.voices || []).forEach((v) => (v.loops || []).forEach((l) => l.file && files.add(l.file)));
      return Promise.all([...files].map((f) => cache.add("samples/" + f).catch(() => {})));
    })
    .catch(() => {});
}

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(request) {
  return fetch(request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match(request).then((hit) => hit || caches.match("index.html")));
}

function cacheFirst(request) {
  return caches.match(request).then((hit) =>
    hit ||
    fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
      return res;
    })
  );
}

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const path = new URL(request.url).pathname;
  const isSampleAudio = path.includes("/samples/") && !path.endsWith("pack.json");
  e.respondWith(isSampleAudio ? cacheFirst(request) : networkFirst(request));
});
