import {
  type Caller,
  crossOrigin,
  failure,
  fromError,
  json,
  readJson,
  unsignedIn,
} from '../connections/http';
import type { ConnectionInfo } from '../connections/service';
import type { NewLocalRepository } from './create';
import type { LocalUsage } from './limits';
import type { SyncInput, SyncResult } from './sync';

/**
 * The HTTP face of repositories on this server (ROADMAP 3i): `/api/connections/local`, where a person makes one and asks how much of their
 * allowance is used, and `/api/connections/[id]/sync`, which moves one to a git repository. The rules are `connections/http.ts`'s, the
 * same for the same reasons: nobody who is not signed in (401, before anything is read), this site's own `Origin` on every write, and an
 * account only ever reaches its own (another's repository is 404, as if it were not there). The token in a sync request is checked and
 * used by the server and is in no response, log line or error.
 */
export interface LocalDeps {
  create: (accountId: string, input: NewLocalRepository) => Promise<ConnectionInfo>;
  usage: (accountId: string) => Promise<LocalUsage>;
  /** Syncs one of the caller's server-side repositories; `undefined` if it is not theirs (or not there). */
  sync: (accountId: string, id: number, input: SyncInput) => Promise<SyncResult | undefined>;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

const MAX_NAME_LENGTH = 200;

/** `GET` says what the caller holds on this server and what they may; `POST` makes a repository there, `{ "name", "kind": "drive" | "journal" }`. */
export async function handleLocalRepositories(
  request: Request,
  caller: Caller | null,
  deps: LocalDeps,
): Promise<Response> {
  const method = request.method;
  if (method !== 'GET' && method !== 'POST')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  const denied = unsignedIn(caller) ?? (method === 'POST' ? crossOrigin(request, deps) : undefined);
  if (denied) return denied;
  const account = (caller as Caller).accountId;

  try {
    if (method === 'GET') return json(200, { usage: await deps.usage(account) });
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
      return failure(415, 'unsupported_media_type', 'Send JSON.');
    const body = await readJson(request);
    if (body instanceof Response) return body;
    if (typeof body.name !== 'string' || body.name.length > MAX_NAME_LENGTH)
      return failure(400, 'invalid_request', "Send the repository's name as text.");
    if (body.kind !== 'drive' && body.kind !== 'journal')
      return failure(400, 'invalid_request', 'Send a kind: drive or journal.');
    const connection = await deps.create(account, { name: body.name, kind: body.kind });
    return json(201, { connection });
  } catch (error) {
    return fromError(error);
  }
}

/** `POST` moves one of the caller's server-side repositories to a git repository, `{ "repository", "token" }`. See `sync.ts` for what that does and never does. */
export async function handleSync(
  request: Request,
  caller: Caller | null,
  deps: LocalDeps,
  id: string,
): Promise<Response> {
  if (request.method !== 'POST')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  const denied = unsignedIn(caller) ?? crossOrigin(request, deps);
  if (denied) return denied;
  const number = /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : undefined;
  if (number === undefined) return failure(404, 'not_found', 'There is no such connection.');

  try {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
      return failure(415, 'unsupported_media_type', 'Send JSON.');
    const body = await readJson(request);
    if (body instanceof Response) return body;
    if (typeof body.repository !== 'string' || typeof body.token !== 'string')
      return failure(400, 'invalid_request', 'Send the repository and the token as text.');
    const done = await deps.sync((caller as Caller).accountId, number, {
      repository: body.repository,
      token: body.token,
    });
    if (!done) return failure(404, 'not_found', 'There is no such connection.');
    return json(200, {
      connection: done.connection,
      commit: done.commit,
      added: done.added,
      already: done.already,
    });
  } catch (error) {
    return fromError(error);
  }
}
