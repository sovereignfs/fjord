import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAll, dbRun } from "../db/exec";
import { testTarget } from "../db/test-support";
import { type FakeSovereign, type FakeUser, type LoginOverrides, startFakeSovereign } from "./testing/fake-sovereign";
import { type TestAuth, type TestClient, makeAuth } from "./test-support";

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
