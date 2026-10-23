import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAll, dbRun } from "../db/exec";
import { testTarget } from "../db/test-support";
import { type FakeSovereign, type FakeUser, type LoginOverrides, startFakeSovereign } from "./testing/fake-sovereign";
import { type TestAuth, type TestClient, makeAuth, secretFromUri, totp } from "./test-support";

/**
 * Sign-in through Sovereign (DESIGN.md §6), over real requests: better-auth's own handler on one
 * side, a fake Sovereign (`testing/fake-sovereign.ts`) on the other, and whichever database the
 * leg runs on in between. What is tested is what the sign-in promises: who gets in, as whom, and
 * what a forged or refused login leaves behind.
 */
const { leg } = testTarget();

let addresses = 0;
const visitor = (t: TestAuth): TestClient => t.client().from(`10.9.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`);

let people = 0;
const person = (extra: Partial<FakeUser> = {}): FakeUser => {
  const n = ++people;
  return { sub: `sovereign-user-${n}`, email: `person${n}@sovereign.test`, name: `Person ${n}`, ...extra };
};

interface Login {
  /** Where the callback sent the browser. */
  location: URL;
  status: number;
  signedIn: boolean;
}

/** The whole dance a browser does, without the browser: start, go to Sovereign, come back. */
async function login(t: TestAuth, fake: FakeSovereign, client: TestClient, user: FakeUser, overrides?: LoginOverrides): Promise<Login> {
  fake.signInAs(user, overrides);
  const start = await client.post("/api/auth/sign-in/social", { provider: "sovereign", callbackURL: "/", errorCallbackURL: "/sign-in", newUserCallbackURL: "/" });
  expect(start.status).toBe(200);
  const authorize = await fetch(start.body.url as string, { redirect: "manual" });
  const back = authorize.headers.get("location");
  expect(back).toBeTruthy();
  const callback = await client.follow(back as string);
  const location = new URL(callback.headers.get("location") ?? "/", t.config.url);
  return { location, status: callback.status, signedIn: client.has("session_token") };
}

const accounts = (t: TestAuth) => dbAll<{ provider_id: string; account_id: string; access_token: string | null; id_token: string | null }>(t.database, sql`SELECT provider_id, account_id, access_token, id_token FROM ${sql.raw(t.database.dialect === "postgres" ? '"fjord_auth"."account"' : "account")}`);
const users = (t: TestAuth) => dbAll<{ id: string; email: string; name: string; email_verified: boolean | number }>(t.database, sql`SELECT id, email, name, email_verified FROM ${sql.raw(t.database.dialect === "postgres" ? '"fjord_auth"."user"' : "user")}`);

