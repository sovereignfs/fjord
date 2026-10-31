import { isCredentialError } from "../crypto/errors";
import { isProviderError } from "../providers/errors";
import { isRepositoryPath } from "../working/http";

/**
 * `GET /api/connections/<id>/ciphertext?path=…` (ROADMAP 2b.2): the bytes of one **encrypted** file of one of the caller's repositories, exactly as they are
 * stored, so that the browser can decrypt them with the identity it keeps. The server never decrypts, has no key to, and is not told which identity opens
 * the file: it hands over what the repository already shows to whoever can read the repository.
 *
 *  - Nobody who is not signed in: 401. An account reads its own connections only: another's is 404, as if it were not there.
 *  - Only a file that is an encrypted payload of an encrypted vault is handed over. A note in a plaintext vault is not this route's (404): it is read the
 *    way the page reads it, and a route that gave out any blob would be a second way to read the repository.
 *  - The answer is the file and nothing else: `application/octet-stream`, `no-store`, and no name.
 */
export interface Deps {
  /**
   * The ciphertext of the file at this repository path. `found: false` if the connection is not the caller's (or not there); otherwise the bytes, or
   * why there are none.
   */
  read: (accountId: string, id: number, path: string) => Promise<{ found: false } | { found: true; result: { ok: true; bytes: Uint8Array } | { ok: false; reason: Refusal } }>;
}

export type Refusal = "not_encrypted" | "too_large" | "bad_token" | "unavailable";

export interface Caller {
  accountId: string;
}

/** An encrypted document is small; this is more than any is meant to be (W604 warns at 25 MB), and bounds what one request holds. */
export const MAX_CIPHERTEXT_BYTES = 25 * 1024 * 1024;

const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const notFound = () => failure(404, "not_found", "There is no such file.");

const REFUSALS: Record<Refusal, { status: number; message: string }> = {
  not_encrypted: { status: 404, message: "There is no such file." },
  too_large: { status: 413, message: "That file is larger than an encrypted document is meant to be." },
  bad_token: { status: 422, message: "The git host did not accept this repository's credentials. Connect the repository again." },
  unavailable: { status: 502, message: "Could not reach the git host just now. Try again in a moment." },
};

export async function handleCiphertext(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "GET") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();
  const path = new URL(request.url).searchParams.get("path");
  if (!isRepositoryPath(path)) return failure(400, "invalid_request", "Say which file, by its path in the repository.");

  try {
    const outcome = await deps.read(caller.accountId, number, path);
    if (!outcome.found) return notFound();
    if (!outcome.result.ok) {
      const refusal = REFUSALS[outcome.result.reason];
      return failure(refusal.status, outcome.result.reason === "not_encrypted" ? "not_found" : outcome.result.reason, refusal.message);
    }
    return new Response(outcome.result.bytes as BodyInit, {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": String(outcome.result.bytes.byteLength), "cache-control": "no-store" },
    });
  } catch (error) {
    if (isCredentialError(error, "no_key")) return failure(503, "not_configured", "This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.");
    if (isProviderError(error, "rate_limited")) return failure(429, "rate_limited", "The git host is limiting requests. Try again in a moment.");
    console.error(`[fjord] ciphertext: unexpected ${error instanceof Error ? error.name : "failure"}`);
    return failure(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}
