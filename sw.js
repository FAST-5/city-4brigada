const CACHE_NAME = "voenny-konspekt-offline-v3-template";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/offline-app.js",
  "/jszip.min.js",
  "/offline-template.docx",
  "/offline.html",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith("voenny-konspekt-offline-") && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  // Never cache API requests, tokens, user records or generated private documents.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || request.method !== "GET") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          cache.put("/", response.clone()).catch(() => {});
          if (url.pathname === "/") cache.put("/index.html", response.clone()).catch(() => {});
        }
        return response;
      } catch (_) {
        const cached = await cache.match(request, { ignoreSearch: true })
          || await cache.match("/")
          || await cache.match("/index.html");
        if (cached) return cached;
        return (await cache.match("/offline.html")) || new Response("Откройте сайт с интернетом один раз, чтобы сохранить приложение для офлайн-работы.", {
          status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && response.ok && (response.type === "basic" || response.type === "cors")) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (_) {
      return new Response("", { status: 504, statusText: "Offline" });
    }
  })());
});