describe(`Sovereign sign-in, open sign-up (${leg})`, () => {
  let fake: FakeSovereign;
  let t: TestAuth;
  beforeAll(async () => {
    fake = await startFakeSovereign();
    t = await makeAuth({ local: false, signUp: "open", sovereign: { issuer: fake.issuer, clientId: fake.clientId, clientSecret: fake.clientSecret } });
  });
  afterAll(async () => {
    await t.close();
    await fake.close();
  });

  it("signs a new person in as the account Sovereign says they are: its sub, email and name", async () => {
    const who = person();
    const result = await login(t, fake, visitor(t), who);
    expect(result.signedIn).toBe(true);
    expect(result.location.pathname).toBe("/");

    const user = (await users(t)).find((u) => u.email === who.email);
    expect(user).toMatchObject({ email: who.email, name: who.name });
    expect(Boolean(user?.email_verified)).toBe(true);
    const account = (await accounts(t)).find((a) => a.account_id === who.sub);
    expect(account).toMatchObject({ provider_id: "sovereign", account_id: who.sub });
  });

  it("asks Sovereign the way its client was registered: the exact callback, PKCE S256, the client secret by basic auth", async () => {
    const before = fake.authorizations.length;
    await login(t, fake, visitor(t), person());
    const asked = fake.authorizations[before]!.searchParams;
    expect(asked.get("redirect_uri")).toBe(`${t.config.url}/api/auth/callback/sovereign`);
    expect(asked.get("client_id")).toBe(fake.clientId);
    expect(asked.get("code_challenge_method")).toBe("S256");
    expect(asked.get("scope")?.split(/[ +]/)).toEqual(expect.arrayContaining(["openid", "profile", "email"]));
    expect(asked.get("nonce")).toBeTruthy();
    const token = fake.tokenRequests.at(-1)!;
    expect(token.authorization).toMatch(/^Basic /);
    expect(token.form.get("code_verifier")).toBeTruthy();
  });

  it("recognises the same person next time by their sub, and does not make another account", async () => {
    const who = person();
    await login(t, fake, visitor(t), who);
    const first = (await users(t)).length;
    const again = await login(t, fake, visitor(t), who);
    expect(again.signedIn).toBe(true);
    expect((await users(t)).length).toBe(first);
  });

  it("signs in by sub even when the email address has changed at Sovereign", async () => {
    const who = person();
    await login(t, fake, visitor(t), who);
    const before = (await users(t)).length;
    const result = await login(t, fake, visitor(t), { ...who, email: `moved-${who.email}` });
    expect(result.signedIn).toBe(true);
    expect((await users(t)).length).toBe(before);
  });

  it("falls back to the part of the email before the @ when Sovereign sends no name", async () => {
    const who = person({ name: undefined as unknown as string });
    delete (who as { name?: string }).name;
    const result = await login(t, fake, visitor(t), who);
    expect(result.signedIn).toBe(true);
    expect((await users(t)).find((u) => u.email === who.email)?.name).toBe(who.email.split("@")[0]);
  });

  it("keeps the tokens Sovereign handed over encrypted at rest", async () => {
    await login(t, fake, visitor(t), person());
    const token = fake.accessTokensIssued.at(-1)!;
    const stored = await accounts(t);
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) expect(row.access_token ?? "").not.toContain(token);
    expect(stored.some((row) => row.access_token)).toBe(true);
  });

  it("refuses an ID token signed by a key Sovereign does not publish, and leaves no account", async () => {
    const who = person();
    const before = (await users(t)).length;
    const result = await login(t, fake, visitor(t), who, { signWithWrongKey: true });
    expect(result.signedIn).toBe(false);
    expect(result.location.searchParams.get("error")).toBeTruthy();
    expect((await users(t)).length).toBe(before);
    expect((await users(t)).some((u) => u.email === who.email)).toBe(false);
  });

  it("refuses an ID token meant for another client", async () => {
    const result = await login(t, fake, visitor(t), person(), { claims: { aud: "someone-else" } });
    expect(result.signedIn).toBe(false);
    expect(result.location.searchParams.get("error")).toBeTruthy();
  });

  it("refuses an ID token that does not carry the nonce it was asked to", async () => {
    const result = await login(t, fake, visitor(t), person(), { omitNonce: true });
    expect(result.signedIn).toBe(false);
    expect(result.location.searchParams.get("error")).toBeTruthy();
  });

  it("brings the person back to the sign-in page with a reason when they decline", async () => {
    const client = visitor(t);
    fake.denyNext();
    const start = await client.post("/api/auth/sign-in/social", { provider: "sovereign", callbackURL: "/", errorCallbackURL: "/sign-in" });
    const authorize = await fetch(start.body.url as string, { redirect: "manual" });
    const callback = await client.follow(authorize.headers.get("location") as string);
    const location = new URL(callback.headers.get("location") ?? "", t.config.url);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(client.has("session_token")).toBe(false);
  });

  it("does not accept a callback twice", async () => {
    const client = visitor(t);
    fake.signInAs(person());
    const start = await client.post("/api/auth/sign-in/social", { provider: "sovereign", callbackURL: "/", errorCallbackURL: "/sign-in" });
    const authorize = await fetch(start.body.url as string, { redirect: "manual" });
    const back = authorize.headers.get("location") as string;
    await client.follow(back);
    const replay = visitor(t);
    const second = await replay.follow(back);
    expect(replay.has("session_token")).toBe(false);
    expect(new URL(second.headers.get("location") ?? "", t.config.url).searchParams.get("error")).toBeTruthy();
  });

  it("ends the session on sign-out without sending the person to Sovereign to sign out there", async () => {
    const client = visitor(t);
    await login(t, fake, client, person());
    const out = await client.post("/api/auth/sign-out", {});
    expect(out.status).toBe(200);
    expect(JSON.stringify(out.body ?? {})).not.toContain(fake.issuer);
    expect(client.has("session_token")).toBe(false);
  });

  it("has no email and password, passkeys or two-factor: the first are refused, the plugins' routes are not there", async () => {
    const before = (await users(t)).length;
    const client = visitor(t);
    for (const path of ["/api/auth/sign-in/email", "/api/auth/sign-up/email"]) {
      const reply = await client.post(path, { name: "Mallory", email: "mallory@example.com", password: "correct horse battery" });
      expect(reply.status, path).toBe(400);
    }
    for (const path of ["/api/auth/two-factor/enable", "/api/auth/passkey/generate-register-options"]) {
      expect((await client.post(path, { password: "x" })).status, path).toBe(404);
    }
    expect(client.has("session_token")).toBe(false);
    expect((await users(t)).length).toBe(before);
  });
});

