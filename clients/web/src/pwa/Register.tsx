'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker (`/sw.js`, `src/pwa/worker.ts`), once the page has loaded so that it never competes with it. Only in production: under
 * `next dev` a worker would hold files that change on every save. A browser with no service workers, or one that refuses (a private window, an insecure
 * address that is not `localhost`), is left as it was: the app works the same without it, and it is only the offline page and the install that are missed.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch(() => undefined);
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);
  return null;
}
