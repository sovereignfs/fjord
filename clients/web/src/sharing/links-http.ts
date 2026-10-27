import { isCredentialError } from "../crypto/errors";
import { isDocId } from "../browse/ids";
import { isProviderError } from "../providers/errors";
import { ROLES, type Role } from "../access/policy";
import { type Caller } from "../working/http";

/**
 * The HTTP face of share links (`/api/connections/<id>/links`, DESIGN.md §12, ROADMAP 1c.3). Like the other file routes,
 * written against `Request` and `Response` and handed the caller, so the rules are tested directly.
 *
 *  - Only the owner of the connection makes, lists and revokes links (§12: "who can share: the owner, in phase 1"); another's
 *    connection is a 404. Writes must come from this instance's own pages.
 *  - Only a document has links: a note, or an id the repository does not have, is refused.
 *  - **The token is in the answer to making the link, once.** It is never stored, so it is never in a list, and no other
 *    answer carries it. What is sent is a role and an optional expiry in the future; the token is the server's to make.
 */
export interface Deps {
  create: (accountId: string, id: number, input: { docId: string; role: Role; expiresAt: number | null }) => Promise<{ found: false } | { found: true; result: CreateResult }>;
  list: (accountId: string, id: number, docId: string) => Promise<{ found: false } | { found: true; links: LinkSummary[] }>;
  revoke: (accountId: string, id: number, input: { docId: string; linkId: number }) => Promise<{ found: false } | { found: true; revoked: boolean }>;
  /** The instance's origin, `FJORD_URL`: what a link's address is made on. */
  origin: string;
  /** For tests. */
  now?: () => number;
}

export type CreateResult = { ok: true; id: number; token: string } | { ok: false; reason: "not_a_document" | "gone" | "too_many" | "unavailable" };

export interface LinkSummary {
  id: number;
  role: Role;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  status: "active" | "expired" | "revoked";
}

const MAX_BODY_CHARS = 1_000;
const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;
/** A link may be set to last this long at most. */
export const MAX_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const notFound = () => failure(404, "not_found", "There is no such connection.");

const REFUSALS = {
  not_a_document: { status: 422, message: "Only documents (*.fj.md) can be shared by link, not notes." },
  gone: { status: 404, message: "That document is not in this repository." },
  too_many: { status: 422, message: "A document can have at most 50 links. Revoke one, or look at the ones it has." },
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

/** The address a link is opened at: the document's own, with the token. */
export const linkUrl = (origin: string, docId: string, token: string): string => `${origin.replace(/\/+$/, "")}/doc/${docId}?token=${token}`;

/** `GET ?doc=<id>` lists a document's links; `POST { doc, role, expiresAt? }` makes one; `DELETE { doc, linkId }` revokes one. */
export async function handleLinks(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "POST" && method !== "DELETE") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (method !== "GET" && request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();
  const now = deps.now?.() ?? Date.now();

  try {
    if (method === "GET") {
      const docId = new URL(request.url).searchParams.get("doc");
      if (docId === null || !isDocId(docId)) return failure(400, "invalid_request", "Say which document, by its id.");
      const outcome = await deps.list(caller.accountId, number, docId);
      return outcome.found ? json(200, { links: outcome.links }) : notFound();
    }

    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
    const body = parse(text);
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");
    if (typeof body.doc !== "string" || !isDocId(body.doc)) return failure(400, "invalid_request", "Say which document, by its id.");

    if (method === "POST") {
      if (typeof body.role !== "string" || !ROLES.includes(body.role as Role)) return failure(400, "invalid_request", "Say what the link allows: view, comment or edit.");
      const expiry = body.expiresAt;
      if (expiry !== undefined && expiry !== null && (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry <= now || expiry > now + MAX_EXPIRY_MS)) {
        return failure(400, "invalid_request", "Say when the link stops working as a time in the future (milliseconds since 1970), or leave it out.");
      }
      const outcome = await deps.create(caller.accountId, number, { docId: body.doc, role: body.role as Role, expiresAt: typeof expiry === "number" ? expiry : null });
      if (!outcome.found) return notFound();
      if (!outcome.result.ok) return failure(REFUSALS[outcome.result.reason].status, outcome.result.reason, REFUSALS[outcome.result.reason].message);
      return json(201, { id: outcome.result.id, token: outcome.result.token, url: linkUrl(deps.origin, body.doc, outcome.result.token) });
    }

    if (typeof body.linkId !== "number" || !Number.isSafeInteger(body.linkId) || body.linkId < 1) return failure(400, "invalid_request", "Say which link, by its number.");
    const outcome = await deps.revoke(caller.accountId, number, { docId: body.doc, linkId: body.linkId });
    return outcome.found ? json(200, { revoked: outcome.revoked }) : notFound();
  } catch (error) {
    if (isCredentialError(error, "no_key")) return failure(503, "not_configured", "This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.");
    if (isProviderError(error, "rate_limited")) return failure(429, "rate_limited", "The git host is limiting requests. Try again in a moment.");
    console.error(`[fjord] links: unexpected ${error instanceof Error ? error.name : "failure"}`);
    return failure(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}
