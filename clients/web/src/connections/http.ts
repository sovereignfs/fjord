import { isCredentialError } from "../crypto/errors";
import { isProviderError } from "../providers/errors";
import { type ConnectionError, type ConnectionErrorCode, isConnectionError } from "./errors";
import type { VaultOptions } from "../format/types";
import type { KindChange, SetupChoice } from "../browse/setup";
import type { ConnectionInfo, ConnectionService } from "./service";

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
  service: () => Promise<Pick<ConnectionService, "addWithToken" | "list" | "remove" | "setDefault" | "setDefaultVault">>;
  /**
   * The vaults one of the caller's repositories has, read from its git host: `found: false` if it is not the caller's
   * (or not there), `vaults: null` if the host could not be asked. Only called for a connection the caller owns.
   */
  vaults: (accountId: string, id: number) => Promise<{ found: false } | { found: true; vaults: string[] | null }>;
  /**
   * Set one of the caller's repositories up as a Fjord repository with a vault of this name (ROADMAP 1a.10), or
   * throw a `ConnectionError` saying why not. `found: false` if it is not the caller's (or not there). The browser
   * says only the name; what is written is decided by the server, on the repository as it is.
   */
  setUp: (accountId: string, id: number, choice: SetupChoice) => Promise<{ found: false } | { found: true; commit: string }>;
  /**
   * Change one of the caller's Fjord repositories' kind (ROADMAP 3a.3): one commit of `fjord.json`, or a `ConnectionError` saying
   * which rule of the new kind it breaks. `found: false` if it is not the caller's (or not there).
   */
  changeKind: (accountId: string, id: number, change: KindChange) => Promise<{ found: false } | { found: true; commit: string }>;
  /**
   * Add a vault, plaintext or encrypted, to one of the caller's Fjord repositories (ROADMAP 2d.1): one commit, or a
   * `ConnectionError` saying why not. `found: false` if it is not the caller's (or not there). The browser says only what it
   * wants; what is written is decided by the server, on the repository as it is.
   */
  addVault: (accountId: string, id: number, options: VaultOptions) => Promise<{ found: false } | { found: true; commit: string; vaultId: string }>;
  /**
   * Told of a repository just connected, before the person is: it reads the repository so that what kind it is, which the tile and the rail draw
   * their icon from, is known when they first see it (and not only once it has been opened). Whatever goes wrong here is not the connection's failure.
   */
  connected?: (accountId: string, connection: ConnectionInfo) => Promise<void>;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

const MAX_BODY_BYTES = 8_000;
const MAX_VAULT_LENGTH = 255;
const MAX_RECIPIENTS = 64;
const MAX_KEY_LENGTH = 512;

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
  unknown_vault: 422,
  already_fjord: 409,
  has_vaults: 409,
  head_moved: 409,
  gitattributes_unreadable: 422,
  invalid_vault_name: 422,
  vault_name_taken: 422,
  manifest_unusable: 409,
  newer_version: 422,
  invalid_vault_options: 422,
  file_taken: 409,
  kind_rule: 422,
  invalid_name: 422,
  limit_reached: 409,
  would_overwrite: 409,
  not_local: 409,
  not_verified: 502,
};

const NOT_CONFIGURED = "This instance cannot store repository tokens yet: its administrator needs to set FJORD_ENCRYPTION_KEY.";

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });

export function unsignedIn(caller: Caller | null): Response | undefined {
  return caller ? undefined : failure(401, "unauthorized", "Sign in first.");
}

export function crossOrigin(request: Request, deps: { origin: string }): Response | undefined {
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
    await deps.connected?.(account, connection).catch(() => undefined);
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

/** `PUT` chooses which vault of one of the caller's repositories opens first, `{ "vault": "<directory>" }`, or `null` to forget the choice. */
export async function handleVault(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "PUT") return failure(405, "method_not_allowed", "That method is not allowed here.");
  const denied = unsignedIn(caller) ?? crossOrigin(request, deps);
  if (denied) return denied;
  const account = (caller as Caller).accountId;
  const number = /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : undefined;
  const notFound = () => failure(404, "not_found", "There is no such connection.");
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return failure(415, "unsupported_media_type", "Send JSON.");
    }
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const vault = body.vault;
    if (vault !== null && (typeof vault !== "string" || vault === "" || vault.length > MAX_VAULT_LENGTH)) {
      return failure(400, "invalid_request", "Send the vault's directory as text, or null.");
    }

    // The vault has to be one the repository has: checked against the repository, and only for a connection that is theirs.
    if (vault !== null) {
      const known = await deps.vaults(account, number);
      if (!known.found) return notFound();
      if (known.vaults === null) return failure(502, "unavailable", "Could not read that repository just now. Try again in a moment.");
      if (!known.vaults.includes(vault)) return failure(STATUS.unknown_vault, "unknown_vault", "That repository has no such vault.");
    }
    const done = await (await deps.service()).setDefaultVault(account, number, vault);
    return done ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : notFound();
  } catch (error) {
    return fromError(error);
  }
}

/**
 * What the browser asks a repository to be set up as (ROADMAP 1a.10, 3a.3): `{ "vault" }` (a drive, as before kinds), `{ "kind":
 * "journal", "vault", "encrypted", "recipients": ["age1…"] }` or `{ "kind": "ssg", "engine": "astro" | "jekyll", "adopt"?: "src/content" }` (the folder
 * an existing site's engine reads its content from, made the vault: RFC 0002). Only the shape is
 * checked here; a key is the format module's to judge, and the plan is the server's, made on the repository as it is.
 */
