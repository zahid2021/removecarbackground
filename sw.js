/* RemoveCarBackground PWA service worker */
const CACHE = "rcb-v37";
const ASSETS = [
  "/css/styles.css?v=37",
  "/js/main.js?v=37",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(() =>
        self.clients.matchAll({ type: "window" }).then((clients) => {
          clients.forEach((client) => client.postMessage({ type: "RCB_SW_UPDATED" }));
        })
      )
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;

  const isHtml =
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/";
  const isAsset =
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js") ||
    /\.(jpe?g|png|webp|gif|svg|ico)$/i.test(url.pathname) ||
    url.pathname.startsWith("/images/");

  // Always network-first for pages + assets so deploys show up on mobile
  if (isHtml || isAsset) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((res) => {
          if (res.ok && !isHtml) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
