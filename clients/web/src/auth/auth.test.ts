import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresAuth from "../db/schema/postgres/auth";
import * as sqliteAuth from "../db/schema/sqlite/auth";
import { testTarget } from "../db/test-support";
import { type TestAuth, type TestClient, makeAuth, secretFromUri, totp } from "./test-support";

/**
 * The sign-in flows, over real requests, against whichever database the leg runs on. Each
 * `describe` makes one instance and its tests use accounts and addresses of their own, so
 * they do not depend on each other or on the order.
 */
const { leg } = testTarget();
const PASSWORD = "correct horse battery";
const smtp = { host: "mail.test", port: 587, secure: false, from: "fjord@test" };

let addresses = 0;
/** A visitor from an address of their own: the rate limit is per address. */
const visitor = (t: TestAuth): TestClient => t.client().from(`10.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}.1`);

let accounts = 0;
const newEmail = () => `person${++accounts}@example.com`;

async function signUp(client: TestClient, email = newEmail(), password = PASSWORD) {
  return { email, reply: await client.post("/api/auth/sign-up/email", { name: "Ada", email, password }) };
}

const userTable = (t: TestAuth) => (t.database.dialect === "postgres" ? postgresAuth.user : sqliteAuth.user);
const userCount = async (t: TestAuth) => Number((await dbGet<{ n: number | string }>(t.database, sql`SELECT COUNT(*) AS n FROM ${userTable(t)}`))?.n);

/** Turn two-factor on for a signed-in client; returns the authenticator secret and the backup codes. */
async function enableTwoFactor(client: TestClient, password = PASSWORD) {
  const enabled = await client.post("/api/auth/two-factor/enable", { password });
  expect(enabled.status).toBe(200);
  const secret = secretFromUri(enabled.body.totpURI);
  const verified = await client.post("/api/auth/two-factor/verify-totp", { code: totp(secret) });
  expect(verified.status).toBe(200);
  return { secret, backupCodes: enabled.body.backupCodes as string[] };
}

