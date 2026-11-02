/**
 * The two notices Sovereign sends Fjord Web (DESIGN.md §17; core-app §3.6.5 and §4.5 in sovereignfs/sovereign), as the HTTP rules of
 * `POST /api/sovereign/backchannel-logout` and `POST /api/sovereign/account-deleted`. The route finds who may verify a notice and who acts on
 * it and hands them in, as `src/connections/http.ts` does, so every answer here is tested with stand-ins and each rule was seen to fail
 * with it switched off.
 *
 * The credential of these routes is the signed token and nothing else: there is no session, no cookie and no `Origin` (Sovereign's server
 * sends it), so a request is trusted exactly as far as `verify` trusts its token. What a verifier refuses is `400`, as Sovereign's contract
 * says; core being unreachable to check it is `503`; a failure of ours is `500`. Sovereign does not retry a logout notice and does retry a
 * deletion until it is answered `200`, with a new token each time, so a `5xx` for a deletion is how a failed one is made to run again.
 *
 * Nothing here logs the token, the person, or what went wrong beyond the kind of error.
 */

/** What checks a notice. Fjord's server hands in `@sovereignfs/sdk`'s `verifyLogoutToken` and `verifyAccountDeletedToken`, made for its settings. */
export interface NoticeVerifiers {
  /** Throws `InvalidNoticeError` for a notice to refuse and `CoreUnavailableError` when core could not be asked. */
  logout(request: Request): Promise<{ sub?: string; sid?: string }>;
  accountDeleted(request: Request): Promise<{ sub: string }>;
}

/** What is done about the person. */
export interface PeopleActions {
  endSessions(sub: string): Promise<number>;
  deletePerson(sub: string): Promise<void>;
}

export interface NoticeDeps {
  verify: NoticeVerifiers;
  people: PeopleActions;
  /** Where the kind of a failure is said (never its message, which may name a host or a person). */
  log?: (line: string) => void;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const invalid = () => json(400, { error: "invalid_request" });

/** `InvalidNoticeError` and `CoreUnavailableError` are the SDK's; a name is checked and not a class, so a second copy of the package still means the same. */
const kindOf = (error: unknown): string => (error instanceof Error ? error.name : "failure");

type Checked<T> = { ok: true; value: T } | { ok: false; response: Response };

async function checked<T>(deps: NoticeDeps, what: string, check: () => Promise<T>): Promise<Checked<T>> {
  try {
    return { ok: true, value: await check() };
  } catch (error) {
    const kind = kindOf(error);
    if (kind === "InvalidNoticeError") return { ok: false, response: invalid() };
    deps.log?.(`[fjord] sovereign: ${what} could not be checked (${kind})`);
    if (kind === "CoreUnavailableError") return { ok: false, response: json(503, { error: "temporarily_unavailable" }) };
    return { ok: false, response: json(500, { error: "server_error" }) };
  }
}

/** Sovereign ended a session of this person's: end every session they have here, and answer `200`. */
export async function handleBackChannelLogout(request: Request, deps: NoticeDeps): Promise<Response> {
  const notice = await checked(deps, "a logout notice", () => deps.verify.logout(request));
  if (!notice.ok) return notice.response;
  // A token that names only a session is accepted and ends nothing: Fjord Web does not know core's session ids. Sovereign names the person too.
  if (notice.value.sub !== undefined) {
    try {
      await deps.people.endSessions(notice.value.sub);
    } catch (error) {
      deps.log?.(`[fjord] sovereign: a logout notice could not be acted on (${kindOf(error)})`);
      return json(500, { error: "server_error" });
    }
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

/**
 * The person deleted their account at Sovereign: delete what is held of them here. `200` only once it is done, so that Sovereign stops
 * sending it; `500` when it is not, so that it sends it again.
 */
export async function handleAccountDeleted(request: Request, deps: NoticeDeps): Promise<Response> {
  const notice = await checked(deps, "an account-deleted notice", () => deps.verify.accountDeleted(request));
  if (!notice.ok) return notice.response;
  try {
    await deps.people.deletePerson(notice.value.sub);
  } catch (error) {
    deps.log?.(`[fjord] sovereign: an account-deleted notice could not be acted on (${kindOf(error)})`);
    return json(500, { error: "server_error" });
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}