describe(`Sovereign sign-in, first account only (${leg})`, () => {
  let fake: FakeSovereign;
  let t: TestAuth;
  beforeAll(async () => {
    fake = await startFakeSovereign();
    t = await makeAuth({ local: false, signUp: "closed", sovereign: { issuer: fake.issuer, clientId: fake.clientId, clientSecret: fake.clientSecret } });
  });
  afterAll(async () => {
    await t.close();
    await fake.close();
  });

  it("lets the first person in and refuses everyone after, by the server and not only the page", async () => {
    const first = await login(t, fake, visitor(t), person());
    expect(first.signedIn).toBe(true);

    const second = person();
    const refused = await login(t, fake, visitor(t), second);
    expect(refused.signedIn).toBe(false);
    expect(refused.location.pathname).toBe("/sign-in");
    expect(refused.location.searchParams.get("error")).toBe("SIGNUP_CLOSED");
    expect((await users(t)).some((u) => u.email === second.email)).toBe(false);
    expect((await users(t)).length).toBe(1);
  });

  it("still lets the first person back in", async () => {
    const [existing] = await users(t);
    const sub = (await accounts(t))[0]!.account_id;
    const again = await login(t, fake, visitor(t), { sub, email: existing!.email, name: existing!.name });
    expect(again.signedIn).toBe(true);
  });
});

describe(`Sovereign beside local sign-in (${leg})`, () => {
  let fake: FakeSovereign;
  let t: TestAuth;
  beforeAll(async () => {
    fake = await startFakeSovereign();
    t = await makeAuth({ signUp: "open", sovereign: { issuer: fake.issuer, clientId: fake.clientId, clientSecret: fake.clientSecret } });
  });
  afterAll(async () => {
    await t.close();
    await fake.close();
  });

  it("does not attach a Sovereign login to a local account because the email address is the same", async () => {
    const email = "shared@example.com";
    const signedUp = await visitor(t).post("/api/auth/sign-up/email", { name: "Local Ada", email, password: "correct horse battery" });
    expect(signedUp.status).toBe(200);
    // An address that has been confirmed is the strongest case for linking by email: it is the
    // one that better-auth's own safeguards would allow, so what refuses is ours.
    await dbRun(t.database, sql`UPDATE ${sql.raw(t.database.dialect === "postgres" ? '"fjord_auth"."user"' : "user")} SET email_verified = ${t.database.dialect === "postgres" ? true : 1} WHERE email = ${email}`);
    const before = (await users(t)).length;

    const result = await login(t, fake, visitor(t), person({ email }));
    expect(result.signedIn).toBe(false);
    expect(result.location.searchParams.get("error")).toBe("account_not_linked");
    expect((await users(t)).length).toBe(before);
    expect((await accounts(t)).some((a) => a.provider_id === "sovereign")).toBe(false);
  });

  it("still signs a local account in with its password", async () => {
    const email = "local-only@example.com";
    await visitor(t).post("/api/auth/sign-up/email", { name: "Local", email, password: "correct horse battery" });
    const client = visitor(t);
    const reply = await client.post("/api/auth/sign-in/email", { email, password: "correct horse battery" });
    expect(reply.status).toBe(200);
    expect(client.has("session_token")).toBe(true);
  });

  it("lets a Sovereign login with a different email make its own account", async () => {
    const result = await login(t, fake, visitor(t), person());
    expect(result.signedIn).toBe(true);
  });
});

const PASSWORD = "correct horse battery";

