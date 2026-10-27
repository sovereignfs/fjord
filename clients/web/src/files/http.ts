import { isCredentialError } from "../crypto/errors";
import type { LocalMinute } from "../format/types";
import { isProviderError } from "../providers/errors";
import type { Identity } from "../providers/types";
import { type Caller, isRepositoryPath } from "../working/http";
import type { CreateResult, FileKind, VaultRefusal } from "./create";
import { MAX_TITLE_CHARS } from "./create";

/**
 * The HTTP face of making files (`/api/connections/<id>/files`): who may call, what they may send, what they are told.
 * Like `src/working/http.ts`, written against `Request` and `Response` and handed the caller, so the rules are tested
 * directly and the route file is only the glue that finds the session.
 *
 *  - Nobody who is not signed in: 401, before anything is read.
 *  - A write must come from this instance's own pages: its `Origin` is checked against `FJORD_URL`.
 *  - An account makes files in its own connections only: another's is 404, as if it were not there.
 *  - What is sent is a place and a title, never a name or a text: the name and the header are `fjord-core`'s.
 */
export interface Deps {
  /**
   * Make a file in one of the caller's repositories. `found: false` if it is not the caller's (or not there). `author` is
   * the caller as their account names them.
   */
  create: (
    accountId: string,
    id: number,
    input: { vault: string; folder: string; kind: FileKind; title: string; localMinute: LocalMinute; author: Identity },
  ) => Promise<{ found: false } | { found: true; result: CreateResult | { ok: false; reason: VaultRefusal } }>;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

const MAX_BODY_CHARS = 8_000;
const MAX_VAULT_CHARS = 255;
const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const notFound = () => failure(404, "not_found", "There is no such connection.");

/** `POST` makes a note or a document, `{ vault, folder, kind, title?, localMinute }`: one commit that adds one file. */
export async function handleCreate(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
    const body = parse(text);
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");

    const { vault, folder, kind, title, localMinute } = body;
    if (typeof vault !== "string" || vault.length > MAX_VAULT_CHARS || vault.includes("/") || !isRepositoryPath(vault)) return failure(400, "invalid_request", "Say which vault, by its directory.");
    if (typeof folder !== "string" || (folder !== "" && !isRepositoryPath(folder))) return failure(400, "invalid_request", "Say which folder of the vault, by its path, or \"\" for its top.");
    if (kind !== "note" && kind !== "document") return failure(400, "invalid_request", "Say whether to make a note or a document.");
    if (title !== undefined && title !== null && (typeof title !== "string" || title.length > MAX_TITLE_CHARS || CONTROL.test(title) || !title.isWellFormed())) {
      return failure(400, "invalid_request", `Send the title as one line of at most ${MAX_TITLE_CHARS} characters, or leave it out.`);
    }
    const minute = readMinute(localMinute);
    if (!minute) return failure(400, "invalid_request", "Send the local date and time as whole numbers: year, month, day, hour and minute.");

    const outcome = await deps.create(caller.accountId, number, {
      vault,
      folder,
      kind,
      title: typeof title === "string" ? title : "",
      localMinute: minute,
      author: { name: caller.name, email: caller.email },
    });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(201, { path: result.path, commit: result.commit });
    const refusal = REFUSALS[result.reason];
    return failure(refusal.status, result.reason, refusal.message);
  } catch (error) {
    return fromError(error);
  }
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return undefined;
}

/** The writer's own local time, which a note with nothing to name it by is named after: real-looking whole numbers. */
function readMinute(value: unknown): LocalMinute | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { year, month, day, hour, minute } = value as Record<string, unknown>;
  const within = (n: unknown, low: number, high: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= low && n <= high;
  if (!within(year, 2000, 2200) || !within(month, 1, 12) || !within(day, 1, 31) || !within(hour, 0, 23) || !within(minute, 0, 59)) return undefined;
  return { year, month, day, hour, minute };
}

/** What each reason nothing was made is told as. Nothing was written, in each. */
const REFUSALS: Record<Extract<CreateResult, { ok: false }>["reason"] | VaultRefusal, { status: number; message: string }> = {
  unknown_vault: { status: 422, message: "This repository has no such vault." },
  encrypted_vault: { status: 422, message: "Files cannot be made in an encrypted vault in this version." },
  unsupported_vault: { status: 422, message: "This vault's manifest cannot be read, or it does not use plain file names, so files cannot be made in it from here." },
  folder_gone: { status: 409, message: "That folder is no longer in the repository. Nothing was made." },
  bad_title: { status: 422, message: "A document needs a title with some letters or digits in it to name its file by." },
  head_moved: { status: 409, message: "The repository kept changing while this was being made. Nothing was made. Try again." },
  read_only: { status: 422, message: "That token can read this repository but not write to it, so nothing was made. Create the token with the repository permission “Contents: Read and write”, and connect the repository again." },
  bad_token: { status: 422, message: "The git host did not accept this repository's token. Connect the repository again with a new one." },
  unavailable: { status: 502, message: "Could not reach the git host just now. Nothing was made. Try again in a moment." },
};

/** What a person is told. An error we did not expect is logged by name, never by message, and answered plainly. */
function fromError(error: unknown): Response {
  if (isCredentialError(error, "no_key")) return failure(503, "not_configured", "This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.");
  if (isProviderError(error, "rate_limited")) return failure(429, "rate_limited", "The git host is limiting requests. Try again in a moment.");
  console.error(`[fjord] files: unexpected ${error instanceof Error ? error.name : "failure"}`);
  return failure(500, "internal_error", "Something went wrong on our side. Try again.");
}
