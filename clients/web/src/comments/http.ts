import { isCredentialError } from "../crypto/errors";
import { isDocId } from "../browse/ids";
import { isProviderError } from "../providers/errors";
import { shareCookieOf } from "../sharing/guest-http";
import { type Operation, type Outcome } from "./access";
import { cleanAnchor } from "./service";

/**
 * The HTTP face of a document's comments (`/doc/<id>/comments`, DESIGN.md §13, ROADMAP 1d.1). It is under `/doc/<id>` because that is the path a
 * link's cookie is sent to (1c.4); a signed-in person's session cookie goes everywhere. Like the other routes, written against `Request` and
 * `Response` and handed the caller, so the rules are tested directly.
 *
 *  - **The caller is a session, a link's cookie, or both**; which of them lets what in is the policy's (`access.ts`). Nobody is signed in necessarily.
 *  - A write must come from this instance's own pages (`Origin`). What is sent is a place and a text; who wrote it is never sent, but found:
 *    an account is itself, and someone with a link is a guest by the name they give and the id their browser made up.
 *  - `GET` lists; `POST` makes a thread (`op: "thread"`) or a reply (`"reply"`); `PATCH` resolves or opens a thread (`"resolve"`), edits a
 *    comment of one's own (`"edit"`) or closes or opens the document's comments (`"close"`, the owner's); `DELETE` deletes one.
 */
export interface Deps {
  run: (input: { docId: string; account: { id: string; name: string } | undefined; cookie: string | undefined; claimed: { name?: unknown; clientId?: unknown }; operation: Operation }) => Promise<Outcome>;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

export interface Caller {
  accountId: string;
  name: string;
}

const MAX_BODY_CHARS = 20_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });

const REFUSALS = {
  hidden: { status: 404, code: "not_found", message: "There is no such document." },
  forbidden: { status: 403, code: "forbidden", message: "You may not do that to this document's comments." },
  need_name: { status: 400, code: "need_name", message: "Give a name first, and the id your browser keeps, so that your comments can be told from others'." },
  closed: { status: 409, code: "closed", message: "Comments on this document are closed." },
  not_found: { status: 404, code: "no_such_comment", message: "There is no such comment." },
  too_many: { status: 422, code: "too_many", message: "There are as many comments there as there can be." },
  bad_comment: { status: 400, code: "bad_comment", message: "A comment is text of one to 4000 characters." },
} as const;

const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isKind = (value: unknown): value is "thread" | "reply" => value === "thread" || value === "reply";

function parseBody(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return undefined;
}

export async function handleComments(request: Request, caller: Caller | null, deps: Deps, docId: string): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "POST" && method !== "PATCH" && method !== "DELETE") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (method !== "GET" && request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  if (!isDocId(docId)) return failure(404, "not_found", "There is no such document.");
  const account = caller ? { id: caller.accountId, name: caller.name } : undefined;
  const cookie = shareCookieOf(request.headers.get("cookie"));

  try {
    if (method === "GET") {
      const url = new URL(request.url);
      const outcome = await deps.run({ docId, account, cookie, claimed: { name: url.searchParams.get("name") ?? undefined, clientId: url.searchParams.get("client") ?? undefined }, operation: { op: "list" } });
      if (!outcome.ok) return refusal(outcome.reason);
      return json(200, { threads: outcome.threads, closed: outcome.closed, viewer: outcome.viewer });
    }

    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
    const body = parseBody(text);
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");
    const operation = operationOf(method, body);
    if (!operation) return failure(400, "invalid_request", "Say what to do, and to which comment.");

    const outcome = await deps.run({ docId, account, cookie, claimed: { name: body.name, clientId: body.clientId }, operation });
    if (!outcome.ok) return refusal(outcome.reason);
    return json(method === "POST" ? 201 : 200, outcome.id === undefined ? { ok: true } : { ok: true, id: outcome.id });
  } catch (error) {
    if (isCredentialError(error, "no_key")) return failure(503, "not_configured", "This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.");
    if (isProviderError(error, "rate_limited")) return failure(429, "rate_limited", "The git host is limiting requests. Try again in a moment.");
    console.error(`[fjord] comments: unexpected ${error instanceof Error ? error.name : "failure"}`);
    return failure(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}

function refusal(reason: Extract<Outcome, { ok: false }>["reason"]): Response {
  const { status, code, message } = REFUSALS[reason];
  return failure(status, code, message);
}

/** What the request asks, or undefined if it asks nothing that makes sense for its method. */
function operationOf(method: string, body: Record<string, unknown>): Operation | undefined {
  if (method === "POST") {
    if (body.op === "thread") {
      const anchor = cleanAnchor(body.anchor);
      return anchor && typeof body.body === "string" ? { op: "thread", anchor, body: body.body } : undefined;
    }
    if (body.op === "reply") return isId(body.thread) && typeof body.body === "string" ? { op: "reply", thread: body.thread, body: body.body } : undefined;
    return undefined;
  }
  if (method === "PATCH") {
    if (body.op === "resolve") return isId(body.thread) && typeof body.resolved === "boolean" ? { op: "resolve", thread: body.thread, resolved: body.resolved } : undefined;
    if (body.op === "edit") return isKind(body.kind) && isId(body.id) && typeof body.body === "string" ? { op: "edit", target: { kind: body.kind, id: body.id }, body: body.body } : undefined;
    if (body.op === "close") return typeof body.closed === "boolean" ? { op: "close", closed: body.closed } : undefined;
    return undefined;
  }
  return isKind(body.kind) && isId(body.id) ? { op: "delete", target: { kind: body.kind, id: body.id } } : undefined;
}
