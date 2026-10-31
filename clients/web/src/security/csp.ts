/**
 * The Content-Security-Policy every page is sent with, and the headers that go with it (DESIGN.md §15, ROADMAP 1d.5).
 *
 * Shared documents, comments and display names come from other people, so a page must stay safe even if a way to put markup in them were found:
 * nothing may run that the server did not mark, and nothing third-party may load.
 *
 *  - **Scripts** run only with this request's nonce, or when a script that has it loads them (`'strict-dynamic'`): the bundles Next adds, and the theme
 *    script in the layout. No inline handler, no `javascript:` address, no `eval` (but in development, where React wants it).
 *    **`'wasm-unsafe-eval'`** is the one addition for phase 2 (ROADMAP 2a.2): a page may compile WebAssembly (the format module, which decrypts in the browser)
 *    and nothing broader; it does not allow `eval`, `new Function` or an inline script. The module itself is a file of this origin (`/fjord-wasm/`).
 *  - **Style *elements*** carry the nonce as well (CodeMirror is given it, `fjord-editor`'s `csp.ts`), but for two the document editor's select menu makes and cannot
 *    be given one, which are allowed by their hash (`LIBRARY_STYLE_HASHES`). **Style *attributes* are allowed**: the document editor (Radix and Lexical position menus and
 *    carets with them) and React's server-rendered `style` props need them, and an attribute can change how something looks but cannot run anything.
 *  - **Everything else comes from this origin**: images (and `data:` and `blob:` for the editor's own, so a document's image from another site does not
 *    load, which would tell that site who read the document), fonts (self-hosted by `next/font`), and `connect-src`, which is the API and the live
 *    stream. No frames, no plugins, nobody may frame a page (`frame-ancestors`), forms go only here, `<base>` cannot be changed.
 *  - **`upgrade-insecure-requests`** only where the instance is served over https: on `http://localhost` it would send the page's own requests to a port
 *    that does not speak https.
 *
 * The nonce is new for every request and unguessable; a page that uses it cannot be prerendered, which is why every page is rendered per request.
 */
export interface PolicyOptions {
  nonce: string;
  /** The instance is served over https (`FJORD_URL`). */
  secure: boolean;
  /** `next dev`, which needs `eval`. */
  development: boolean;
}

/**
 * The inline `<style>` elements that libraries make at run time and cannot be given a nonce, by the hash of their text. They are the document editor's
 * select menu (Radix): one that hides the scrollbars of its list, and one (react-remove-scroll-bar) that stops the page behind an open menu from scrolling. Each is
 * a fixed string in the library, so a hash allows exactly that and not other styles. A new version of either that changes the text is blocked until its hash
 * is put here; `e2e` opens the menus and fails on any block, so it is noticed when the library is upgraded (it is pinned, and upgraded on purpose).
 */
export const LIBRARY_STYLE_HASHES = ["sha256-441zG27rExd4/il+NvIqyL8zFx5XmyNQtE381kSkUJk=", "sha256-nzTgYzXYDNe6BAHiiI7NNlfK8n/auuOAhh2t92YvuXo="];

export function contentSecurityPolicy({ nonce, secure, development }: PolicyOptions): string {
  const hashes = LIBRARY_STYLE_HASHES.map((hash) => `'${hash}'`).join(" ");
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${development ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}' ${hashes}`,
    `style-src-elem 'self' 'nonce-${nonce}' ${hashes}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secure ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

/** An unguessable value for one request: 128 bits from the platform's random source. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Headers for every response, pages and APIs alike. `Referrer-Policy` is separate (ROADMAP 1c.4) and `Strict-Transport-Security` is sent only over https,
 * both by the proxy.
 */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  // A response is what its `Content-Type` says it is: an upload or a comment cannot be sniffed into a script.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Old browsers do not know `frame-ancestors`.
  { key: "X-Frame-Options", value: "DENY" },
  // Nothing here needs the device; a page cannot be made to ask for it.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  // Another site's window cannot hold a reference to this one's after a link is followed.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

/** A year, and the subdomains: the instance is served over https or not at all. */
export const HSTS = "max-age=31536000; includeSubDomains";
