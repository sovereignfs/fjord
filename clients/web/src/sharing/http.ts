import { isCredentialError } from "../crypto/errors";
import { isDocId } from "../browse/ids";
import { isProviderError } from "../providers/errors";
import { ROLES, type Role } from "../access/policy";
import { type Caller } from "../working/http";

/**
 * The HTTP face of sharing a document with named accounts (`/api/connections/<id>/shares`, DESIGN.md §12, ROADMAP 1c.2). Like
 * the other file routes, written against `Request` and `Response` and handed the caller, so the rules are tested directly.
 *
 *  - Only the owner of the connection shares (§12: "who can share: the owner, in phase 1"); another's is a 404, as if the
 *    connection were not there. Writes must come from this instance's own pages.
 *  - **Sharing with an address says the same whether or not it has an account.** Only existing accounts can be named, so for
 *    one that has none nothing is stored, and the answer is word for word the one for an account that was shared with: this
 *    route is no way to ask which addresses have accounts. (The owner's list, which names the accounts a document is shared
 *    with, is the owner's to read, as the design allows; it is not a lookup of anything they did not themselves share with.)
 *  - Only a document is shared: a note, or something that is not in the repository, is refused whatever the address.
 */
export interface Deps {
  /** Share the document of a connection with the account at this address, if there is one. */
  share: (accountId: string, id: number, input: { docId: string; email: string; role: Role }) => Promise<{ found: false } | { found: true; result: ShareResult }>;
  /** Who a document is shared with. */
  list: (accountId: string, id: number, docId: string) => Promise<{ found: false } | { found: true; result: ListResult }>;
  /** Stop sharing a document with an account. */
  unshare: (accountId: string, id: number, input: { docId: string; accountId: string }) => Promise<{ found: false } | { found: true; result: { ok: true; removed: boolean } | { ok: false; reason: "unavailable" } }>;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

export type ShareResult = { ok: true } | { ok: false; reason: "not_a_document" | "gone" | "too_many" | "unavailable" };
export type ListResult = { ok: true; shares: { accountId: string; name: string; email: string; role: Role }[] } | { ok: false; reason: "not_a_document" | "gone" | "unavailable" };

const MAX_BODY_CHARS = 2_000;
const MAX_EMAIL_CHARS = 254;
const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f\s]/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const notFound = () => failure(404, "not_found", "There is no such connection.");

/** What is told of a share that took, or would have: the same for an address with an account and one with none. */
export const SHARED = { status: "ok", message: "If that address has an account here, the document is now shared with it." } as const;

const REFUSALS = {
  not_a_document: { status: 422, message: "Only documents (*.fj.md) can be shared, not notes." },
  gone: { status: 404, message: "That document is not in this repository." },
  too_many: { status: 422, message: "A document can be shared with at most 100 accounts. Stop sharing with one first." },
  unavailable: { status: 502, message: "Could not reach the git host just now. Nothing was changed. Try again in a moment." },
} as const;

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return undefined;
}

/** An address as typed: one line, no spaces, one `@` with something either side. It is compared whole, never as a pattern. */
function isEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const email = value.trim();
  if (email.length < 3 || email.length > MAX_EMAIL_CHARS || CONTROL.test(email) || !email.isWellFormed()) return false;
  const at = email.indexOf("@");
  return at > 0 && at === email.lastIndexOf("@") && at < email.length - 1;
}

/** `GET ?doc=<id>` lists who it is shared with; `POST { doc, email, role }` shares it; `DELETE { doc, accountId }` stops. */
export async function handleShares(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "POST" && method !== "DELETE") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (method !== "GET" && request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (method === "GET") {
      const docId = new URL(request.url).searchParams.get("doc");
      if (docId === null || !isDocId(docId)) return failure(400, "invalid_request", "Say which document, by its id.");
      const outcome = await deps.list(caller.accountId, number, docId);
      if (!outcome.found) return notFound();
      if (!outcome.result.ok) return failure(REFUSALS[outcome.result.reason].status, outcome.result.reason, REFUSALS[outcome.result.reason].message);
      return json(200, { shares: outcome.result.shares });
    }

    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
    const body = parse(text);
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");
    if (typeof body.doc !== "string" || !isDocId(body.doc)) return failure(400, "invalid_request", "Say which document, by its id.");

    if (method === "POST") {
      if (!isEmail(body.email)) return failure(400, "invalid_request", "Say who to share with, by their email address.");
      if (typeof body.role !== "string" || !ROLES.includes(body.role as Role)) return failure(400, "invalid_request", "Say what they may do: view, comment or edit.");
      const outcome = await deps.share(caller.accountId, number, { docId: body.doc, email: body.email.trim(), role: body.role as Role });
      if (!outcome.found) return notFound();
      if (!outcome.result.ok) return failure(REFUSALS[outcome.result.reason].status, outcome.result.reason, REFUSALS[outcome.result.reason].message);
      return json(200, SHARED);
    }

    if (typeof body.accountId !== "string" || !ACCOUNT_ID.test(body.accountId)) return failure(400, "invalid_request", "Say which account to stop sharing with.");
    const outcome = await deps.unshare(caller.accountId, number, { docId: body.doc, accountId: body.accountId });
    if (!outcome.found) return notFound();
    if (!outcome.result.ok) return failure(REFUSALS.unavailable.status, "unavailable", REFUSALS.unavailable.message);
    return json(200, { removed: outcome.result.removed });
  } catch (error) {
    if (isCredentialError(error, "no_key")) return failure(503, "not_configured", "This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.");
    if (isProviderError(error, "rate_limited")) return failure(429, "rate_limited", "The git host is limiting requests. Try again in a moment.");
    console.error(`[fjord] shares: unexpected ${error instanceof Error ? error.name : "failure"}`);
    return failure(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}
