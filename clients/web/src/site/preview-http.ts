import { isCredentialError } from '../crypto/errors';
import { isProviderError } from '../providers/errors';
import type { Identity } from '../providers/types';
import type { Candidates, PreviewView, StartResult, StopResult } from './preview';
import { MAX_PREVIEWS } from './preview';
import type { SiteRefusal } from './posts';

/**
 * The HTTP face of previewing a site's unsaved changes (`/api/connections/<id>/previews`, ROADMAP 3d.1): who may call, what they may send, what
 * they are told. Written against `Request` and `Response` and handed the caller, like the other write routes.
 *
 *  - `GET` lists the caller's previews and says what a new one would hold; `POST` starts one; `DELETE ?branch=` stops one.
 *  - Nobody who is not signed in: 401, before anything is read. A write is from this instance's own pages (its `Origin`).
 *  - An account previews its own connections only; another's is 404.
 *  - **No branch name, path or text is taken from the request to start one**: the branch is made by the server, from the default branch's head, and what is
 *    in it is the caller's own drafts. A branch is named only to stop it, and only one of the caller's own previews is ever deleted (`preview.ts`).
 */
export interface Caller {
  accountId: string;
  name: string;
  email: string;
}

export interface Listing {
  previews: PreviewView[];
  /** What a new preview would hold, found without writing anything. */
  pending: { files: string[]; skipped: Candidates['skipped'] };
}

export type ListRefusal = SiteRefusal | 'too_large' | 'unavailable';

export interface Deps {
  origin: string;
  list: (
    accountId: string,
    id: number,
  ) => Promise<
    | { found: false }
    | { found: true; result: { ok: true; listing: Listing } | { ok: false; reason: ListRefusal } }
  >;
  start: (
    accountId: string,
    id: number,
    author: Identity,
  ) => Promise<
    { found: false } | { found: true; result: StartResult | { ok: false; reason: SiteRefusal } }
  >;
  stop: (
    accountId: string,
    id: number,
    branch: string,
  ) => Promise<
    { found: false } | { found: true; result: StopResult | { ok: false; reason: SiteRefusal } }
  >;
}

const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;
const MAX_BRANCH_CHARS = 200;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
const failure = (
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => json(status, { error: { code, message, ...extra } });
const notFound = () => failure(404, 'not_found', 'There is no such connection.');

const REFUSALS: Record<string, { status: number; message: string }> = {
  not_a_site: {
    status: 422,
    message: 'This repository is not a site with one vault, so there is nothing to preview.',
  },
  unknown_engine: {
    status: 422,
    message: "This site's engine is not one this version knows (Astro or Jekyll).",
  },
  unsupported_site: {
    status: 422,
    message:
      "This site's vault cannot be previewed from here: its manifest cannot be read, it is encrypted, or its files are not named plainly.",
  },
  too_large: {
    status: 422,
    message: 'This repository is too large to list at once, so a preview cannot be made from here.',
  },
  too_many: {
    status: 409,
    message: `You already have ${MAX_PREVIEWS} previews of this site. Stop one first.`,
  },
  nothing_to_preview: {
    status: 422,
    message:
      "There is nothing to preview: none of your unsaved changes to this site's posts is ready. Edit a post, and it is kept as you type.",
  },
  not_yours: { status: 404, message: 'That is not one of your previews.' },
  gone: { status: 404, message: 'That preview is already gone.' },
  read_only: {
    status: 422,
    message:
      'That token can read this repository but not write to it, so a preview cannot be made. Create the token with the repository permission “Contents: Read and write”, and connect the repository again.',
  },
  bad_token: {
    status: 422,
    message:
      "The git host did not accept this repository's token. Connect the repository again with a new one.",
  },
  unavailable: {
    status: 502,
    message: 'Could not reach the git host just now. Nothing was changed. Try again in a moment.',
  },
};

const SKIPPED: Record<string, string> = {
  changed_upstream: 'changed in the repository since you started editing it',
  not_text: 'is in an encrypted vault',
  gone: 'is not in the repository any more',
};

function refusal(reason: string, skipped?: Candidates['skipped']): Response {
  const known = REFUSALS[reason] ?? {
    status: 500,
    message: 'Something went wrong on our side. Try again.',
  };
  const detail =
    skipped && skipped.length > 0
      ? ` Left out: ${skipped.map((entry) => `${entry.path} ${SKIPPED[entry.reason] ?? ''}`.trim()).join('; ')}.`
      : '';
  return failure(known.status, reason, known.message + detail, skipped ? { skipped } : {});
}

function fromError(error: unknown): Response {
  if (isCredentialError(error, 'no_key'))
    return failure(
      503,
      'not_configured',
      'This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.',
    );
  if (isProviderError(error, 'rate_limited'))
    return failure(
      429,
      'rate_limited',
      'The git host is limiting requests. Try again in a moment.',
    );
  console.error(`[fjord] previews: unexpected ${error instanceof Error ? error.name : 'failure'}`);
  return failure(500, 'internal_error', 'Something went wrong on our side. Try again.');
}

export async function handlePreviews(
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

  try {
    if (method === 'GET') {
      const outcome = await deps.list(caller.accountId, number);
      if (!outcome.found) return notFound();
      if (!outcome.result.ok) return refusal(outcome.result.reason);
      return json(200, { ...outcome.result.listing, max: MAX_PREVIEWS });
    }

    if (method === 'POST') {
      const outcome = await deps.start(caller.accountId, number, {
        name: caller.name,
        email: caller.email,
      });
      if (!outcome.found) return notFound();
      const { result } = outcome;
      if (result.ok)
        return json(201, { branch: result.branch, files: result.files, skipped: result.skipped });
      return refusal(result.reason, 'skipped' in result ? result.skipped : undefined);
    }

    const branch = new URL(request.url).searchParams.get('branch');
    if (branch === null || branch === '' || branch.length > MAX_BRANCH_CHARS)
      return failure(400, 'invalid_request', 'Say which preview to stop, by its branch.');
    const outcome = await deps.stop(caller.accountId, number, branch);
    if (!outcome.found) return notFound();
    return outcome.result.ok
      ? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      : refusal(outcome.result.reason);
  } catch (error) {
    return fromError(error);
  }
}
