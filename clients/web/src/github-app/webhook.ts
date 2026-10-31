import { isProviderError } from "../providers/errors";
import type { RepositoryRef } from "../providers/types";
import { verifyGitHubWebhook } from "../providers/github/webhook";

/**
 * `POST /api/webhooks/github` (ROADMAP 1a.6): GitHub says a branch moved. Whoever sends it is not signed in, so the only thing that
 * lets a request in is its signature, `X-Hub-Signature-256`, made with the App's webhook secret over the body's exact bytes; a
 * request without a right one is refused before its contents are read, and before the database is touched. A push is then the
 * reason to forget the trees kept for the repository (`ConnectionService.pushed`).
 */
export interface WebhookDeps {
  /** The App's webhook secret; undefined when this instance has no App (404). */
  secret: string | undefined;
  pushed: (ref: RepositoryRef, branch: string) => Promise<number>;
}

/** GitHub sends up to 25 MB for a very large push; this is more than the part that is read needs, and bounds what is held. */
export const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleGitHubWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (!deps.secret) return new Response(null, { status: 404 });
  if (request.method !== "POST") return json(405, { error: { code: "method_not_allowed" } });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return json(413, { error: { code: "too_large" } });

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_WEBHOOK_BYTES) return json(413, { error: { code: "too_large" } });

  try {
    const event = verifyGitHubWebhook({ headers: request.headers, body }, deps.secret);
    if (event.kind === "ping") return json(200, { ok: true });
    if (event.kind !== "push") return json(202, { ignored: true });
    return json(202, { connections: await deps.pushed(event.repository, event.branch) });
  } catch (error) {
    if (isProviderError(error, "invalid_webhook")) return json(401, { error: { code: "invalid_signature" } });
    console.error(`[fjord] github webhook: unexpected ${error instanceof Error ? error.name : "failure"}`);
    return json(500, { error: { code: "internal_error" } });
  }
}