function setupChoice(body: Record<string, unknown>): SetupChoice | undefined {
  const name = (value: unknown) => typeof value === "string" && value !== "" && value.length <= MAX_VAULT_LENGTH;
  const kind = body.kind ?? "drive";
  if (kind === "drive") return name(body.vault) ? { kind: "drive", vault: body.vault as string } : undefined;
  if (kind === "journal") {
    const recipients = body.recipients ?? [];
    if (!name(body.vault) || typeof (body.encrypted ?? false) !== "boolean") return undefined;
    if (!Array.isArray(recipients) || recipients.length > MAX_RECIPIENTS || !recipients.every((key) => typeof key === "string" && key.length <= MAX_KEY_LENGTH)) return undefined;
    return { kind: "journal", vault: body.vault as string, encrypted: body.encrypted === true, recipients: recipients as string[] };
  }
  if (kind === "ssg") {
    // A site's content is published: there is no encrypted site to ask for, and asking is refused rather than ignored.
    if (body.encrypted !== undefined && body.encrypted !== false) return undefined;
    if (body.engine !== "astro" && body.engine !== "jekyll") return undefined;
    if (body.adopt === undefined) return { kind: "ssg", engine: body.engine };
    return name(body.adopt) ? { kind: "ssg", engine: body.engine, adopt: body.adopt as string } : undefined;
  }
  return undefined;
}

/** `POST` sets one of the caller's repositories up as a Fjord repository of a kind (see `setupChoice`): one commit. */
export async function handleSetup(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  const denied = unsignedIn(caller) ?? crossOrigin(request, deps);
  if (denied) return denied;
  const number = /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : undefined;
  if (number === undefined) return failure(404, "not_found", "There is no such connection.");

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return failure(415, "unsupported_media_type", "Send JSON.");
    }
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const choice = setupChoice(body);
    if (choice === undefined) return failure(400, "invalid_request", "Send the vault's name as text, or a kind with what it needs.");
    const done = await deps.setUp((caller as Caller).accountId, number, choice);
    return done.found ? json(201, { commit: done.commit }) : failure(404, "not_found", "There is no such connection.");
  } catch (error) {
    return fromError(error);
  }
}

/**
 * `POST` adds a vault to one of the caller's Fjord repositories, `{ "name", "encrypted", "idNaming", "recipients": ["age1…"] }`: one
 * commit. A key is checked by the format module, not here; this checks only that the body is the right shape and not enormous.
 */
export async function handleAddVault(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  const denied = unsignedIn(caller) ?? crossOrigin(request, deps);
  if (denied) return denied;
  const number = /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : undefined;
  if (number === undefined) return failure(404, "not_found", "There is no such connection.");

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return failure(415, "unsupported_media_type", "Send JSON.");
    }
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const invalid = () => failure(400, "invalid_request", "Send the vault's name as text, whether it is encrypted, and its recipients as a list of keys.");
    const { name, encrypted, idNaming, recipients } = body;
    if (typeof name !== "string" || name === "" || name.length > MAX_VAULT_LENGTH) return invalid();
    if (encrypted !== undefined && typeof encrypted !== "boolean") return invalid();
    if (idNaming !== undefined && typeof idNaming !== "boolean") return invalid();
    if (recipients !== undefined && (!Array.isArray(recipients) || recipients.length > MAX_RECIPIENTS || recipients.some((key) => typeof key !== "string" || key.length > MAX_KEY_LENGTH))) return invalid();
    const done = await deps.addVault((caller as Caller).accountId, number, {
      name,
      encrypted: encrypted === true,
      idNaming: idNaming === true,
      recipients: (recipients as string[] | undefined) ?? [],
    });
    return done.found ? json(201, { commit: done.commit, vaultId: done.vaultId }) : failure(404, "not_found", "There is no such connection.");
  } catch (error) {
    return fromError(error);
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
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
export function fromError(error: unknown): Response {
  if (isConnectionError(error)) return failure(STATUS[(error as ConnectionError).code], (error as ConnectionError).code, (error as ConnectionError).message);
  if (isCredentialError(error, "no_key")) return failure(503, "not_configured", NOT_CONFIGURED);
  // Adding a vault or changing a kind on a repository that is on this server, at one of its account's limits: nothing was written.
  if (isProviderError(error, "limit_reached")) return failure(409, "limit_reached", error.message);
  console.error(`[fjord] connections: unexpected ${error instanceof Error ? error.name : "failure"}`);
  return failure(500, "internal_error", "Something went wrong on our side. Try again.");
}

/** `PUT` changes one of the caller's Fjord repositories' kind, `{ "kind": "drive" | "journal" | "ssg", "engine"? }`: one commit (ROADMAP 3a.3). */
export async function handleKind(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "PUT") return failure(405, "method_not_allowed", "That method is not allowed here.");
  const denied = unsignedIn(caller) ?? crossOrigin(request, deps);
  if (denied) return denied;
  const number = /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : undefined;
  if (number === undefined) return failure(404, "not_found", "There is no such connection.");

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return failure(415, "unsupported_media_type", "Send JSON.");
    }
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const kind = body.kind;
    if (kind !== "drive" && kind !== "journal" && kind !== "ssg") return failure(400, "invalid_request", "Send a kind: drive, journal or ssg.");
    if (kind === "ssg" ? body.engine !== "astro" && body.engine !== "jekyll" : body.engine !== undefined) {
      return failure(400, "invalid_request", "A site needs its engine, astro or jekyll; another kind has none.");
    }
    const change: KindChange = kind === "ssg" ? { kind, engine: body.engine as "astro" | "jekyll" } : { kind };
    const done = await deps.changeKind((caller as Caller).accountId, number, change);
    return done.found ? json(200, { commit: done.commit }) : failure(404, "not_found", "There is no such connection.");
  } catch (error) {
    return fromError(error);
  }
}
