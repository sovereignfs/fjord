import { safeSegments } from "../browse/location";
import { isCredentialError } from "../crypto/errors";
import { isProviderError } from "../providers/errors";
import type { Identity } from "../providers/types";
import { MAX_CONTENT_BYTES, type SaveResult } from "./service";
import { MAX_MESSAGE_CHARS } from "./limits";
import type { Choice, ResolveResult } from "./resolve";
import type { VersionResult } from "./version";

/**
 * The HTTP face of drafts (`/api/connections/<id>/working-copy`): who may call, what they may send, what they are told.
 * Like `src/connections/http.ts`, it is written against `Request` and `Response` and handed the caller, so the rules are
 * tested directly and the route file is only the glue that finds the session.
 *
 *  - Nobody who is not signed in: 401, before anything is read.
 *  - A write must come from this instance's own pages: its `Origin` is checked against `FJORD_URL`.
 *  - An account changes the drafts of its own connections only: another's is 404, as if it were not there.
 *  - A path is a name inside the repository, never a way out of it; a base is a git object id.
 *  - A draft is started only for a file that is an editable note in the repository (`Deps.save` checks it).
 */
export interface Caller {
  accountId: string;
  /** How a commit names them (`handleVersion`): the account's own name and address. */
  name: string;
  email: string;
}

export type SaveOutcome =
  | { found: false }
  | { found: true; result: SaveResult | { ok: false; reason: "not_editable" } | { ok: false; reason: "unavailable" } };

export interface Deps {
  /** Keep a draft of one of the caller's repositories. `found: false` if it is not the caller's (or not there). */
  save: (accountId: string, id: number, input: { path: string; baseBlob: string; content: string }) => Promise<SaveOutcome>;
  /** Throw a draft away. `found: false` if the repository is not the caller's. Throwing away what is not there is not an error. */
  discard: (accountId: string, id: number, path: string) => Promise<{ found: boolean }>;
  /**
   * Make a version of one of the caller's drafts (ROADMAP 1b.9): one commit, authored by `author`. `found: false` if the
   * repository is not the caller's.
   */
  saveVersion: (accountId: string, id: number, input: { path: string; message: string | undefined; author: Identity }) => Promise<{ found: false } | { found: true; result: VersionResult }>;
  /**
   * Go on from a file that changed in the repository (ROADMAP 1b.10): move the caller's draft onto it, as it is or merged.
   * `found: false` if the repository is not the caller's.
   */
  resolve: (accountId: string, id: number, input: { path: string; choice: Choice; upstreamBlob: string }) => Promise<{ found: false } | { found: true; result: ResolveResult }>;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

/** The text is at most 1 MiB, but JSON can spell each character of it as six. */
export const MAX_BODY_CHARS = 7 * 1024 * 1024;
const MAX_PATH_CHARS = 1024;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const failure = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => json(status, { error: { code, message, ...extra } });

/** Whether `path` can name a file in a repository: relative, forward slashes, no empty step and no way up. */
export function isRepositoryPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= MAX_PATH_CHARS && safeSegments(path.split("/")) !== undefined && path.isWellFormed();
}

/** `PUT` keeps the text as the draft of a file, `{ path, baseBlob, content }`; `DELETE ?path=` throws the draft away. */
export async function handleWorkingCopy(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  const method = request.method;
  if (method !== "PUT" && method !== "DELETE") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (method === "DELETE") {
      const path = new URL(request.url).searchParams.get("path");
      if (!isRepositoryPath(path)) return failure(400, "invalid_request", "Say which file, by its path in the repository.");
      const { found } = await deps.discard(caller.accountId, number, path);
      return found ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : notFound();
    }

    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_CHARS * 4) return tooLarge();
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return tooLarge();
    const body = parse(text);
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");
    const { path, baseBlob, content } = body;
    if (!isRepositoryPath(path)) return failure(400, "invalid_request", "Say which file, by its path in the repository.");
    if (typeof baseBlob !== "string" || !OBJECT_ID.test(baseBlob)) return failure(400, "invalid_request", "Say which version of the file the draft is of, by its git object id.");
    if (typeof content !== "string") return failure(400, "invalid_request", "Send the text as text.");

    const outcome = await deps.save(caller.accountId, number, { path, baseBlob, content });
    if (!outcome.found) return notFound();
    return fromResult(outcome.result);
  } catch (error) {
    return fromError(error);
  }
}

/** `POST` makes a version of a file's draft, `{ path, message? }`: one commit, with the caller as its author. */
export async function handleVersion(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    if (text.length > MAX_VERSION_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
    const body = parse(text);
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");
    const { path, message } = body;
    if (!isRepositoryPath(path)) return failure(400, "invalid_request", "Say which file, by its path in the repository.");
    if (message !== undefined && message !== null && (typeof message !== "string" || message.length > MAX_MESSAGE_CHARS || message.includes("\u0000") || !message.isWellFormed())) {
      return failure(400, "invalid_request", `Send the message as text of at most ${MAX_MESSAGE_CHARS} characters, or leave it out.`);
    }

    const outcome = await deps.saveVersion(caller.accountId, number, { path, message: typeof message === "string" ? message : undefined, author: { name: caller.name, email: caller.email } });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(201, { commit: result.commit });
    const refusal = VERSION_REFUSALS[result.reason];
    return failure(refusal.status, result.reason, refusal.message);
  } catch (error) {
    return fromError(error);
  }
}

