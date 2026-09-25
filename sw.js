/* The Garcia Report service worker. Cache version is injected at build time. */
var VERSION = "20260925042252";
var PREFIX = "tgr-";
var PAGES = PREFIX + "pages-" + VERSION;
var STATIC = PREFIX + "static-" + VERSION;
var OFFLINE_URL = "/offline.html";
var PRECACHE = [
  OFFLINE_URL,
  "/",
  "/assets/styles.css",
  "/assets/logo.png",
  "/assets/icon-192.png",
  "/assets/favicon.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(STATIC).then(function (cache) {
      return Promise.all(
        PRECACHE.map(function (url) {
          return fetch(url, { cache: "reload" })
            .then(function (res) {
              if (!res.ok) return;
              return (url === OFFLINE_URL || url === "/")
                ? caches.open(PAGES).then(function (c) { return c.put(url, res); })
                : cache.put(url, res);
            })
            .catch(function () {});
        })
      );
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          if (key.indexOf(PREFIX) === 0 && key !== PAGES && key !== STATIC) {
            return caches.delete(key);
          }
        })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

function cacheable(res) {
  return res && res.ok && res.type === "basic";
}

// Network-first for HTML navigations: new articles show up immediately.
function handleNavigation(event) {
  var req = event.request;
  return fetch(req)
    .then(function (res) {
      if (cacheable(res) && !res.redirected) {
        var copy = res.clone();
        event.waitUntil(caches.open(PAGES).then(function (c) { return c.put(req, copy); }));
      }
      return res;
    })
    .catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || caches.match(OFFLINE_URL);
      });
    });
}

// Stale-while-revalidate for same-origin CSS/JS/images/fonts.
function handleStatic(event) {
  var req = event.request;
  return caches.open(STATIC).then(function (cache) {
    return cache.match(req).then(function (hit) {
      var network = fetch(req)
        .then(function (res) {
          if (cacheable(res)) cache.put(req, res.clone());
          return res;
        })
        .catch(function () {
          return hit || cache.match(req, { ignoreSearch: true }).then(function (h) {
            return h || Response.error();
          });
        });
      if (hit) {
        event.waitUntil(network.catch(function () {}));
        return hit;
      }
      return network;
    });
  });
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  // Never touch cross-origin requests (Giscus, YouTube, fonts, like counter, analytics).
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/sw.js") return;

  if (req.mode === "navigate") {
    event.respondWith(handleNavigation(event));
    return;
  }
  var dest = req.destination;
  if (
    dest === "style" || dest === "script" || dest === "image" || dest === "font" ||
    url.pathname.indexOf("/assets/") === 0
  ) {
    event.respondWith(handleStatic(event));
  }
});
