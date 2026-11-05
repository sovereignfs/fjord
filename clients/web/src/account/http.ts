import type { Rule, Taken } from "../limits/rate";

/**
 * A person's own account: deleting it (research 0002, G3). It is the one thing here that cannot be undone and that a stolen session should not be able to do alone, so it asks for
 * the account's password where it has one, counted so that it is not a way to guess it, and for the address typed out, so that it is not done by a slip. What is deleted is what `People` deletes
 * when Sovereign says a person has gone: every repository's connection (a git repository is untouched; one kept on this server is gone), what was shared, drafts, and what they said on
 * others' documents. Written against `Request` and `Response`, and handed the caller, so the rules are tested directly.
 */
export interface Caller {
  accountId: string;
  email: string;
}

export interface AccountDeps {
  origin: string;
  hasPassword(accountId: string): Promise<boolean>;
  /** Whether this is the account's password: asked of the sign-in, by the session of the request. */
  passwordIs(password: string, request: Request): Promise<boolean>;
  limiter: { take(key: string, rule: Rule): Promise<Taken> };
  deleteAccount(accountId: string): Promise<void>;
  /** Whether the address is Sovereign's to give: the account is linked to a Sovereign login, which must have the same address (`DESIGN.md` §6). */
  sovereignLinked(accountId: string): Promise<boolean>;
  /**
   * Asks for the change. `changed`: the address is the new one now. `asked`: a link was sent, to the address it has, and it changes when that is followed. `taken`: another account has it, which
   * with no email is told plainly (sign-up says so too), and with email is not told apart from `asked`.
   */
  changeEmail(accountId: string, next: string, request: Request): Promise<{ result: "changed" | "asked" | "taken"; cookies: string[] }>;
  /** The `set-cookie` headers that end the session in this browser. */
  endingCookies(request: Request): Promise<string[]>;
}

/** Wrong passwords: a few slips, and not a way to try many. Per account, because the session is what is being doubted. */
export const PASSWORD_TRIES: Rule = { limit: 5, windowMs: 15 * 60 * 1000 };
const MAX_BODY_CHARS = 4_000;

const json = (status: number, body: unknown, cookies: string[] = []) => {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
};
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });

/** What every route of the account asks before anything else: signed in, from this site, a JSON object of a sensible size. */
export async function bodyOf(request: Request, caller: Caller | null, origin: string): Promise<Record<string, unknown> | Response> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (request.headers.get("origin") !== origin) return failure(403, "forbidden", "This request did not come from this site.");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : failure(400, "invalid_request", "Send a JSON object.");
  } catch {
    return failure(400, "invalid_request", "Send a JSON object.");
  }
}

/** Whether what was typed is the account's password, with what to answer if it is not. Counted before it is asked, so that the limit holds while the answer is awaited. */
export async function checkPassword(password: unknown, caller: Caller, request: Request, deps: Pick<AccountDeps, "passwordIs" | "limiter">): Promise<Response | null> {
  if (typeof password !== "string" || password === "") return failure(422, "wrong_password", "Type your password to go on.");
  const taken = await deps.limiter.take(`account:${caller.accountId}:password`, PASSWORD_TRIES);
  if (!taken.ok) return failure(429, "rate_limited", "That is too many tries. Wait a quarter of an hour and try again.");
  if (!(await deps.passwordIs(password, request))) return failure(422, "wrong_password", "That is not your password. Nothing was changed.");
  return null;
}

/** `POST /api/account/delete`, `{ confirm, password? }`. */
export async function handleDeleteAccount(request: Request, caller: Caller | null, deps: AccountDeps): Promise<Response> {
  try {
    const body = await bodyOf(request, caller, deps.origin);
    if (body instanceof Response) return body;
    const who = caller as Caller;
    if (typeof body.confirm !== "string") return failure(400, "invalid_request", "Send the address, typed out, as text.");
    if (body.confirm.trim().toLowerCase() !== who.email.toLowerCase()) return failure(422, "not_confirmed", "Type your address as it is shown, to say you mean it. Nothing was deleted.");
    if (await deps.hasPassword(who.accountId)) {
      const refused = await checkPassword(body.password, who, request, deps);
      if (refused) return refused;
    }
    // The cookies are worked out first: once the account is gone, the session they are for cannot be read.
    const cookies = await deps.endingCookies(request);
    await deps.deleteAccount(who.accountId);
    return json(200, { deleted: true }, cookies);
  } catch (error) {
    console.error(`[fjord] account: unexpected ${error instanceof Error ? error.name : "failure"}`);
    return failure(500, "internal_error", "Something went wrong on our side, and it may not all be deleted. Try again.");
  }
}

const MAX_EMAIL_CHARS = 254;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** `POST /api/account/email`, `{ email, password }` (research 0002, G4). The password is what stands between a session someone left open and the account being taken away from its address. */
export async function handleChangeEmail(request: Request, caller: Caller | null, deps: AccountDeps): Promise<Response> {
  try {
    const body = await bodyOf(request, caller, deps.origin);
    if (body instanceof Response) return body;
    const who = caller as Caller;
    if (typeof body.email !== "string") return failure(400, "invalid_request", "Send the new address as text.");
    const next = body.email.trim().toLowerCase();
    if (next.length > MAX_EMAIL_CHARS || !EMAIL.test(next)) return failure(422, "bad_address", "That does not look like an email address. Nothing was changed.");
    if (next === who.email.toLowerCase()) return failure(422, "same_address", "That is the address you have now.");
    if (await deps.sovereignLinked(who.accountId)) return failure(422, "sovereign_address", "Your address is the one Sovereign has, because the two are linked. Change it there, or unlink Sovereign first.");
    if (!(await deps.hasPassword(who.accountId))) return failure(422, "sovereign_address", "You sign in with Sovereign, and your address is the one it has. Change it there.");
    const refused = await checkPassword(body.password, who, request, deps);
    if (refused) return refused;
    const { result, cookies } = await deps.changeEmail(who.accountId, next, request);
    if (result === "taken") return failure(422, "address_taken", "That address cannot be used here. Nothing was changed.");
    return json(200, { result }, cookies);
  } catch (error) {
    console.error(`[fjord] account: unexpected ${error instanceof Error ? error.name : "failure"}`);
    return failure(500, "internal_error", "Something went wrong on our side. Nothing was changed. Try again.");
  }
}