/** `POST` moves a draft onto the file as it now is, `{ path, choice: "mine" | "combine", upstreamBlob }`: nothing is written to the repository. */
export async function handleResolve(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    if (text.length > MAX_RESOLVE_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
    const body = parse(text);
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");
    const { path, choice, upstreamBlob } = body;
    if (!isRepositoryPath(path)) return failure(400, "invalid_request", "Say which file, by its path in the repository.");
    if (choice !== "mine" && choice !== "combine") return failure(400, "invalid_request", "Say whether to keep yours or to combine.");
    if (typeof upstreamBlob !== "string" || !OBJECT_ID.test(upstreamBlob)) return failure(400, "invalid_request", "Say which version of the file you were shown, by its git object id.");

    const outcome = await deps.resolve(caller.accountId, number, { path, choice, upstreamBlob });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(200, { conflicts: result.conflicts });
    const refusal = RESOLVE_REFUSALS[result.reason];
    return failure(refusal.status, result.reason, refusal.message);
  } catch (error) {
    return fromError(error);
  }
}

const MAX_RESOLVE_BODY_CHARS = 8_000;

/** What each reason a draft was not moved is told as. The draft is as it was in every one. */
const RESOLVE_REFUSALS: Record<Extract<ResolveResult, { ok: false }>["reason"], { status: number; message: string }> = {
  no_draft: { status: 409, message: "There are no changes to go on with in this note." },
  up_to_date: { status: 409, message: "This note has not changed in the repository since you started, so there is nothing to choose." },
  gone: { status: 409, message: "This note is no longer in the repository. Your changes are kept." },
  upstream_moved: { status: 409, message: "The note changed in the repository again while you were looking. Nothing was changed; look at it again." },
  draft_changed: { status: 409, message: "Your changes were edited while this was being done, so nothing was changed. Look again." },
  unreadable: { status: 422, message: "Either version is not valid UTF-8 text or is larger than 1 MB, so they cannot be combined here. Your changes are kept; you can keep yours or take theirs." },
  unstorable: { status: 422, message: "The combined text cannot be kept as a draft (it has a NUL character or is larger than 1 MB). Your changes are kept; you can keep yours or take theirs." },
  bad_token: { status: 422, message: "The git host did not accept this repository's token. Connect the repository again with a new one. Your changes are kept." },
  unavailable: { status: 502, message: "Could not reach the git host just now. Nothing was changed, and your changes are kept. Try again in a moment." },
};

const MAX_VERSION_BODY_CHARS = 8_000 + MAX_MESSAGE_CHARS * 6;

/** What each reason a version was not made is told as. Nothing was written, and the draft is kept, in each but the one that says otherwise. */
const VERSION_REFUSALS: Record<Extract<VersionResult, { ok: false }>["reason"], { status: number; message: string }> = {
  no_draft: { status: 409, message: "There are no changes to save in this note." },
  nothing_to_save: { status: 409, message: "This note is the same as the one in the repository, so there is nothing to save. The draft was dropped." },
  upstream_changed: { status: 409, message: "This note changed in the repository after you started editing it. Nothing was saved, and your changes are kept." },
  gone: { status: 409, message: "This note is no longer in the repository. Nothing was saved, and your changes are kept." },
  head_moved: { status: 409, message: "The repository kept changing while this was being saved. Nothing was saved. Try again." },
  read_only: { status: 422, message: "That token can read this repository but not write to it, so nothing was saved. Create the token with the repository permission “Contents: Read and write”, and connect the repository again. Your changes are kept." },
  bad_token: { status: 422, message: "The git host did not accept this repository's token. Connect the repository again with a new one. Your changes are kept." },
  unavailable: { status: 502, message: "Could not reach the git host just now. Nothing was saved, and your changes are kept. Try again in a moment." },
};

const notFound = () => failure(404, "not_found", "There is no such connection.");
const tooLarge = () => failure(413, "too_large", `That is more than a note can be: at most ${MAX_CONTENT_BYTES / 1024 / 1024} MB of text.`);

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return undefined;
}

function fromResult(result: Extract<SaveOutcome, { found: true }>["result"]): Response {
  if (result.ok) {
    const { baseBlob, createdAt, lastEdit } = result.workingCopy;
    return json(200, { workingCopy: { baseBlob, createdAt, lastEdit } });
  }
  switch (result.reason) {
    case "base_mismatch":
      return failure(409, "base_mismatch", "This draft was started from another version of the file. Reload to see it.", { baseBlob: result.baseBlob });
    case "unstorable":
      return failure(422, "unstorable", `This text cannot be kept as a draft. ${result.message}`);
    case "too_many":
      return failure(422, "too_many_drafts", "There are too many unsaved drafts in this repository. Save or discard some first.");
    case "not_editable":
      return failure(422, "not_editable", "That file is not a note that can be edited here.");
    case "unavailable":
      return failure(502, "unavailable", "Could not read that repository just now. Try again in a moment.");
  }
}

/** What a person is told. An error we did not expect is logged by name, never by message, and answered plainly. */
function fromError(error: unknown): Response {
  if (isCredentialError(error, "no_key")) return failure(503, "not_configured", "This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.");
  if (isProviderError(error, "rate_limited")) return failure(429, "rate_limited", "The git host is limiting requests. Try again in a moment.");
  console.error(`[fjord] working copies: unexpected ${error instanceof Error ? error.name : "failure"}`);
  return failure(500, "internal_error", "Something went wrong on our side. Try again.");
}
