/*! pwa-sw.js — service worker
 *  Сгенерировано PWA Forge · 10.09.2026 17:13
 *  Режим кэша: smart  —  Умный
 *  Файл должен лежать в корне сайта, рядом с index.html.
 */
'use strict';

var VERSION  = '202609101513';
var MODE     = 'smart';                 // minimal | smart | offline
var CACHE    = 'pwa-cache-' + VERSION;
var OFFLINE  = '/offline.html';
var PRECACHE = [
  "/offline.html",
  "/icons/manifest.json",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png"
];

/* Эти пути не кэшируются никогда — иначе приложение покажет старые данные */
var NEVER = [/\/api\//, /\/_vercel\//, /\.json(\?|$)/];

function isNever(url) {
  for (var i = 0; i < NEVER.length; i++) if (NEVER[i].test(url)) return true;
  return false;
}
function isStatic(req) {
  return /\.(png|jpe?g|webp|svg|gif|ico|css|js|woff2?|ttf|otf)(\?|$)/i.test(req.url);
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // по одному: один битый путь не должен рушить всю установку
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE && k.indexOf('pwa-cache-') === 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function networkFirst(req) {
  return fetch(req).then(function (res) {
    if (res && res.ok && MODE !== 'minimal') {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (hit) {
      if (hit) return hit;
      return caches.match(OFFLINE).then(function (off) { return off || Response.error(); });
    });
  });
}

function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    });
  });
}

function staleWhileRevalidate(req) {
  return caches.match(req).then(function (hit) {
    var net = fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return hit; });
    return hit || net;
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;

  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (isNever(req.url)) return;

  // Страницы: всегда свежие, офлайн — из кэша
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req));
    return;
  }

  if (MODE === 'minimal') {
    // только то, что лежит в precache (иконки), остальное — сеть
    e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req); }));
    return;
  }

  if (isStatic(req)) {
    e.respondWith(MODE === 'offline' ? cacheFirst(req) : staleWhileRevalidate(req));
    return;
  }

  e.respondWith(networkFirst(req));
});
