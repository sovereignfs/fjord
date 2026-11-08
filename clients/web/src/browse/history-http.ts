import { isCredentialError } from '../crypto/errors';
import { isProviderError } from '../providers/errors';
import type { FileVersion } from '../providers/types';
import { isRepositoryPath } from '../working/http';

/**
 * `GET /api/connections/<id>/history?path=` lists the versions of a file, and `…/history/file?path=&commit=` gives one as its bytes (research 0002, G7). Only the owner of the connection: anyone else's
 * is a 404, as if it were not there. The bytes are `application/octet-stream`, `nosniff`, an attachment and uncached: what comes back is read by the page, and is never a page itself. A file of an
 * encrypted vault is ciphertext here, as it is in the repository, opened in the browser.
 */
export interface Caller {
  accountId: string;
}

export interface HistoryDeps {
  versions(
    accountId: string,
    id: number,
    path: string,
  ): Promise<
    { found: false } | { found: true; versions: FileVersion[]; more: boolean; supported: boolean }
  >;
  file(
    accountId: string,
    id: number,
    path: string,
    commit: string,
  ): Promise<
    | { found: false }
    | {
        found: true;
        result: { ok: true; bytes: Uint8Array } | { ok: false; reason: 'missing' | 'too_large' };
      }
  >;
}

const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;
const COMMIT = /^[0-9a-f]{40}$/;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
const failure = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });
const notFound = () => failure(404, 'not_found', 'There is no such file.');

function trouble(error: unknown): Response {
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
  if (isProviderError(error, 'unauthorized'))
    return failure(
      422,
      'bad_token',
      "The git host did not accept this repository's credentials. Connect the repository again.",
    );
  if (isProviderError(error, 'unavailable'))
    return failure(
      502,
      'unavailable',
      'Could not reach the git host just now. Try again in a moment.',
    );
  console.error(`[fjord] history: unexpected ${error instanceof Error ? error.name : 'failure'}`);
  return failure(500, 'internal_error', 'Something went wrong on our side. Try again.');
}

function gate(
  request: Request,
  caller: Caller | null,
  id: string,
): { number: number; path: string; accountId: string } | Response {
  if (request.method !== 'GET')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  if (!caller) return failure(401, 'unauthorized', 'Sign in first.');
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();
  const path = new URL(request.url).searchParams.get('path');
  if (!isRepositoryPath(path))
    return failure(400, 'invalid_request', 'Say which file, by its path in the repository.');
  return { number, path, accountId: caller.accountId };
}

export async function handleHistory(
  request: Request,
  caller: Caller | null,
  deps: HistoryDeps,
  id: string,
): Promise<Response> {
  const asked = gate(request, caller, id);
  if (asked instanceof Response) return asked;
  try {
    const outcome = await deps.versions(asked.accountId, asked.number, asked.path);
    return outcome.found
      ? json(200, { versions: outcome.versions, more: outcome.more, supported: outcome.supported })
      : notFound();
  } catch (error) {
    return trouble(error);
  }
}

export async function handleHistoryFile(
  request: Request,
  caller: Caller | null,
  deps: HistoryDeps,
  id: string,
): Promise<Response> {
  const asked = gate(request, caller, id);
  if (asked instanceof Response) return asked;
  const commit = new URL(request.url).searchParams.get('commit');
  if (commit === null || !COMMIT.test(commit))
    return failure(400, 'invalid_request', 'Say which version, by its commit.');
  try {
    const outcome = await deps.file(asked.accountId, asked.number, asked.path, commit);
    if (!outcome.found) return notFound();
    if (!outcome.result.ok)
      return outcome.result.reason === 'too_large'
        ? failure(413, 'too_large', 'That version is too large to show here. Read it with git.')
        : notFound();
    return new Response(outcome.result.bytes as BodyInit, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment',
        'x-content-type-options': 'nosniff',
        'content-length': String(outcome.result.bytes.byteLength),
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return trouble(error);
  }
}
