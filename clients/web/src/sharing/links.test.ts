import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { LinkService, MAX_LINKS_PER_DOCUMENT } from "./links";
import { TOKEN_PATTERN, hashToken, newToken } from "./tokens";

/** Links that open a document, over the real databases. */
const { leg } = testTarget();
let database: Database;
let links: LinkService;
let clock = 1_800_000_000_000;
const table = () => (database.dialect === "postgres" ? postgresSchema.shareLink : sqliteSchema.shareLink);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  links = new LinkService(database, { now: () => clock });
});
afterAll(async () => database.close());
beforeEach(async () => {
  clock = 1_800_000_000_000;
  await dbRun(database, sql`DELETE FROM ${table()}`);
});

const A = "01jagc4k7pt8y3wqnmzv5xrb8j";
const B = "01jagc4k7pt8y3wqnmzv5xrb9k";
const made = async (...args: Parameters<LinkService["create"]>) => {
  const result = await links.create(...args);
  if (!result.ok) throw new Error("not made");
  return result;
};

describe("a token", () => {
  it("is 43 URL-safe characters of 256 bits, different each time, and hashed one way", () => {
    const seen = new Set(Array.from({ length: 50 }, () => newToken()));
    expect(seen.size).toBe(50);
    for (const token of seen) expect(token).toMatch(TOKEN_PATTERN);
    expect(hashToken("a")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("a")).not.toBe(hashToken("b"));
    expect(hashToken("a")).toBe(hashToken("a"));
  });

  it("is not accepted unless it looks like one", () => {
    for (const bad of ["", "short", `${"a".repeat(43)}x`, "a".repeat(42), `${"a".repeat(42)}+`, `${"a".repeat(42)} `]) expect(TOKEN_PATTERN.test(bad), bad).toBe(false);
  });
});

