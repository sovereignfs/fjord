/**
 * A static HTML page of a repository, served to run (workstream 0003, leg 5). The owner's use is checklists and small tools made elsewhere, kept in a vault and opened
 * here; the file is **someone's code, and never runs with this app's origin or cookies**. So it is served as a response of its own, not put in the page that shows it:
 *
 *  - `Content-Security-Policy: sandbox allow-scripts …` gives the document an opaque origin **even when this address is opened directly in a tab**, with no `allow-same-origin`,
 *    so it cannot read a cookie, call this app's API, or touch the page around it. It may run its own script and style, and show images and fonts that are inside it (`data:`,
 *    `blob:`). `connect-src 'none'`, `form-action 'none'` and no frames: nothing it does leaves the document, and it is not a way to send what is in it anywhere.
 *  - Only the owner of the repository asks for it (anyone else, and anyone signed out, is a 404 that says nothing), and only for a `.html` or `.htm` file in a plaintext vault.
 *  - `frame-ancestors 'self'`: only this app's own page can show it.
 *
 * The page that shows it is `/repo/<repo>/v/<vault>/…/html/<handle>`, whose iframe is `sandbox="allow-scripts"` as well; nothing here depends on that.
 */
export const RAW_POLICY = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** The largest page served: a checklist is a few kilobytes, and what is bigger than this is not one. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export interface RawDeps {
  /** Where a handle points: the repository and the path. */
  resolve(handle: string): Promise<{ connectionId: number; path: string } | undefined>;
  /** The file's bytes, if it is one of this account's repository's, in a vault that is not encrypted; else why not. */
  read(accountId: string, connectionId: number, path: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: "missing" | "too_large" }>;
}

const notFound = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } });

export async function handleRaw(caller: { accountId: string } | null, connection: string, handle: string, deps: RawDeps): Promise<Response> {
  if (!caller || !/^[1-9][0-9]{0,15}$/.test(connection)) return notFound();
  const place = await deps.resolve(handle);
  if (!place || place.connectionId !== Number(connection) || !/\.html?$/i.test(place.path)) return notFound();
  const read = await deps.read(caller.accountId, place.connectionId, place.path);
  if (!read.ok) return read.reason === "too_large" ? new Response("This page is larger than 2 MB, which is more than is served.", { status: 413, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }) : notFound();
  return new Response(read.bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": RAW_POLICY,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // The owner's page, as of now: not kept by a cache that others share.
      "cache-control": "private, no-store",
    },
  });
}
