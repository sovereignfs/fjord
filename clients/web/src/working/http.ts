import { safeSegments } from "../browse/location";
import { isCredentialError } from "../crypto/errors";
import { isProviderError } from "../providers/errors";
import { MAX_CONTENT_BYTES, type SaveResult } from "./service";

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
}

export type SaveOutcome =
  | { found: false }
  | { found: true; result: SaveResult | { ok: false; reason: "not_editable" } | { ok: false; reason: "unavailable" } };

export interface Deps {
  /** Keep a draft of one of the caller's repositories. `found: false` if it is not the caller's (or not there). */
  save: (accountId: string, id: number, input: { path: string; baseBlob: string; content: string }) => Promise<SaveOutcome>;
  /** Throw a draft away. `found: false` if the repository is not the caller's. Throwing away what is not there is not an error. */
  discard: (accountId: string, id: number, path: string) => Promise<{ found: boolean }>;
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
