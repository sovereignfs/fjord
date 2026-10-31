import { createHash, timingSafeEqual } from "node:crypto";
import { STATE_COOKIE, STATE_MAX_AGE_SECONDS, type InstallOutcome, installUrl, newState } from "./install";
import type { GitHubAppConfig } from "./config";

/**
 * The HTTP face of installing the App (ROADMAP 1a.6): `GET /api/github-app/install` sends a signed-in person to GitHub, and
 * `GET /api/github-app/callback` is where GitHub sends them back. Both are for a signed-in account only (401 otherwise), and the way
 * back must carry the random `state` this browser was given on the way out (`install.ts`), so a link made by someone else does
 * nothing. A person is always sent back to `/repositories` with a short code in the address saying what happened, never text.
 */
export interface Caller {
  accountId: string;
}

export interface InstallHttpDeps {
  /** Undefined when this instance has no GitHub App: the routes are not there (404). */
  config: GitHubAppConfig | undefined;
  webUrl: string;
  /** The instance's origin, `FJORD_URL`: where people are sent back to, and whether the cookie is `Secure`. */
  origin: string;
  complete: (accountId: string, input: { code: string; installationId: number }) => Promise<InstallOutcome>;
}

const notFound = () => new Response(null, { status: 404 });
const unauthorized = () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "Sign in first." } }), { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

const digest = (value: string) => createHash("sha256").update(value).digest();
const sameState = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

function setCookie(origin: string, value: string, maxAge: number): string {
  return `${STATE_COOKIE}=${value}; Path=/api/github-app; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${origin.startsWith("https:") ? "; Secure" : ""}`;
}

function back(deps: InstallHttpDeps, query: Record<string, string>): Response {
  const location = `${deps.origin}/repositories?${new URLSearchParams(query).toString()}`;
  return new Response(null, { status: 303, headers: { location, "set-cookie": setCookie(deps.origin, "", 0), "cache-control": "no-store" } });
}

export function handleInstall(request: Request, caller: Caller | null, deps: InstallHttpDeps): Response {
  if (!deps.config) return notFound();
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if (!caller) return unauthorized();
  const state = newState();
  return new Response(null, {
    status: 303,
    headers: { location: installUrl(deps.config, deps.webUrl, state), "set-cookie": setCookie(deps.origin, state, STATE_MAX_AGE_SECONDS), "cache-control": "no-store" },
  });
}

export async function handleCallback(request: Request, caller: Caller | null, deps: InstallHttpDeps): Promise<Response> {
  if (!deps.config) return notFound();
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if (!caller) return unauthorized();

  const query = new URL(request.url).searchParams;
  const state = query.get("state") ?? "";
  const kept = cookieValue(request, STATE_COOKIE) ?? "";
  if (state === "" || kept === "" || !sameState(state, kept)) return back(deps, { github_app: "state" });

  // The App is installed on an organisation by someone who can only ask its owners to approve it: nothing is connected yet.
  if (query.get("setup_action") === "request") return back(deps, { github_app: "requested" });

  const code = query.get("code") ?? "";
  const rawId = query.get("installation_id") ?? "";
  if (code === "" || code.length > 200 || !/^[1-9][0-9]{0,15}$/.test(rawId)) return back(deps, { github_app: "incomplete" });

  const outcome = await deps.complete(caller.accountId, { code, installationId: Number(rawId) });
  if (!outcome.ok) return back(deps, { github_app: outcome.reason });
  return back(deps, { github_app: "ok", added: String(outcome.added), already: String(outcome.already), skipped: String(outcome.skipped) });
}
