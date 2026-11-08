import { type Caller } from '../working/http';
import { pageUrl } from './http';

/**
 * Publishing a **copy** of a file of an encrypted vault as a page (`/api/connections/<id>/publication/copy`, DESIGN.md §12, ROADMAP 3h.2, RFC 0002). The server has
 * no key and cannot render such a file, so the owner's browser decrypts it and hands over its title and Markdown in the clear. That is plaintext leaving the vault by
 * the owner's choice, so the request must say, in `understood: true`, that they agreed to it being readable by anyone with the address and kept on the server until
 * they unpublish; without it nothing is stored. Never the default of anything: a page asks first.
 *
 *  - Only the owner of the connection; another's is a 404. Writes must come from this instance's own pages.
 *  - Only a file of an **encrypted** vault of that connection: a file of a plaintext vault is published from the repository (`http.ts`).
 *  - **The address is in the answer, once**, as for any page.
 */
export interface Deps {
  publish: (
    accountId: string,
    id: number,
    input: { path: string; title: string; body: string },
  ) => Promise<
    | { found: false }
    | {
        found: true;
        result:
          { ok: true; token: string } | { ok: false; reason: 'not_encrypted' | 'unavailable' };
      }
  >;
  status: (
    accountId: string,
    id: number,
    path: string,
  ) => Promise<{ found: false } | { found: true; publishedAt: number | null; token?: string }>;
  unpublish: (
    accountId: string,
    id: number,
    path: string,
  ) => Promise<{ found: false } | { found: true; unpublished: boolean }>;
  origin: string;
}

export const MAX_COPY_BODY_CHARS = 262_144;
const MAX_REQUEST_CHARS = MAX_COPY_BODY_CHARS * 2 + 4_000;
const MAX_TITLE_CHARS = 200;
const MAX_PATH_CHARS = 1_000;
const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
const failure = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });
const notFound = () => failure(404, 'not_found', 'There is no such connection.');

const REFUSALS = {
  not_encrypted: {
    status: 422,
    message:
      'That file is not in an encrypted vault. A file of a plaintext vault is published from the repository, with no copy.',
  },
  unavailable: {
    status: 502,
    message: 'Could not reach the git host just now. Nothing was changed. Try again in a moment.',
  },
} as const;

const isPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_PATH_CHARS &&
  value.includes('/') &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.includes('\0') &&
  !value.split('/').some((part) => part === '' || part === '.' || part === '..');

/** `GET ?path=` says whether a file is published; `POST { path, title, body, understood: true }` publishes a copy; `DELETE { path }` ends its address. */
export async function handleCopy(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  const method = request.method;
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  if (!caller) return failure(401, 'unauthorized', 'Sign in first.');
  if (method !== 'GET' && request.headers.get('origin') !== deps.origin)
    return failure(403, 'forbidden', 'This request did not come from this site.');
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  if (method === 'GET') {
    const path = new URL(request.url).searchParams.get('path');
    if (!isPath(path)) return failure(400, 'invalid_request', 'Say which file, by its path.');
    const outcome = await deps.status(caller.accountId, number, path);
    return outcome.found
      ? json(200, {
          published: outcome.publishedAt !== null,
          publishedAt: outcome.publishedAt,
          ...(outcome.token ? { url: pageUrl(deps.origin, outcome.token) } : {}),
        })
      : notFound();
  }

  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return failure(415, 'unsupported_media_type', 'Send JSON.');
  const text = await request.text();
  if (text.length > MAX_REQUEST_CHARS)
    return failure(413, 'too_large', 'That request is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure(400, 'invalid_request', 'Send a JSON object.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return failure(400, 'invalid_request', 'Send a JSON object.');
  const body = parsed as Record<string, unknown>;
  if (!isPath(body.path)) return failure(400, 'invalid_request', 'Say which file, by its path.');

  if (method === 'DELETE') {
    const outcome = await deps.unpublish(caller.accountId, number, body.path);
    return outcome.found ? json(200, { unpublished: outcome.unpublished }) : notFound();
  }

  if (body.understood !== true)
    return failure(
      422,
      'not_agreed',
      'Publishing a copy of an encrypted file makes it readable by anyone with the address, and keeps the copy on the server. Say that you understand, and nothing is stored until you do.',
    );
  const { title, body: markdown } = body;
  if (
    typeof title !== 'string' ||
    title.length > MAX_TITLE_CHARS ||
    CONTROL.test(title) ||
    !title.isWellFormed()
  )
    return failure(
      400,
      'invalid_request',
      `Send the title as one line of at most ${MAX_TITLE_CHARS} characters.`,
    );
  if (
    typeof markdown !== 'string' ||
    markdown.length > MAX_COPY_BODY_CHARS ||
    !markdown.isWellFormed()
  )
    return failure(
      400,
      'invalid_request',
      `Send the text as at most ${MAX_COPY_BODY_CHARS} characters.`,
    );

  const outcome = await deps.publish(caller.accountId, number, {
    path: body.path,
    title,
    body: markdown,
  });
  if (!outcome.found) return notFound();
  if (!outcome.result.ok) {
    const refusal = REFUSALS[outcome.result.reason];
    return failure(refusal.status, outcome.result.reason, refusal.message);
  }
  return json(201, {
    token: outcome.result.token,
    url: `${deps.origin.replace(/\/+$/, '')}/p/${outcome.result.token}`,
  });
}