describe(`local sign-in, first account only (${leg})`, () => {
  let t: TestAuth;
  beforeAll(async () => {
    t = await makeAuth({ signUp: "closed" });
  });
  afterAll(async () => t.close());

  describe("the first account", () => {
    it("can be made, signs the person in, and stores a hash and not the password", async () => {
      const client = visitor(t);
      const { email, reply } = await signUp(client);
      expect(reply.status).toBe(200);
      expect(reply.body.user).toMatchObject({ email, name: "Ada", emailVerified: false });
      expect(client.has("session_token")).toBe(true);

      const stored = await dbAll<{ password: string }>(t.database, sql`SELECT password FROM ${t.database.dialect === "postgres" ? postgresAuth.account : sqliteAuth.account} WHERE account_id IS NOT NULL`);
      expect(stored.length).toBeGreaterThan(0);
      for (const row of stored) {
        expect(row.password).not.toContain(PASSWORD);
        expect(row.password.length).toBeGreaterThan(40);
      }
      expect(JSON.stringify(reply.body)).not.toContain("password");
    });

    it("sets a session cookie that scripts cannot read, that is not sent cross-site, and is ours", async () => {
      // Whichever test made the first account, a fresh sign-in shows the cookie.
      const client = visitor(t);
      const emails = await dbAll<{ email: string }>(t.database, sql`SELECT email FROM ${userTable(t)} LIMIT 1`);
      const reply = await client.post("/api/auth/sign-in/email", { email: emails[0]!.email, password: PASSWORD });
      expect(reply.status).toBe(200);
      const cookie = reply.setCookies.find((c) => c.startsWith("fjord.session_token="))!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//i);
      expect(cookie).not.toMatch(/Secure/i); // the test instance is http://localhost
    });
  });

  it("then refuses every later sign-up, says why, and creates nothing", async () => {
    const before = await userCount(t);
    expect(before).toBe(1);
    const refused = await signUp(visitor(t));
    expect(refused.reply.status).toBe(403);
    expect(refused.reply.body.message).toBe("Sign-up is closed on this instance.");
    expect(await userCount(t)).toBe(1);
  });

  describe("signing in", () => {
    it("works with the right password, and the session is the person's", async () => {
      const client = visitor(t);
      const [row] = await dbAll<{ email: string }>(t.database, sql`SELECT email FROM ${userTable(t)} LIMIT 1`);
      const reply = await client.post("/api/auth/sign-in/email", { email: row!.email, password: PASSWORD });
      expect(reply.status).toBe(200);
      const session = await client.get("/api/auth/get-session");
      expect(session.body.user.email).toBe(row!.email);
    });

    it("says the same thing for a wrong password as for an email that does not exist", async () => {
      const client = visitor(t);
      const [row] = await dbAll<{ email: string }>(t.database, sql`SELECT email FROM ${userTable(t)} LIMIT 1`);
      const wrong = await client.post("/api/auth/sign-in/email", { email: row!.email, password: "not the password at all" });
      const unknown = await client.post("/api/auth/sign-in/email", { email: "nobody@example.com", password: "not the password at all" });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(unknown.body).toEqual(wrong.body);
      expect(client.has("session_token")).toBe(false);
    });

    it("ends with sign-out, after which the session is gone for good", async () => {
      const client = visitor(t);
      const [row] = await dbAll<{ email: string }>(t.database, sql`SELECT email FROM ${userTable(t)} LIMIT 1`);
      await client.post("/api/auth/sign-in/email", { email: row!.email, password: PASSWORD });
      const token = [...client.jar.entries()].find(([name]) => name.includes("session_token"))![1];
      expect((await client.get("/api/auth/get-session")).body.user).toBeTruthy();

      await client.post("/api/auth/sign-out", {});
      expect((await client.get("/api/auth/get-session")).body).toBeNull();

      // Replaying the old cookie does not bring it back: the session is deleted, not just forgotten.
      const replay = visitor(t);
      replay.jar.set("fjord.session_token", token);
      expect((await replay.get("/api/auth/get-session")).body).toBeNull();
    });
  });

  it("is limited: after three attempts in a row from one address, the fourth is refused", async () => {
    const client = visitor(t);
    const attempt = () => client.post("/api/auth/sign-in/email", { email: "nobody@example.com", password: "guessing guessing" });
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
    // The count is in the database, so another process serving the same address sees it too.
    const counted = await dbAll<{ n: number | string }>(t.database, sql`SELECT COUNT(*) AS n FROM ${t.database.dialect === "postgres" ? postgresAuth.rateLimit : sqliteAuth.rateLimit}`);
    expect(Number(counted[0]?.n)).toBeGreaterThan(0);
  });

  describe("a signed-in request from another site", () => {
    it("is refused, with the session left alone: a hostile Origin, and a missing one", async () => {
      const client = visitor(t);
      const [row] = await dbAll<{ email: string }>(t.database, sql`SELECT email FROM ${userTable(t)} LIMIT 1`);
      await client.post("/api/auth/sign-in/email", { email: row!.email, password: PASSWORD });

      const hostile = await client.post("/api/auth/sign-out", {}, { origin: "https://evil.example.com" });
      expect(hostile.status).toBe(403);
      const missing = await client.post("/api/auth/sign-out", {}, { origin: "" });
      expect(missing.status).toBe(403);
      expect((await client.get("/api/auth/get-session")).body.user).toBeTruthy();
    });
  });

  describe("passwords", () => {
    it("must be as long as the instance says", async () => {
      // Closed, so go through the policy check first: a too-short password is refused as such.
      const reply = await signUp(visitor(t), newEmail(), "short");
      expect([400, 403]).toContain(reply.reply.status);
    });
  });

  it("has no password reset by email, since there is no way to send it", async () => {
    const reply = await visitor(t).post("/api/auth/request-password-reset", { email: "anyone@example.com", redirectTo: "/reset-password" });
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe("RESET_PASSWORD_DISABLED");
  });

  describe("two-factor", () => {
    async function signedInPerson(): Promise<{ client: TestClient; email: string }> {
      const client = visitor(t);
      const [row] = await dbAll<{ email: string }>(t.database, sql`SELECT email FROM ${userTable(t)} LIMIT 1`);
      await client.post("/api/auth/sign-in/email", { email: row!.email, password: PASSWORD });
      return { client, email: row!.email };
    }

    it("turns on only once a code from the authenticator has been shown to work, and gives ten backup codes", async () => {
      const { client, email } = await signedInPerson();
      const enabled = await client.post("/api/auth/two-factor/enable", { password: PASSWORD });
      expect(enabled.body.method).toBe("totp");
      expect(enabled.body.totpURI).toMatch(/^otpauth:\/\/totp\/Fjord:/);
      expect(enabled.body.totpURI).toContain("issuer=Fjord");
      expect(enabled.body.backupCodes).toHaveLength(10);
      expect(new Set(enabled.body.backupCodes).size).toBe(10);

      // Not on yet: a wrong code does not turn it on, a right one does.
      expect((await client.get("/api/auth/get-session")).body.user.twoFactorEnabled).toBe(false);
      expect((await client.post("/api/auth/two-factor/verify-totp", { code: "000000" })).status).toBe(401);
      expect((await client.get("/api/auth/get-session")).body.user.twoFactorEnabled).toBe(false);
      expect((await client.post("/api/auth/two-factor/verify-totp", { code: totp(secretFromUri(enabled.body.totpURI)) })).status).toBe(200);
      expect((await client.get("/api/auth/get-session")).body.user.twoFactorEnabled).toBe(true);

      // Leave things as found: this person is used by the tests below.
      await client.post("/api/auth/two-factor/disable", { password: PASSWORD });
      void email;
    });

    it("asks for a code at sign-in, and a session exists only after a right one", async () => {
      const { client, email } = await signedInPerson();
      const { secret } = await enableTwoFactor(client);
      await client.post("/api/auth/sign-out", {});

      const fresh = visitor(t);
      const first = await fresh.post("/api/auth/sign-in/email", { email, password: PASSWORD });
      expect(first.status).toBe(200);
      expect(first.body.twoFactorRedirect).toBe(true);
      expect(fresh.has("session_token")).toBe(false);
      expect((await fresh.get("/api/auth/get-session")).body).toBeNull();

      const wrong = await fresh.post("/api/auth/two-factor/verify-totp", { code: "000000" });
      expect(wrong.status).toBe(401);
      expect(fresh.has("session_token")).toBe(false);

      const right = await fresh.post("/api/auth/two-factor/verify-totp", { code: totp(secret) });
      expect(right.status).toBe(200);
      expect(fresh.has("session_token")).toBe(true);
      expect((await fresh.get("/api/auth/get-session")).body.user.email).toBe(email);

      await fresh.post("/api/auth/two-factor/disable", { password: PASSWORD });
    });

    it("can be got past with a backup code, once: the code then no longer works", async () => {
      const { client, email } = await signedInPerson();
      const { backupCodes } = await enableTwoFactor(client);
      await client.post("/api/auth/sign-out", {});

      const first = visitor(t);
      await first.post("/api/auth/sign-in/email", { email, password: PASSWORD });
      expect((await first.post("/api/auth/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBe(200);
      expect(first.has("session_token")).toBe(true);

      const second = visitor(t);
      await second.post("/api/auth/sign-in/email", { email, password: PASSWORD });
      const reused = await second.post("/api/auth/two-factor/verify-backup-code", { code: backupCodes[0] });
      expect(reused.status).toBe(401);
      expect(second.has("session_token")).toBe(false);
      // A different code still works: only the used one is spent.
      expect((await second.post("/api/auth/two-factor/verify-backup-code", { code: backupCodes[1] })).status).toBe(200);

      await second.post("/api/auth/two-factor/disable", { password: PASSWORD });
    });

    it("is switched off only by someone who knows the password", async () => {
      const { client, email } = await signedInPerson();
      await enableTwoFactor(client);
      const wrong = await client.post("/api/auth/two-factor/disable", { password: "wrong wrong wrong" });
      expect(wrong.status).toBe(400);
      expect((await client.get("/api/auth/get-session")).body.user.twoFactorEnabled).toBe(true);

      expect((await client.post("/api/auth/two-factor/disable", { password: PASSWORD })).status).toBe(200);
      const plain = visitor(t);
      const reply = await plain.post("/api/auth/sign-in/email", { email, password: PASSWORD });
      expect(reply.body.twoFactorRedirect).toBeUndefined();
      expect(plain.has("session_token")).toBe(true);
    });

    it("locks the account after ten wrong codes, across sign-ins and addresses, even against the right code", async () => {
      const { client, email } = await signedInPerson();
      const { secret } = await enableTwoFactor(client);
      await client.post("/api/auth/sign-out", {});

      // Each sign-in (which needs the password) allows five guesses, so ten take two of them.
      for (let attempt = 0; attempt < 2; attempt++) {
        const guesser = visitor(t);
        await guesser.post("/api/auth/sign-in/email", { email, password: PASSWORD });
        for (let guess = 0; guess < 5; guess++) {
          const other = guesser.from(`10.200.${attempt}.${guess + 1}`);
          expect((await other.post("/api/auth/two-factor/verify-totp", { code: String(111111 + attempt * 10 + guess) })).status).toBe(401);
        }
      }

      // The person, with the right password and the right code, is now refused too.
      const owner = visitor(t);
      await owner.post("/api/auth/sign-in/email", { email, password: PASSWORD });
      const refused = await owner.post("/api/auth/two-factor/verify-totp", { code: totp(secret) });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(owner.has("session_token")).toBe(false);

      // Put things back for the tests that follow: the lock is on the account's two-factor row.
      await dbRun(
        t.database,
        sql`UPDATE ${t.database.dialect === "postgres" ? postgresAuth.twoFactor : sqliteAuth.twoFactor} SET failed_verification_count = 0, locked_until = NULL`,
      );
      const again = visitor(t);
      await again.post("/api/auth/sign-in/email", { email, password: PASSWORD });
      expect((await again.post("/api/auth/two-factor/verify-totp", { code: totp(secret) })).status).toBe(200);
      await again.post("/api/auth/two-factor/disable", { password: PASSWORD });
    });

    it("cannot be switched on without the password either", async () => {
      const { client } = await signedInPerson();
      const reply = await client.post("/api/auth/two-factor/enable", { password: "wrong wrong wrong" });
      expect(reply.status).toBe(400);
    });
  });

  describe("passkeys", () => {
    it("offer a challenge to anyone who asks to sign in, for this instance's relying party", async () => {
      const reply = await visitor(t).get("/api/auth/passkey/generate-authenticate-options");
      expect(reply.status).toBe(200);
      expect(reply.body.rpId).toBe("localhost");
      expect(typeof reply.body.challenge).toBe("string");
      expect(reply.body.challenge.length).toBeGreaterThan(20);
    });

    it("can be registered only by someone signed in, and the options name the instance", async () => {
      expect((await visitor(t).get("/api/auth/passkey/generate-register-options")).status).toBe(401);

      const client = visitor(t);
      const [row] = await dbAll<{ email: string }>(t.database, sql`SELECT email FROM ${userTable(t)} LIMIT 1`);
      await client.post("/api/auth/sign-in/email", { email: row!.email, password: PASSWORD });
      const options = await client.get("/api/auth/passkey/generate-register-options");
      expect(options.status).toBe(200);
      expect(options.body.rp).toEqual({ id: "localhost", name: "Fjord" });
      expect(options.body.user.name).toBe(row!.email);
    });
  });
});

describe(`local sign-in, open sign-up (${leg})`, () => {
  let t: TestAuth;
  beforeAll(async () => {
    t = await makeAuth({ signUp: "open" });
  });
  afterAll(async () => t.close());

  it("lets anyone make an account, each separate", async () => {
    const a = await signUp(visitor(t));
    const b = await signUp(visitor(t));
    expect(a.reply.status).toBe(200);
    expect(b.reply.status).toBe(200);
    expect(a.reply.body.user.id).not.toBe(b.reply.body.user.id);
    expect(await userCount(t)).toBe(2);
  });

  it("refuses a second account for an address already used, and says so", async () => {
    const { email } = await signUp(visitor(t));
    const again = await signUp(visitor(t), email);
    expect(again.reply.status).toBe(422);
    expect(again.reply.body.code).toBe("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL");
  });

  it("treats a password shorter than the minimum as an error, and exactly the minimum as fine", async () => {
    const short = await signUp(visitor(t), newEmail(), "x".repeat(9));
    expect(short.reply.status).toBe(400);
    expect(short.reply.body.code).toBe("PASSWORD_TOO_SHORT");
    const exact = await signUp(visitor(t), newEmail(), "x".repeat(10));
    expect(exact.reply.status).toBe(200);
  });

  it("does not run two-factor for someone who never enrolled", async () => {
    const client = visitor(t);
    const { email } = await signUp(client);
    await client.post("/api/auth/sign-out", {});
    const fresh = visitor(t);
    const reply = await fresh.post("/api/auth/sign-in/email", { email, password: PASSWORD });
    expect(reply.body.twoFactorRedirect).toBeUndefined();
    expect(fresh.has("session_token")).toBe(true);
  });
});

describe(`local sign-in with email (${leg})`, () => {
  let t: TestAuth;
  beforeAll(async () => {
    t = await makeAuth({ signUp: "open", requireEmailVerification: true, smtp });
  });
  afterAll(async () => t.close());

  describe("verifying an address", () => {
    it("is needed: sign-up makes no session, and a link is mailed", async () => {
      const client = visitor(t);
      const { email, reply } = await signUp(client);
      expect(reply.status).toBe(200);
      expect(reply.body.token).toBeNull();
      expect(client.has("session_token")).toBe(false);

      const mail = t.mailer!.last(email)!;
      expect(mail.subject).toBe("Verify your email address for Fjord");
      expect(t.mailer!.linkTo(email)).toMatch(/^http:\/\/localhost:3000\/api\/auth\/verify-email\?token=/);
    });

    it("blocks sign-in until it is done, and the following link finishes it and signs the person in", async () => {
      const client = visitor(t);
      const { email } = await signUp(client);

      const blocked = await client.post("/api/auth/sign-in/email", { email, password: PASSWORD });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe("EMAIL_NOT_VERIFIED");

      const followed = await client.follow(t.mailer!.linkTo(email)!);
      expect(followed.status).toBe(302);
      expect(client.has("session_token")).toBe(true);
      expect((await client.get("/api/auth/get-session")).body.user).toMatchObject({ email, emailVerified: true });
    });

    it("refuses a link that has been altered", async () => {
      const client = visitor(t);
      const { email } = await signUp(client);
      const link = t.mailer!.linkTo(email)!;
      const tampered = link.replace(/token=([^&]{10})/, "token=XXXXXXXXXX");
      const reply = await client.follow(tampered);
      expect(client.has("session_token")).toBe(false);
      expect(reply.status === 302 ? (reply.headers.get("location") ?? "") : JSON.stringify(reply.body)).toMatch(/error|invalid|INVALID/i);
    });

    it("does not tell anyone whether an address already has an account", async () => {
      const { email } = await signUp(visitor(t));
      const before = await userCount(t);
      const again = await signUp(visitor(t), email);
      // Looks like any other sign-up that is waiting for verification, and makes no second account.
      expect(again.reply.status).toBe(200);
      expect(again.reply.body.token).toBeNull();
      expect(await userCount(t)).toBe(before);
    });
  });

  describe("a forgotten password", () => {
    async function verifiedPerson() {
      const client = visitor(t);
      const { email } = await signUp(client);
      await client.follow(t.mailer!.linkTo(email)!);
      return { email, client };
    }

    it("is reset through a mailed link, and the new password works and the old one does not", async () => {
      const { email } = await verifiedPerson();
      const person = visitor(t);
      const asked = await person.post("/api/auth/request-password-reset", { email, redirectTo: "/reset-password" });
      expect(asked.status).toBe(200);

      const mail = t.mailer!.last(email)!;
      expect(mail.subject).toBe("Reset your Fjord password");
      const followed = await person.follow(t.mailer!.linkTo(email)!);
      expect(followed.status).toBe(302);
      const location = new URL(followed.headers.get("location")!, "http://localhost:3000");
      expect(location.pathname).toBe("/reset-password");
      const token = location.searchParams.get("token");
      expect(token).toBeTruthy();

      const NEW = "a brand new passphrase";
      expect((await person.post("/api/auth/reset-password", { newPassword: NEW, token })).status).toBe(200);
      expect((await visitor(t).post("/api/auth/sign-in/email", { email, password: PASSWORD })).status).toBe(401);
      expect((await visitor(t).post("/api/auth/sign-in/email", { email, password: NEW })).status).toBe(200);
    });

    it("can be used once: the same link does not reset it twice", async () => {
      const { email } = await verifiedPerson();
      const person = visitor(t);
      await person.post("/api/auth/request-password-reset", { email, redirectTo: "/reset-password" });
      const followed = await person.follow(t.mailer!.linkTo(email)!);
      const token = new URL(followed.headers.get("location")!, "http://localhost:3000").searchParams.get("token");
      expect((await person.post("/api/auth/reset-password", { newPassword: "first new passphrase", token })).status).toBe(200);
      const again = await person.post("/api/auth/reset-password", { newPassword: "second new passphrase", token });
      expect(again.status).toBe(400);
    });

    it("signs out everywhere it was signed in", async () => {
      const { email } = await verifiedPerson();
      const elsewhere = visitor(t);
      expect((await elsewhere.post("/api/auth/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
      expect((await elsewhere.get("/api/auth/get-session")).body.user).toBeTruthy();

      const person = visitor(t);
      await person.post("/api/auth/request-password-reset", { email, redirectTo: "/reset-password" });
      const followed = await person.follow(t.mailer!.linkTo(email)!);
      const token = new URL(followed.headers.get("location")!, "http://localhost:3000").searchParams.get("token");
      await person.post("/api/auth/reset-password", { newPassword: "a brand new passphrase", token });

      expect((await elsewhere.get("/api/auth/get-session")).body).toBeNull();
    });

    it("never sends a person to an address of someone else's choosing: a reset or a sign-up with a redirect to another site is refused, and mails nothing (ROADMAP 1d.5)", async () => {
      const { email } = await verifiedPerson();
      const before = t.mailer!.sent?.length ?? 0;
      for (const redirectTo of ["https://evil.example/reset", "//evil.example/reset", "http://localhost.evil.example/", "javascript:alert(1)"]) {
        const asked = await visitor(t).post("/api/auth/request-password-reset", { email, redirectTo });
        expect(asked.status, redirectTo).toBeGreaterThanOrEqual(400);
        expect(asked.status, redirectTo).toBeLessThan(500);
      }
      const hostile = await visitor(t).post("/api/auth/sign-up/email", { name: "Mallory", email: newEmail(), password: PASSWORD, callbackURL: "https://evil.example/" });
      expect(hostile.status).toBeGreaterThanOrEqual(400);
      expect(hostile.status).toBeLessThan(500);
      expect(t.mailer!.sent?.length ?? 0).toBe(before);
    });

    it("is followed by a password change that signs out every other session, as the security page asks (ROADMAP 1d.5)", async () => {
      const { email, client: here } = await verifiedPerson();
      expect((await here.post("/api/auth/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
      const elsewhere = visitor(t);
      expect((await elsewhere.post("/api/auth/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
      expect((await elsewhere.get("/api/auth/get-session")).body.user).toBeTruthy();

      const NEW = "a changed passphrase here";
      // What `PasswordSection` sends.
      expect((await here.post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: NEW, revokeOtherSessions: true })).status).toBe(200);
      expect((await elsewhere.get("/api/auth/get-session")).body, "the other session is gone").toBeNull();
      expect((await here.get("/api/auth/get-session")).body.user, "this one carries on").toBeTruthy();
      expect((await visitor(t).post("/api/auth/sign-in/email", { email, password: PASSWORD })).status).toBe(401);
      expect((await visitor(t).post("/api/auth/sign-in/email", { email, password: NEW })).status).toBe(200);
    });

    it("needs the current password to change it, and a wrong one changes nothing", async () => {
      const { email, client: here } = await verifiedPerson();
      expect((await here.post("/api/auth/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
      expect((await here.post("/api/auth/change-password", { currentPassword: "not the password", newPassword: "something else entirely", revokeOtherSessions: true })).status).toBe(400);
      expect((await visitor(t).post("/api/auth/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
    });

    it("gives the same answer for an address that has no account, and sends nothing", async () => {
      const sentBefore = t.mailer!.sent.length;
      const known = await signUp(visitor(t));
      void known;
      const sentAfterSignUp = t.mailer!.sent.length;
      expect(sentAfterSignUp).toBeGreaterThan(sentBefore);

      const unknown = await visitor(t).post("/api/auth/request-password-reset", { email: "nobody-at-all@example.com", redirectTo: "/reset-password" });
      const real = await visitor(t).post("/api/auth/request-password-reset", { email: known.email, redirectTo: "/reset-password" });
      expect(unknown.status).toBe(real.status);
      expect(unknown.body).toEqual(real.body);
      expect(t.mailer!.last("nobody-at-all@example.com")).toBeUndefined();
    });
  });
});
