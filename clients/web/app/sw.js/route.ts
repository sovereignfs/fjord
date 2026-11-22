import { serviceWorkerResponse } from '@sovereignfs/pwa';
import { workerSource } from '../../src/pwa/worker';

// The service worker (`src/pwa/worker.ts`, the suite's from `@sovereignfs/pwa`). It is built from the release, so it is the same bytes until the next
// one, and a browser looks for a new one every time.
export function GET(): Response {
  return serviceWorkerResponse(workerSource());
}
