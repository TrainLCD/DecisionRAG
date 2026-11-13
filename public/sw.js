// Build revision: 4d3cbcdbd870084419f63c4590f51f536738db8346eff9057ce3c0a1fb8cae78
"use strict";
// Bump this version whenever either offline asset changes.
const CACHE = "decisionrag-offline-v1";
const OFFLINE_ASSETS = ["/offline.html", "/offline.css"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(OFFLINE_ASSETS)));
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("decisionrag-offline-") && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // API requests, credentials, search results and the application page are never cached.
  if (request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html")) {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match("/offline.html")) || Response.error();
    }));
  } else if (OFFLINE_ASSETS.includes(url.pathname) && !url.search) {
    event.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match(request)) || fetch(request)));
  }
});
