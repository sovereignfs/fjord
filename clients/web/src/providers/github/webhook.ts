import { createHmac, timingSafeEqual } from "node:crypto";
import { ProviderError } from "../errors";
import type { WebhookEvent, WebhookRequest } from "../types";

/** A header by name, from either a `Headers` or a plain object. */
function header(headers: WebhookRequest["headers"], name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

/**
 * Trust a GitHub webhook only if it is signed with the shared secret: `X-Hub-Signature-256` is
 * `sha256=` and the HMAC-SHA256 of the body's exact bytes. Compared in constant time, so the
 * answer does not leak how much of a forged signature was right. Anything else is refused before
 * its contents are read.
 */
export function verifyGitHubWebhook(request: WebhookRequest, secret: string): WebhookEvent {
  if (!secret) throw new ProviderError("invalid_webhook", "there is no webhook secret to check against");
  const body = typeof request.body === "string" ? Buffer.from(request.body, "utf8") : Buffer.from(request.body);

  const given = header(request.headers, "x-hub-signature-256") ?? "";
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ProviderError("invalid_webhook", "the webhook signature does not match");

  const event = header(request.headers, "x-github-event") ?? "";
  if (event === "ping") return { kind: "ping" };
  if (event !== "push" && event !== "installation" && event !== "installation_repositories") return { kind: "ignored", event };

  let payload: {
    ref?: unknown;
    before?: unknown;
    after?: unknown;
    deleted?: unknown;
    repository?: { full_name?: unknown };
    action?: unknown;
    repositories?: unknown;
    repositories_removed?: unknown;
  };
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ProviderError("invalid_webhook", "the webhook body is not JSON");
  }
  if (event !== "push") {
    // Only the two that take access away: an installation deleted, and repositories removed from one.
    const listed = event === "installation" ? (payload.action === "deleted" ? payload.repositories : undefined) : payload.action === "removed" ? payload.repositories_removed : undefined;
    if (!Array.isArray(listed)) return { kind: "ignored", event: `${event} ${typeof payload.action === "string" ? payload.action : ""}`.trim() };
    return { kind: "access_removed", repositories: listed.flatMap(repositoryOf) };
  }
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  const fullName = typeof payload.repository?.full_name === "string" ? payload.repository.full_name : "";
  const [owner, name, ...rest] = fullName.split("/");
  if (!ref.startsWith("refs/heads/") || !owner || !name || rest.length > 0) return { kind: "ignored", event: `push to ${ref || "something that is not a branch"}` };

  return {
    kind: "push",
    repository: { owner, name },
    branch: ref.slice("refs/heads/".length),
    before: String(payload.before ?? ""),
    after: String(payload.after ?? ""),
    deleted: payload.deleted === true,
  };
}

/** A repository as an `installation` payload lists it: by `full_name`, `owner/name`. Anything else is not one. */
function repositoryOf(entry: unknown): { owner: string; name: string }[] {
  const fullName = typeof (entry as { full_name?: unknown } | null)?.full_name === "string" ? (entry as { full_name: string }).full_name : "";
  const [owner, name, ...rest] = fullName.split("/");
  return owner && name && rest.length === 0 ? [{ owner, name }] : [];
}
