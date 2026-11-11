import { offlinePage } from '../../src/pwa/offline';

// The page the service worker shows when the network is down (`src/pwa/offline.ts`). Its style carries this request's nonce, which the proxy made (`x-nonce`).
export function GET(request: Request): Response {
  return new Response(offlinePage(request.headers.get('x-nonce') ?? undefined), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Nothing in it is anyone's, but a copy kept by a shared cache has no reason to be.
      'Cache-Control': 'no-store',
    },
  });
}