describe(`linking a Sovereign account to a local one (${leg})`, () => {
  let fake: FakeSovereign;
  let t: TestAuth;
  beforeAll(async () => {
    fake = await startFakeSovereign();
    t = await makeAuth({ signUp: "open", sovereign: { issuer: fake.issuer, clientId: fake.clientId, clientSecret: fake.clientSecret } });
  });
  afterAll(async () => {
    await t.close();
    await fake.close();
  });

  /** A local account, signed in. */
  async function localAccount(email: string, name = "Local Ada"): Promise<TestClient> {
    const client = visitor(t);
    const made = await client.post("/api/auth/sign-up/email", { name, email, password: PASSWORD });
    expect(made.status).toBe(200);
    return client;
  }

  /** Start linking from a signed-in client, go to Sovereign as `user`, come back: where the callback sent the browser. */
  async function link(client: TestClient, user: FakeUser, overrides?: LoginOverrides): Promise<URL> {
    fake.signInAs(user, overrides);
    const start = await client.post("/api/auth/link-social", { provider: "sovereign", callbackURL: "/account/security?linked=1", errorCallbackURL: "/account/security" });
    expect(start.status).toBe(200);
    const authorize = await fetch(start.body.url as string, { redirect: "manual" });
    const callback = await client.follow(authorize.headers.get("location") as string);
    return new URL(callback.headers.get("location") ?? "/", t.config.url);
  }

  const providers = async (client: TestClient) => ((await client.get("/api/auth/list-accounts")).body as { id: string; providerId: string }[]).map((a) => a.providerId).sort();
  const sovereignAccounts = async () => (await accounts(t)).filter((a) => a.provider_id === "sovereign");

  it("links a Sovereign account whose email address is the account's own, from a signed-in session", async () => {
    const email = "link-ok@example.com";
    const client = await localAccount(email);
    const who = person({ email });
    const before = (await users(t)).length;

    const back = await link(client, who);
    expect(back.pathname).toBe("/account/security");
    expect(back.searchParams.get("linked")).toBe("1");
    expect(back.searchParams.get("error")).toBeNull();
    expect(await providers(client)).toEqual(["credential", "sovereign"]);
    expect((await sovereignAccounts()).some((a) => a.account_id === who.sub)).toBe(true);
    expect((await users(t)).length).toBe(before);
  });

  it("then signs that same account in through Sovereign, by the sub, whatever Sovereign's address becomes", async () => {
    const email = "link-then-login@example.com";
    const client = await localAccount(email, "Local Grace");
    const who = person({ email, name: "Sovereign's name for her" });
    await link(client, who);
    const before = (await users(t)).length;

    const fresh = visitor(t);
    const result = await login(t, fake, fresh, { ...who, email: `renamed-${email}` });
    expect(result.signedIn).toBe(true);
    expect((await users(t)).length).toBe(before);
    // The account is still the local one: its name and its email are not Sovereign's.
    const session = (await fresh.get("/api/auth/get-session")).body;
    expect(session.user).toMatchObject({ email, name: "Local Grace" });
  });

  it("matches the address without regard to case", async () => {
    const client = await localAccount("Mixed.Case@Example.com");
    const back = await link(client, person({ email: "mixed.case@example.com" }));
    expect(back.searchParams.get("error")).toBeNull();
    expect(await providers(client)).toContain("sovereign");
  });

  it("refuses a Sovereign account with a different email address, and links nothing", async () => {
    const client = await localAccount("link-different@example.com");
    const before = (await sovereignAccounts()).length;
    const back = await link(client, person({ email: "someone-else@sovereign.test" }));
    expect(back.pathname).toBe("/account/security");
    expect(back.searchParams.get("error")).toBe("email_does_not_match");
    expect(await providers(client)).toEqual(["credential"]);
    expect((await sovereignAccounts()).length).toBe(before);
  });

  it("links even when Sovereign's token does not say the address is verified, because Sovereign's contract is that it is", async () => {
    const email = "link-unverified-claim@example.com";
    const client = await localAccount(email);
    const back = await link(client, person({ email, emailVerified: false }));
    expect(back.searchParams.get("error")).toBeNull();
    expect(await providers(client)).toContain("sovereign");
  });

  it("refuses a Sovereign identity that is already linked to another account", async () => {
    const first = await localAccount("link-first@example.com");
    const second = await localAccount("link-second@example.com");
    const who = person({ email: "link-first@example.com" });
    await link(first, who);

    const back = await link(second, { ...who, email: "link-second@example.com" });
    expect(back.searchParams.get("error")).toBe("account_already_linked_to_different_user");
    expect(await providers(second)).toEqual(["credential"]);
    expect(await providers(first)).toContain("sovereign");
  });

  it("needs a signed-in session: nobody who is not signed in can start it", async () => {
    const reply = await visitor(t).post("/api/auth/link-social", { provider: "sovereign", callbackURL: "/account/security" });
    expect(reply.status).toBe(401);
    expect(reply.body?.url).toBeUndefined();
  });

  it("is still refused at sign-in for an address nobody has linked, and the message is the one the page shows", async () => {
    await localAccount("never-linked@example.com");
    const result = await login(t, fake, visitor(t), person({ email: "never-linked@example.com" }));
    expect(result.signedIn).toBe(false);
    expect(result.location.searchParams.get("error")).toBe("account_not_linked");
  });

  it("can be undone for an account that has a password, after which the address is refused again", async () => {
    const email = "link-undo@example.com";
    const client = await localAccount(email);
    const who = person({ email });
    await link(client, who);
    const row = ((await client.get("/api/auth/list-accounts")).body as { id: string; providerId: string }[]).find((a) => a.providerId === "sovereign")!;

    const undone = await client.post("/api/auth/unlink-account", { accountId: row.id });
    expect(undone.status).toBe(200);
    expect(await providers(client)).toEqual(["credential"]);

    const result = await login(t, fake, visitor(t), who);
    expect(result.signedIn).toBe(false);
    expect(result.location.searchParams.get("error")).toBe("account_not_linked");
  });

  it("cannot be undone by an account that signs in only through Sovereign: its last way in stays", async () => {
    const client = visitor(t);
    const who = person();
    await login(t, fake, client, who);
    const rows = (await client.get("/api/auth/list-accounts")).body as { id: string; providerId: string }[];
    expect(rows.map((r) => r.providerId)).toEqual(["sovereign"]);

    const refused = await client.post("/api/auth/unlink-account", { accountId: rows[0]!.id });
    expect(refused.status).toBe(400);
    expect(await providers(client)).toEqual(["sovereign"]);
    expect((await client.get("/api/auth/get-session")).body.user.email).toBe(who.email);
  });

  it("cannot unlink someone else's account", async () => {
    const mine = await localAccount("link-mine@example.com");
    const theirs = await localAccount("link-theirs@example.com");
    await link(theirs, person({ email: "link-theirs@example.com" }));
    const theirRow = ((await theirs.get("/api/auth/list-accounts")).body as { id: string; providerId: string }[]).find((a) => a.providerId === "sovereign")!;

    const refused = await mine.post("/api/auth/unlink-account", { accountId: theirRow.id });
    expect(refused.status).toBe(400);
    expect(await providers(theirs)).toContain("sovereign");
  });

  it("lets a person with two-factor on sign in through Sovereign without being asked for a code: Sovereign has its own", async () => {
    const email = "link-2fa@example.com";
    const client = await localAccount(email);
    const enabled = await client.post("/api/auth/two-factor/enable", { password: PASSWORD });
    expect(enabled.status).toBe(200);
    expect((await client.post("/api/auth/two-factor/verify-totp", { code: totp(secretFromUri(enabled.body.totpURI)) })).status).toBe(200);

    const who = person({ email });
    await link(client, who);
    const fresh = visitor(t);
    const result = await login(t, fake, fresh, who);
    expect(result.signedIn).toBe(true);
    expect((await fresh.get("/api/auth/get-session")).body.user.email).toBe(email);
  });
});

describe(`Sovereign sign-in against a provider that cannot be checked (${leg})`, () => {
  it("does not offer sign-in at all when discovery publishes no signing keys, rather than trusting unverified tokens", async () => {
    const fake = await startFakeSovereign({ omitFromDiscovery: ["jwks_uri"] });
    const t = await makeAuth({ local: false, signUp: "open", sovereign: { issuer: fake.issuer, clientId: fake.clientId, clientSecret: fake.clientSecret } });
    try {
      const reply = await visitor(t).post("/api/auth/sign-in/social", { provider: "sovereign", callbackURL: "/" });
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(reply.body?.url).toBeUndefined();
      expect(fake.authorizations).toHaveLength(0);
    } finally {
      await t.close();
      await fake.close();
    }
  });
});

describe(`Sovereign sign-in when only local is on (${leg})`, () => {
  let t: TestAuth;
  beforeAll(async () => {
    t = await makeAuth({ signUp: "open" });
  });
  afterAll(async () => t.close());

  it("has no Sovereign sign-in to start", async () => {
    const reply = await visitor(t).post("/api/auth/sign-in/social", { provider: "sovereign", callbackURL: "/" });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.body?.url).toBeUndefined();
  });
});
