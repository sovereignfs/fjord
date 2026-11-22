import { serviceWorkerSource } from '@sovereignfs/pwa';
import pkg from '../../package.json';

/**
 * The service worker, as the text `app/sw.js/route.ts` serves: the suite's, from `@sovereignfs/pwa`, with Fjord's cache name and offline page. It is
 * made here and not kept as a file in `public/` so that its cache is named by the release (a new release is a new worker, so the browser replaces the
 * old one and its cache) and so that a test can run it.
 *
 * **It caches almost nothing, on purpose.** Fjord shows people's documents, which may be decrypted in the browser, behind a session, and a copy
 * kept by the browser is a copy that outlives signing out and is on the disk. So:
 *
 *  - **Pages, APIs, documents, share links and `/raw/…` are never stored**, and are not touched while the network works: the worker does not answer
 *    them, the browser does. A page that fails to load because the network is down, or does not answer in time, is replaced by the offline page
 *    (`/offline`), and only then.
 *  - **The build's static files (`/_next/static/…`), the app's icons and the manifest are kept**: they are the same for everyone, and hold nothing of
 *    anyone's. They make the shell start fast, and let the offline page and an installed app open without a network.
 *  - The offline page is kept when the worker is installed, and is the only page that is.
 *
 * Nothing is sent to the server by the worker, and it needs no secret. A new worker waits until a page asks it to take over, which the registration
 * does when the person chooses Reload on its notice, so the code is never swapped under someone who is writing.
 */
export const CACHE_PREFIX = 'fjord-';
export const CACHE_NAME = `${CACHE_PREFIX}${pkg.version}`;
export const OFFLINE_PATH = '/offline';

/** What is stored when the worker is installed: only the offline page, and the mark it shows. */
export const PRECACHE = [OFFLINE_PATH, '/icons/icon-192.png'];

export function workerSource(): string {
  return serviceWorkerSource({
    version: pkg.version,
    cachePrefix: CACHE_PREFIX,
    precache: ['/icons/icon-192.png'],
    shell: OFFLINE_PATH,
  });
}
