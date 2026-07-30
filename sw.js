const CACHE_NAME = "mib-atlas-shell-v22";
const APP_SHELL = [
  "./",
  "./index.html",
  "./favicon.ico",
  "./styles.css",
  "./app.js",
  "./parser.js",
  "./storage.js",
  "./THIRD_PARTY_NOTICES.md",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;
  if (url.pathname.includes("/server-mibs/")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const updated = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || updated;
    }),
  );
});
