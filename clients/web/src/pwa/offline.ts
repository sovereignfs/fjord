import { site } from '../site';

/**
 * The page a browser shows when it cannot reach the server (`/offline`; the service worker keeps it when it is installed and shows it in place of a page
 * that did not load, `worker.ts`). It is one self-contained document: it cannot rely on the app's stylesheet or scripts, which may be what is missing.
 *
 * Its colours are the browser's own (`Canvas`, `CanvasText`, `GrayText`), which follow the light or dark setting with no literal colour, since the design
 * system's tokens are in a stylesheet that is not here. Its one `<style>` carries the request's nonce, as the policy asks (`src/security/csp.ts`): the copy that
 * is kept has the policy it was sent with, so the nonce and the policy stay together. It has no script and no link to anything that is not this
 * origin. The button reloads through a plain link to `/`, which needs none.
 */
export function offlinePage(nonce: string | undefined): string {
  const attribute = nonce ? ` nonce="${nonce.replace(/[^A-Za-z0-9+/=]/g, '')}"` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>Offline · ${site.name}</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style${attribute}>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box;
    background: Canvas; color: CanvasText; font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 28rem; text-align: center; }
  img { width: 64px; height: 64px; border-radius: 14px; }
  h1 { margin: 16px 0 8px; font-size: 1.5rem; }
  p { margin: 0 0 12px; color: GrayText; }
  a { display: inline-block; margin-top: 8px; padding: 8px 16px; border: 1px solid currentColor; border-radius: 8px;
    color: CanvasText; text-decoration: none; font-weight: 600; }
  a:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <img src="/icons/icon-192.png" alt="" width="64" height="64">
  <h1>You are offline</h1>
  <p>${site.name} could not reach the server. Your documents are in your repository, and nothing there is affected.</p>
  <p>Check your connection, then try again.</p>
  <a href="/">Try again</a>
</main>
</body>
</html>
`;
}
