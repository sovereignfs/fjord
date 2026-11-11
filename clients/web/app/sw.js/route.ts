import { workerSource } from '../../src/pwa/worker';

// The service worker (`src/pwa/worker.ts`). It is built from the release, so it is the same bytes until the next one.
export function GET(): Response {
  return new Response(workerSource(), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      // A browser must look for a new worker every time, or a fix to it would wait for a stale copy to expire.
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      'Service-Worker-Allowed': '/',
    },
  });
}
