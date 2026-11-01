import { isCredentialError } from "../crypto/errors";
import { isProviderError } from "../providers/errors";
import { MAX_CIPHERTEXT_BYTES, fromBase64, whyNotCiphertext } from "../working/ciphertext";
import { isRepositoryPath } from "../working/http";
import { type CreateResult, MODES, type SealedCopy, type SealedMode, type SealedRecord } from "./service";

/**
 * The HTTP face of sealed shares (ROADMAP 2c.1, DESIGN.md §12). Two sides:
 *
 *  - **The owner's** `/api/connections/<id>/sealed-shares`: list a file's shares (`GET ?path=`), make one (`POST { path, mode, ciphertext }`: the sharer's browser sealed the copy,
 *    and the answer holds the link's token, once) and revoke one (`DELETE ?share=`, which deletes the copy). Signed in, this site's `Origin` for a write, the account's own
 *    connections only (another's is 404). A copy is made only for an encrypted file of an encrypted vault, and only as an age file: plain text is refused, so none is kept here.
 *  - **The link's** `GET /api/sealed/<token>`: no session; the token is the way in. It answers with the copy and how it is sealed, and nothing else. A token that is not one,
 *    is wrong, or was revoked is the same 404. The server has no key and is not given the one in the link's fragment.
 */
export interface ManageDeps {
  list: (accountId: string, id: number, path: string) => Promise<{ found: false } | { found: true; shares: SealedRecord[] }>;
  create: (accountId: string, id: number, input: { path: string; mode: SealedMode; ciphertext: string }) => Promise<{ found: false } | { found: true; result: CreateResult | { ok: false; reason: "not_encrypted" | "unavailable" } }>;
  revoke: (accountId: string, id: number, shareId: number) => Promise<{ found: false } | { found: true; revoked: boolean }>;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

export interface OpenDeps {
  read: (token: string) => Promise<SealedCopy | undefined>;
}

export interface Caller {
  accountId: string;
  /** For the record of who made a share. */
  userId: string;
}

const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;
const SHARE_ID = /^[1-9][0-9]{0,15}$/;
/** The base64 of the largest copy there can be, and room for the rest of the body. */
const MAX_BODY_CHARS = Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3) + 8_000;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const notFound = () => failure(404, "not_found", "There is no such connection.");

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return undefined;
}

const view = (record: SealedRecord) => ({ id: record.id, mode: record.mode, createdAt: record.createdAt });

export async function handleSealedShares(request: Request, caller: Caller | null, deps: ManageDeps, id: string): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "POST" && method !== "DELETE") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (method !== "GET" && request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();
  const url = new URL(request.url);

  try {
    if (method === "GET") {
      const path = url.searchParams.get("path");
      if (!isRepositoryPath(path)) return failure(400, "invalid_request", "Say which file, by its path in the repository.");
      const found = await deps.list(caller.accountId, number, path);
      return found.found ? json(200, { shares: found.shares.map(view) }) : notFound();
    }

    if (method === "DELETE") {
      const share = url.searchParams.get("share");
      if (share === null || !SHARE_ID.test(share)) return failure(400, "invalid_request", "Say which share, by its number.");
      const done = await deps.revoke(caller.accountId, number, Number(share));
      if (!done.found) return notFound();
      return done.revoked ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : failure(404, "not_found", "There is no such share.");
    }

    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
    const body = parse(text);
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");
    const { path, mode, ciphertext } = body;
    if (!isRepositoryPath(path)) return failure(400, "invalid_request", "Say which file, by its path in the repository.");
    if (typeof mode !== "string" || !MODES.includes(mode as SealedMode)) return failure(400, "invalid_request", "Say how the copy is sealed: with a key in the link, or with a password.");
    if (typeof ciphertext !== "string") return failure(400, "invalid_request", "Send the sealed copy as base64 text.");
    // Only an age file is kept, so that no plain text is, whatever the page sent.
    const why = whyNotCiphertext(ciphertext);
    const bytes = why === undefined ? fromBase64(ciphertext) : undefined;
    if (bytes === undefined || bytes.length > MAX_CIPHERTEXT_BYTES) return failure(422, "not_ciphertext", `${why ?? "It is larger than a document can be."} Only a sealed copy is kept for a share.`);

    const made = await deps.create(caller.accountId, number, { path, mode: mode as SealedMode, ciphertext });
    if (!made.found) return notFound();
    const { result } = made;
    if (result.ok) return json(201, { token: result.token, share: view(result.record) });
    const refusal = CREATE_REFUSALS[result.reason];
    return failure(refusal.status, result.reason, refusal.message);
  } catch (error) {
    return fromError(error);
  }
}

const CREATE_REFUSALS = {
  not_encrypted: { status: 422, message: "Only an encrypted file is shared this way. A document in a plaintext vault is shared the ordinary way." },
  too_many_for_file: { status: 422, message: "This file has as many sealed shares as it can. Revoke one first." },
  too_many: { status: 422, message: "This repository has as many sealed shares as it can. Revoke some first." },
  unavailable: { status: 502, message: "Could not read that repository just now. Try again in a moment." },
} as const;

/** `GET /api/sealed/<token>`: the sealed copy a link opens. No session; no cookie is set or needed; the answer is never kept. */
export async function handleSealedOpen(request: Request, deps: OpenDeps, token: string): Promise<Response> {
  if (request.method !== "GET") return failure(405, "method_not_allowed", "That method is not allowed here.");
  try {
    const copy = await deps.read(token);
    if (!copy) return failure(404, "not_found", "This link does not work. It may have been revoked.");
    return json(200, { mode: copy.mode, ciphertext: copy.ciphertext, createdAt: copy.createdAt });
  } catch {
    // Logged by nothing: the message could carry the token's hash or the copy.
    console.error("[fjord] sealed shares: unexpected failure opening a link");
    return failure(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}

function fromError(error: unknown): Response {
  if (isCredentialError(error, "no_key")) return failure(503, "not_configured", "This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.");
  if (isProviderError(error, "rate_limited")) return failure(429, "rate_limited", "The git host is limiting requests. Try again in a moment.");
  console.error(`[fjord] sealed shares: unexpected ${error instanceof Error ? error.name : "failure"}`);
  return failure(500, "internal_error", "Something went wrong on our side. Try again.");
}
