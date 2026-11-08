import { isDocId } from '../browse/ids';
import { isAcceptablePassword } from '../sharing/password';
import { type Caller } from '../working/http';
import { type CommentMode, isCommentMode } from './publications';

/**
 * The HTTP face of publishing a Doc as a page (`/api/connections/<id>/publication`, DESIGN.md §12, ROADMAP 3h.1), written against `Request` and `Response` and handed
 * the caller, so the rules are tested directly.
 *
 *  - Only the owner of the connection publishes, looks and unpublishes; another's connection is a 404. Writes must come from this instance's own pages.
 *  - Only a Doc of a plaintext vault can be published; an id the repository does not have is refused.
 *  - **The address is in the answer to publishing, and in the owner's own status** (they are shown it again): the token is kept sealed under the instance key (`TokenVault`), and a page made before that, or on an instance with no key, has only a hash, and is shown no address. Publishing again makes a new address.
 *  - **How the page is open** is chosen when it is published and changed after (`PATCH`) without a new address: an optional password (eight characters or more; the answer never has it, only whether there
 *    is one) and who may comment (`off`, until comments are built).
 */
export interface Settings {
  /** A password to set, `null` to take it off; absent keeps what there is (and means none, when publishing). */
  password?: string | null;
  comments?: CommentMode;
}

export interface Deps {
  publish: (
    accountId: string,
    id: number,
    docId: string,
    settings: Settings,
  ) => Promise<
    | { found: false }
    | {
        found: true;
        result: { ok: true; token: string } | { ok: false; reason: 'gone' | 'unavailable' };
      }
  >;
  status: (
    accountId: string,
    id: number,
    docId: string,
  ) => Promise<
    | { found: false }
    | {
        found: true;
        publishedAt: number | null;
        passwordProtected: boolean;
        comments: CommentMode;
        /** The page's address token, for the owner to be shown it again; absent when it was not kept. */ token?: string;
      }
  >;
  /** Change how a published page is open; whether there was a page. */
  update: (
    accountId: string,
    id: number,
    docId: string,
    settings: Settings,
  ) => Promise<{ found: false } | { found: true; updated: boolean }>;
  unpublish: (
    accountId: string,
    id: number,
    docId: string,
  ) => Promise<{ found: false } | { found: true; unpublished: boolean }>;
  /** The instance's origin, `FJORD_URL`: what an address is made on. */
  origin: string;
}

const MAX_BODY_CHARS = 1000;
const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;

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
  gone: {
    status: 404,
    message:
      'That document is not in this repository, or is in an encrypted vault, which is not published from here.',
  },
  unavailable: {
    status: 502,
    message: 'Could not reach the git host just now. Nothing was changed. Try again in a moment.',
  },
} as const;

/** The address a page is opened at. */
export const pageUrl = (origin: string, token: string): string =>
  `${origin.replace(/\/+$/, '')}/p/${token}`;

/** The settings in a request's body: a password (a string, or `null` to take it off) and who may comment; a field that is wrong is a message, not ignored. */
function settingsOf(body: Record<string, unknown>): Settings | string {
  const settings: Settings = {};
  if ('password' in body && body.password !== undefined) {
    if (body.password !== null && !isAcceptablePassword(body.password))
      return 'A password is eight characters or more.';
    settings.password = body.password as string | null;
  }
  if ('comments' in body && body.comments !== undefined) {
    if (!isCommentMode(body.comments))
      return 'Comments are off, for anyone, or for people with an account here.';
    settings.comments = body.comments;
  }
  return settings;
}

/** `GET ?doc=<id>` says whether a Doc is published and how; `POST { doc, password?, comments? }` publishes it; `PATCH { doc, password?, comments? }` changes how, keeping the address; `DELETE { doc }` ends its address. */
export async function handlePublication(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  const method = request.method;
  if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  if (!caller) return failure(401, 'unauthorized', 'Sign in first.');
  if (method !== 'GET' && request.headers.get('origin') !== deps.origin)
    return failure(403, 'forbidden', 'This request did not come from this site.');
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  if (method === 'GET') {
    const docId = new URL(request.url).searchParams.get('doc');
    if (docId === null || !isDocId(docId))
      return failure(400, 'invalid_request', 'Say which document, by its id.');
    const outcome = await deps.status(caller.accountId, number, docId);
    return outcome.found
      ? json(200, {
          published: outcome.publishedAt !== null,
          publishedAt: outcome.publishedAt,
          passwordProtected: outcome.passwordProtected,
          comments: outcome.comments,
          ...(outcome.token ? { url: pageUrl(deps.origin, outcome.token) } : {}),
        })
      : notFound();
  }

  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return failure(415, 'unsupported_media_type', 'Send JSON.');
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return failure(413, 'too_large', 'That request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failure(400, 'invalid_request', 'Send a JSON object.');
  }
  const docId =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).doc
      : undefined;
  if (typeof docId !== 'string' || !isDocId(docId))
    return failure(400, 'invalid_request', 'Say which document, by its id.');

  const settings = settingsOf(body as Record<string, unknown>);
  if (typeof settings === 'string') return failure(400, 'invalid_request', settings);
  if (method === 'PATCH') {
    const outcome = await deps.update(caller.accountId, number, docId, settings);
    if (!outcome.found) return notFound();
    return outcome.updated
      ? json(200, { updated: true })
      : failure(404, 'not_published', 'That document is not published.');
  }
  if (method === 'POST') {
    const outcome = await deps.publish(caller.accountId, number, docId, settings);
    if (!outcome.found) return notFound();
    if (!outcome.result.ok) {
      const refusal = REFUSALS[outcome.result.reason];
      return failure(refusal.status, outcome.result.reason, refusal.message);
    }
    return json(201, {
      token: outcome.result.token,
      url: pageUrl(deps.origin, outcome.result.token),
    });
  }
  const outcome = await deps.unpublish(caller.accountId, number, docId);
  return outcome.found ? json(200, { unpublished: outcome.unpublished }) : notFound();
}
