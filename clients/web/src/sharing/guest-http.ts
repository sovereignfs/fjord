import { isCredentialError } from "../crypto/errors";
import { isDocId } from "../browse/ids";
import { isProviderError } from "../providers/errors";
import { MAX_CONTENT_BYTES } from "../working/service";
import { MAX_NAME_CHARS, type GuestSave } from "./guest";
import { SHARE_COOKIE } from "./redact";

/**
 * The HTTP face of editing through a link (`PUT /doc/<id>/draft`, DESIGN.md §12, ROADMAP 1c.6). It is under `/doc/<id>` because that is the
 * path the link's cookie is scoped to (1c.4): the browser sends the cookie here and nowhere else of the app.
 *
 *  - **There is no session**: the caller is whoever holds the cookie, and what it lets them do is the link's, decided by the policy.
 *    A cookie that is absent, wrong, for another document, expired or revoked is a 404; a good one on a link that may not edit is a 403.
 *  - A write must come from this instance's own pages (`Origin`); what is sent is the body and the display name, nothing else.
 */
export interface Deps {
  save: (input: { cookie: string | undefined; docId: string; name: unknown; body: string }) => Promise<GuestSave>;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

const MAX_BODY_CHARS = MAX_CONTENT_BYTES + 4_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });

/** The share cookie's value out of a `Cookie` header. */
export function shareCookieOf(header: string | null): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === SHARE_COOKIE) return part.slice(at + 1).trim();
  }
  return undefined;
}

export async function handleGuestDraft(request: Request, deps: Deps, docId: string): Promise<Response> {
  if (request.method !== "PUT") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  if (!isDocId(docId)) return failure(404, "not_found", "There is no such document.");

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return failure(413, "too_large", "That text is too large.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return failure(400, "invalid_request", "Send a JSON object.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return failure(400, "invalid_request", "Send a JSON object.");
    const { name, body } = parsed as Record<string, unknown>;
    if (typeof body !== "string") return failure(400, "invalid_request", "Send the text as `body`.");

    const result = await deps.save({ cookie: shareCookieOf(request.headers.get("cookie")), docId, name, body });
    if (result.ok) return json(200, { savedAt: result.savedAt });
    switch (result.reason) {
      case "hidden":
        return failure(404, "not_found", "There is no such document.");
      case "forbidden":
        return failure(403, "read_only", "This link lets you read the document, not change it.");
      case "rate_limited": {
        const response = failure(429, "rate_limited", "Changes are coming in through this link faster than anyone types. Wait a moment, then carry on.");
        response.headers.set("retry-after", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
        return response;
      }
      case "bad_name":
        return failure(400, "bad_name", `Give a name of one line, up to ${MAX_NAME_CHARS} characters, without < or >.`);
      case "not_editable":
        return failure(422, "not_editable", "This document cannot be edited through a link.");
      case "unstorable":
        return failure(422, "unstorable", `This text cannot be kept as a draft. ${result.message}`);
      case "too_many_drafts":
        return failure(422, "too_many_drafts", "There are too many unsaved drafts in this repository. The owner needs to save or discard some.");
      case "too_many_editors":
        return failure(422, "too_many_editors", "This document has been edited by as many people as it keeps. The owner needs to save a version first.");
      case "unavailable":
        return failure(502, "unavailable", "Could not reach the document just now. Try again in a moment.");
    }
  } catch (error) {
    if (isCredentialError(error, "no_key")) return failure(503, "not_configured", "This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.");
    if (isProviderError(error, "rate_limited")) return failure(429, "rate_limited", "The git host is limiting requests. Try again in a moment.");
    console.error(`[fjord] guest draft: unexpected ${error instanceof Error ? error.name : "failure"}`);
    return failure(500, "internal_error", "Something went wrong on our side. Try again.");
  }
}