describe(`links (${leg})`, () => {
  it("opens, by its token, the link that was made: its document, role and expiry", async () => {
    const { id, token } = await made(1, A, "comment", clock + 1000, "alice");
    expect(await links.byToken(token)).toEqual({ id, connectionId: 1, docId: A, role: "comment", expiresAt: clock + 1000, revokedAt: null, createdAt: clock, hasPassword: false, passwordHash: null, failures: 0, lockedUntil: null });
  });

  it("keeps the token nowhere: not in the row, only its hash", async () => {
    const { token } = await made(1, A, "view", null, "alice");
    const rows = await dbAll<Record<string, unknown>>(database, sql`SELECT * FROM ${table()}`);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).toContain(hashToken(token));
  });

  it("opens nothing for a token that was never made, for another's, or for one that is nearly right", async () => {
    const { token } = await made(1, A, "view", null, "alice");
    expect(await links.byToken(newToken())).toBeUndefined();
    expect(await links.byToken(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeUndefined();
    expect(await links.byToken(token.toUpperCase())).toBeUndefined();
    expect(await links.byToken(`${token}x`)).toBeUndefined();
    expect(await links.byToken(hashToken(token))).toBeUndefined(); // the hash is not the key
  });

  it("allows several for a document, each its own, listed newest first and never with a token", async () => {
    const first = await made(1, A, "view", null, "alice");
    clock += 10;
    const second = await made(1, A, "edit", clock + 5000, "alice");
    await made(1, B, "view", null, "alice");
    const listed = await links.list(1, A);
    expect(listed.map((link) => [link.id, link.role])).toEqual([[second.id, "edit"], [first.id, "view"]]);
    expect(JSON.stringify(listed)).not.toMatch(/token/i);
    expect(await links.list(2, A)).toEqual([]);
    expect((await links.byToken(first.token))?.id).toBe(first.id);
    expect((await links.byToken(second.token))?.id).toBe(second.id);
  });

  it("revokes one link and not the others, and the link says so", async () => {
    const first = await made(1, A, "view", null, "alice");
    const second = await made(1, A, "view", null, "alice");
    clock += 50;
    expect(await links.revoke(1, A, first.id)).toBe(true);
    expect((await links.byToken(first.token))?.revokedAt).toBe(clock);
    expect((await links.byToken(second.token))?.revokedAt).toBeNull();
    expect(await links.revoke(1, A, first.id)).toBe(false); // already
  });

  it("revokes only a link of that document of that connection", async () => {
    const mine = await made(1, A, "view", null, "alice");
    expect(await links.revoke(2, A, mine.id)).toBe(false);
    expect(await links.revoke(1, B, mine.id)).toBe(false);
    expect(await links.revoke(1, A, 999999)).toBe(false);
    expect((await links.byToken(mine.token))?.revokedAt).toBeNull();
  });

  it("makes only so many for one document", async () => {
    for (let i = 0; i < MAX_LINKS_PER_DOCUMENT; i++) await made(1, A, "view", null, "alice");
    expect(await links.create(1, A, "view", null, "alice")).toEqual({ ok: false, reason: "too_many" });
    expect((await links.create(1, B, "view", null, "alice")).ok).toBe(true);
  });

  it("forgets a connection's links and no other's", async () => {
    const one = await made(1, A, "view", null, "alice");
    const two = await made(2, A, "view", null, "alice");
    await links.forget(1);
    expect(await links.byToken(one.token)).toBeUndefined();
    expect(await links.byToken(two.token)).toBeDefined();
  });

  it("keeps a password's hash and says only that there is one, in a list; the hash is for the one place that checks it", async () => {
    const plain = await made(1, A, "view", null, "alice");
    const locked = await links.create(1, A, "view", null, "alice", "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$hash");
    if (!locked.ok) throw new Error("not made");
    const listed = await links.list(1, A);
    expect(listed.map((link) => [link.id, link.hasPassword])).toEqual([[locked.id, true], [plain.id, false]]);
    expect(JSON.stringify(listed)).not.toMatch(/argon|hash|failures|lockedUntil/);
    expect((await links.byToken(locked.token))?.passwordHash).toBe("$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$hash");
    expect((await links.byToken(plain.token))?.passwordHash).toBeNull();
  });
});

describe(`the tries at a link's password (${leg})`, () => {
  const protectedLink = async () => {
    const made = await links.create(1, A, "view", null, "alice", "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$hash");
    if (!made.ok) throw new Error("not made");
    return made.id;
  };

  it("lets one try be made at once, and puts the next off by a second", async () => {
    const id = await protectedLink();
    expect(await links.claimTry(id)).toEqual({ claimed: true });
    expect(await links.claimTry(id)).toEqual({ claimed: false, retryAt: clock + 1000 });
    clock += 999;
    expect((await links.claimTry(id)).claimed).toBe(false);
    clock += 1;
    expect(await links.claimTry(id)).toEqual({ claimed: true });
  });

  it("gives one try to one of several at once: they cannot be made in parallel", async () => {
    const id = await protectedLink();
    const results = await Promise.all(Array.from({ length: 12 }, () => links.claimTry(id)));
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
  });

  it("makes each wrong password lengthen the wait: a second for three, then five, ten, twenty seconds", async () => {
    const id = await protectedLink();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      expect((await links.claimTry(id)).claimed).toBe(true);
      await links.recordFailure(id);
      const next = await links.claimTry(id);
      waits.push(next.claimed ? 0 : next.retryAt - clock);
      clock += 60 * 60 * 1000; // long enough to try again
    }
    expect(waits).toEqual([1000, 1000, 5000, 10_000, 20_000, 40_000]);
  });

  it("starts again after the right password", async () => {
    const id = await protectedLink();
    for (let i = 0; i < 5; i++) {
      await links.claimTry(id);
      await links.recordFailure(id);
      clock += 60 * 60 * 1000;
    }
    await links.claimTry(id);
    await links.recordSuccess(id);
    expect(await links.claimTry(id)).toEqual({ claimed: true });
    await links.recordFailure(id);
    const next = await links.claimTry(id);
    expect(next.claimed ? 0 : next.retryAt - clock).toBe(1000);
  });

  it("is each link's own, and a link that is not there has no try to take", async () => {
    const a = await protectedLink();
    const b = await protectedLink();
    expect((await links.claimTry(a)).claimed).toBe(true);
    expect((await links.claimTry(b)).claimed).toBe(true);
    expect((await links.claimTry(999_999)).claimed).toBe(false);
  });
});
