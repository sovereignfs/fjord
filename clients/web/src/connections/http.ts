import { isCredentialError } from "../crypto/errors";
import { type ConnectionError, type ConnectionErrorCode, isConnectionError } from "./errors";
import type { ConnectionService } from "./service";

/**
 * The HTTP face of connections (`/api/connections`): who may call, what they may send, what they
 * are told. Written against `Request` and `Response` and handed the caller, so the rules are
 * tested directly and the route files are only the glue that finds the session.
 *
 *  - Nobody who is not signed in: 401, before anything is read.
 *  - A write must come from this instance's own pages: its `Origin` is checked against
 *    `FJORD_URL`, so a page on another site cannot make a signed-in person's browser connect a
 *    repository with a token it chose.
 *  - An account sees and changes only its own connections: another's is 404, as if it were not there.
 *    That includes choosing its default.
 *  - A token comes in on one request and is never in any response, log line or error.
 */
export interface Caller {
  accountId: string;
}

export interface Deps {
  /** The service, or an error saying why there is none (no instance key). */
  service: () => Promise<Pick<ConnectionService, "addWithToken" | "list" | "remove" | "setDefault">>;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

const MAX_BODY_BYTES = 8_000;

const STATUS: Record<ConnectionErrorCode, number> = {
  invalid_repository: 422,
  unsupported_host: 422,
  invalid_token: 422,
  bad_token: 422,
  not_found: 422,
  forbidden: 422,
  read_only: 422,
  empty_repository: 422,
  already_connected: 409,
  rate_limited: 429,
  unavailable: 502,
  not_configured: 503,
};

const NOT_CONFIGURED = "This instance cannot store repository tokens yet: its administrator needs to set FJORD_ENCRYPTION_KEY.";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });

function unsignedIn(caller: Caller | null): Response | undefined {
  return caller ? undefined : failure(401, "unauthorized", "Sign in first.");
}

function crossOrigin(request: Request, deps: Deps): Response | undefined {
  return request.headers.get("origin") === deps.origin ? undefined : failure(403, "forbidden", "This request did not come from this site.");
}

/** `GET` lists the caller's connections, `POST` connects a repository by token. */
export async function handleConnections(request: Request, caller: Caller | null, deps: Deps): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  const denied = unsignedIn(caller) ?? (method === "POST" ? crossOrigin(request, deps) : undefined);
  if (denied) return denied;
  const account = (caller as Caller).accountId;

  try {
    if (method === "GET") return json(200, { connections: await (await deps.service()).list(account) });

    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return failure(415, "unsupported_media_type", "Send JSON.");
    }
    const body = await readJson(request);
    if (body instanceof Response) return body;
    if (typeof body.repository !== "string" || typeof body.token !== "string") {
      return failure(400, "invalid_request", "Send the repository and the token as text.");
    }
    const { connection, warnings } = await (await deps.service()).addWithToken(account, { repository: body.repository, token: body.token });
    return json(201, { connection, warnings });
  } catch (error) {
    return fromError(error);
  }
}

/** `DELETE` disconnects one of the caller's connections. */
export async function handleConnection(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "DELETE") return failure(405, "method_not_allowed", "That method is not allowed here.");
  const denied = unsignedIn(caller) ?? crossOrigin(request, deps);
  if (denied) return denied;
  const number = /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : undefined;
  try {
    const removed = number === undefined ? false : await (await deps.service()).remove((caller as Caller).accountId, number);
    return removed ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : failure(404, "not_found", "There is no such connection.");
  } catch (error) {
    return fromError(error);
  }
}

/** `POST` makes one of the caller's connections their default, where `/` lands. */
export async function handleDefault(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  const denied = unsignedIn(caller) ?? crossOrigin(request, deps);
  if (denied) return denied;
  const number = /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : undefined;
  try {
    const done = number === undefined ? false : await (await deps.service()).setDefault((caller as Caller).accountId, number);
    return done ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : failure(404, "not_found", "There is no such connection.");
  } catch (error) {
    return fromError(error);
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return failure(413, "too_large", "That request is too large.");
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return failure(400, "invalid_request", "Send a JSON object.");
}

/** What a person is told. An error we did not expect is logged by name, never by message, and answered plainly. */
function fromError(error: unknown): Response {
  if (isConnectionError(error)) return failure(STATUS[(error as ConnectionError).code], (error as ConnectionError).code, (error as ConnectionError).message);
  if (isCredentialError(error, "no_key")) return failure(503, "not_configured", NOT_CONFIGURED);
  console.error(`[fjord] connections: unexpected ${error instanceof Error ? error.name : "failure"}`);
  return failure(500, "internal_error", "Something went wrong on our side. Try again.");
}
