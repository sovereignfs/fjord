import { isPublicId } from '../connections/public-id';

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
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** The largest page served: a checklist is a few kilobytes, and what is bigger than this is not one. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export interface RawDeps {
  /** The number of this account's repository that has this public id, or none if it has no such repository. */
  connection(accountId: string, publicId: string): Promise<number | undefined>;
  /** Where a handle points: the repository and the path. */
  resolve(handle: string): Promise<{ connectionId: number; path: string } | undefined>;
  /** The file's bytes, if it is one of this account's repository's, in a vault that is not encrypted; else why not. */
  read(
    accountId: string,
    connectionId: number,
    path: string,
    maxBytes?: number,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'missing' | 'too_large' }>;
}

const notFound = () =>
  new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });

export async function handleRaw(
  caller: { accountId: string } | null,
  connection: string,
  handle: string,
  deps: RawDeps,
): Promise<Response> {
  if (!caller || !isPublicId(connection)) return notFound();
  const wanted = await deps.connection(caller.accountId, connection);
  if (wanted === undefined) return notFound();
  const place = await deps.resolve(handle);
  if (!place || place.connectionId !== wanted || !/\.html?$/i.test(place.path)) return notFound();
  const read = await deps.read(caller.accountId, place.connectionId, place.path);
  if (!read.ok)
    return read.reason === 'too_large'
      ? new Response('This page is larger than 2 MB, which is more than is served.', {
          status: 413,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        })
      : notFound();
  return new Response(read.bytes as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': RAW_POLICY,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // The owner's page, as of now: not kept by a cache that others share.
      'cache-control': 'private, no-store',
    },
  });
}

/**
 * Any other file of a repository, to look at or to save (`/raw/<repo>/<handle>/file`): a picture, a PDF, a CSV. **It is someone's bytes, and is never run or read as a page of this app**:
 *
 *  - Only a raster picture is ever shown inline, under the type its name says. Everything else (an SVG and HTML among them, which can hold script) is `application/octet-stream` and an attachment,
 *    and so is a picture when `download` asks. `nosniff`, so the browser takes the type it is told.
 *  - `sandbox` and `default-src 'none'`, so that even opened in a tab it has no origin of this app's and loads nothing.
 *  - Only the owner of the repository asks for it, and only from a vault that is not encrypted (`RawDeps.read`); anyone else is a 404 that says nothing.
 */
export const FILE_POLICY =
  "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'";

/** The largest file served. A repository is not a file host, and the whole of it passes through this server's memory. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const PICTURES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

const extensionOf = (name: string) =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';

/** Whether a file's page shows it as a picture. An SVG is not one of these: it can hold script. */
export const isPicture = (name: string): boolean => PICTURES[extensionOf(name)] !== undefined;

/** A file's name for a `content-disposition`, as RFC 6266 has it: a plain fallback and the real one encoded, so that nothing in a name can end the header. */
export function attachmentName(name: string): string {
  const plain = name.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '_');
  return `filename="${plain === '' ? 'file' : plain}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export async function handleRawFile(
  caller: { accountId: string } | null,
  connection: string,
  handle: string,
  deps: RawDeps,
  options: { download: boolean },
): Promise<Response> {
  if (!caller || !isPublicId(connection)) return notFound();
  const wanted = await deps.connection(caller.accountId, connection);
  if (wanted === undefined) return notFound();
  const place = await deps.resolve(handle);
  if (!place || place.connectionId !== wanted) return notFound();
  const read = await deps.read(caller.accountId, place.connectionId, place.path, MAX_FILE_BYTES);
  if (!read.ok)
    return read.reason === 'too_large'
      ? new Response(
          'This file is larger than 25 MB, which is more than is served. Fetch it with git.',
          {
            status: 413,
            headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          },
        )
      : notFound();
  const name = place.path.slice(place.path.lastIndexOf('/') + 1);
  const picture = PICTURES[extensionOf(name)];
  return new Response(read.bytes as BodyInit, {
    status: 200,
    headers: {
      'content-type': picture ?? 'application/octet-stream',
      'content-disposition': `${picture !== undefined && !options.download ? 'inline' : 'attachment'}; ${attachmentName(name)}`,
      'content-security-policy': FILE_POLICY,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'private, no-store',
    },
  });
}
