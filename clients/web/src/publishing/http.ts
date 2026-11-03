import { isDocId } from "../browse/ids";
import { type Caller } from "../working/http";

/**
 * The HTTP face of publishing a Doc as a page (`/api/connections/<id>/publication`, DESIGN.md §12, ROADMAP 3h.1), written against `Request` and `Response` and handed
 * the caller, so the rules are tested directly.
 *
 *  - Only the owner of the connection publishes, looks and unpublishes; another's connection is a 404. Writes must come from this instance's own pages.
 *  - Only a Doc of a plaintext vault can be published; an id the repository does not have is refused.
 *  - **The address is in the answer to publishing, once.** Only a hash of the token is kept, so no other answer carries it; publishing again makes a new address.
 */
export interface Deps {
  publish: (accountId: string, id: number, docId: string) => Promise<{ found: false } | { found: true; result: { ok: true; token: string } | { ok: false; reason: "gone" | "unavailable" } }>;
  status: (accountId: string, id: number, docId: string) => Promise<{ found: false } | { found: true; publishedAt: number | null }>;
  unpublish: (accountId: string, id: number, docId: string) => Promise<{ found: false } | { found: true; unpublished: boolean }>;
  /** The instance's origin, `FJORD_URL`: what an address is made on. */
  origin: string;
}

const MAX_BODY_CHARS = 200;
const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const notFound = () => failure(404, "not_found", "There is no such connection.");

const REFUSALS = {
  gone: { status: 404, message: "That document is not in this repository, or is in an encrypted vault, which is not published from here." },
  unavailable: { status: 502, message: "Could not reach the git host just now. Nothing was changed. Try again in a moment." },
} as const;

/** The address a page is opened at. */
export const pageUrl = (origin: string, token: string): string => `${origin.replace(/\/+$/, "")}/p/${token}`;

/** `GET ?doc=<id>` says whether a Doc is published; `POST { doc }` publishes it; `DELETE { doc }` ends its address. */
export async function handlePublication(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "POST" && method !== "DELETE") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (method !== "GET" && request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  if (method === "GET") {
    const docId = new URL(request.url).searchParams.get("doc");
    if (docId === null || !isDocId(docId)) return failure(400, "invalid_request", "Say which document, by its id.");
    const outcome = await deps.status(caller.accountId, number, docId);
    return outcome.found ? json(200, { published: outcome.publishedAt !== null, publishedAt: outcome.publishedAt }) : notFound();
  }

  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failure(400, "invalid_request", "Send a JSON object.");
  }
  const docId = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).doc : undefined;
  if (typeof docId !== "string" || !isDocId(docId)) return failure(400, "invalid_request", "Say which document, by its id.");

  if (method === "POST") {
    const outcome = await deps.publish(caller.accountId, number, docId);
    if (!outcome.found) return notFound();
    if (!outcome.result.ok) {
      const refusal = REFUSALS[outcome.result.reason];
      return failure(refusal.status, outcome.result.reason, refusal.message);
    }
    return json(201, { token: outcome.result.token, url: pageUrl(deps.origin, outcome.result.token) });
  }
  const outcome = await deps.unpublish(caller.accountId, number, docId);
  return outcome.found ? json(200, { unpublished: outcome.unpublished }) : notFound();
}
