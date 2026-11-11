import pkg from '../../package.json';

/**
 * The service worker, as the text `app/sw.js/route.ts` serves. It is made here and not kept as a file in `public/` so that its cache is named
 * by the release (a new release is a new worker, so the browser replaces the old one and its cache) and so that a test can run it.
 *
 * **It caches almost nothing, on purpose.** Fjord shows people's documents, which may be decrypted in the browser, behind a session, and a copy
 * kept by the browser is a copy that outlives signing out and is on the disk. So:
 *
 *  - **Pages, APIs, documents, share links and `/raw/…` are never stored**, and are not touched while the network works: the worker does not answer
 *    them, the browser does. A page that fails to load because the network is down is replaced by the offline page (`/offline`), once, and only then.
 *  - **The build's static files (`/_next/static/…`) and the app's icons are kept**: they are the same for everyone, named by a hash of their content,
 *    and hold nothing of anyone's. They make the shell start fast, and let the offline page and an installed app open without a network.
 *  - The offline page is kept when the worker is installed, and is the only page that is.
 *
 * Nothing is sent to the server by the worker, and it needs no secret. It never calls `skipWaiting`: a new worker waits until every window of the app is
 * closed, so the code is never swapped under someone who is writing.
 */
export const CACHE_PREFIX = 'fjord-';
export const CACHE_NAME = `${CACHE_PREFIX}${pkg.version}`;
export const OFFLINE_PATH = '/offline';

/** What is stored when the worker is installed: only the offline page, and the mark it shows. */
export const PRECACHE = [OFFLINE_PATH, '/icons/icon-192.png'];

/** The paths whose files are kept as they are used: the build's own, hashed by content, and the icons. */
export const STATIC_PREFIXES = ['/_next/static/', '/icons/'];

/** Paths that are never answered from the offline page, because they are not pages: a failed one fails as it should. */
export const NOT_PAGES = ['/api/', '/raw/', '/_next/'];

export function workerSource(): string {
  return `'use strict';
var CACHE = ${JSON.stringify(CACHE_NAME)};
var PREFIX = ${JSON.stringify(CACHE_PREFIX)};
var OFFLINE = ${JSON.stringify(OFFLINE_PATH)};
var PRECACHE = ${JSON.stringify(PRECACHE)};
var STATIC = ${JSON.stringify(STATIC_PREFIXES)};
var NOT_PAGES = ${JSON.stringify(NOT_PAGES)};

function startsWithAny(path, list) {
  for (var i = 0; i < list.length; i++) if (path.indexOf(list[i]) === 0) return true;
  return false;
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 'reload': the browser's own cache must not hand the worker an old offline page.
      return cache.addAll(PRECACHE.map(function (path) { return new Request(path, { cache: 'reload' }); }));
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names
        .filter(function (name) { return name.indexOf(PREFIX) === 0 && name !== CACHE; })
        .map(function (name) { return caches.delete(name); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    if (startsWithAny(url.pathname, NOT_PAGES)) return;
    // The network first and always: a page is never answered from a copy. Only a network that is not there (fetch rejects) gets the offline page,
    // and an answer from the server, an error included, is the server's.
    event.respondWith(
      fetch(request).catch(function () {
        return caches.open(CACHE).then(function (cache) { return cache.match(OFFLINE); }).then(function (page) {
          return page || Response.error();
        });
      })
    );
    return;
  }

  if (!startsWithAny(url.pathname, STATIC)) return;
  // Hashed by content, so a stored file is never stale: the stored one first, the network for what is not there yet.
  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(request).then(function (hit) {
        if (hit) return hit;
        return fetch(request).then(function (response) {
          if (response.ok && response.type === 'basic') cache.put(request, response.clone());
          return response;
        });
      });
    })
  );
});
`;
}
