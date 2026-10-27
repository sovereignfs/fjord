import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { MAX_SHARES_PER_DOCUMENT, ShareService } from "./shares";

/** Documents shared with named accounts, over the real databases. */
const { leg } = testTarget();
let database: Database;
let shares: ShareService;
let clock = 1_800_000_000_000;
const table = () => (database.dialect === "postgres" ? postgresSchema.shareUser : sqliteSchema.shareUser);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  shares = new ShareService(database, () => clock++);
});
afterAll(async () => database.close());
beforeEach(async () => dbRun(database, sql`DELETE FROM ${table()}`));

const A = "01jagc4k7pt8y3wqnmzv5xrb8j";
const B = "01jagc4k7pt8y3wqnmzv5xrb9k";

describe(`shares with named accounts (${leg})`, () => {
  it("records who has which role on a document, oldest first, and by whom", async () => {
    expect(await shares.set(1, A, "bob", "view", "alice")).toBe("ok");
    expect(await shares.set(1, A, "carol", "edit", "alice")).toBe("ok");
    expect((await shares.list(1, A)).map(({ accountId, role }) => [accountId, role])).toEqual([["bob", "view"], ["carol", "edit"]]);
    expect(await shares.list(1, B)).toEqual([]);
    expect(await shares.list(2, A)).toEqual([]);
  });

  it("changes the role of an account it is already shared with, and keeps one row", async () => {
    await shares.set(1, A, "bob", "view", "alice");
    await shares.set(1, A, "bob", "comment", "alice");
    expect((await shares.list(1, A)).map(({ accountId, role }) => [accountId, role])).toEqual([["bob", "comment"]]);
  });

  it("stops sharing, and says whether there was anything to stop", async () => {
    await shares.set(1, A, "bob", "view", "alice");
    expect(await shares.remove(1, A, "carol")).toBe(false);
    expect(await shares.remove(2, A, "bob")).toBe(false);
    expect(await shares.remove(1, A, "bob")).toBe(true);
    expect(await shares.remove(1, A, "bob")).toBe(false);
    expect(await shares.list(1, A)).toEqual([]);
  });

  it("finds what an account holds on a document and everything shared with it, newest first", async () => {
    await shares.set(1, A, "bob", "view", "alice");
    await shares.set(2, A, "bob", "edit", "dave");
    await shares.set(1, B, "bob", "comment", "alice");
    await shares.set(1, B, "carol", "view", "alice");
    expect(await shares.find("bob", A)).toEqual([{ connectionId: 1, role: "view", sharedBy: "alice" }, { connectionId: 2, role: "edit", sharedBy: "dave" }]);
    expect(await shares.find("carol", A)).toEqual([]);
    expect(await shares.forAccount("bob")).toEqual([
      { connectionId: 1, docId: B, role: "comment" },
      { connectionId: 2, docId: A, role: "edit" },
      { connectionId: 1, docId: A, role: "view" },
    ]);
  });

  it("allows a document to be shared with only so many, and still lets one of them change role", async () => {
    for (let i = 0; i < MAX_SHARES_PER_DOCUMENT; i++) expect(await shares.set(1, A, `account-${i}`, "view", "alice")).toBe("ok");
    expect(await shares.set(1, A, "one-too-many", "view", "alice")).toBe("too_many");
    expect(await shares.set(1, A, "account-3", "edit", "alice")).toBe("ok");
    expect(await shares.set(1, B, "one-too-many", "view", "alice")).toBe("ok");
    expect((await shares.list(1, A)).find((share) => share.accountId === "account-3")?.role).toBe("edit");
  });

  it("forgets a connection's shares and no other's", async () => {
    await shares.set(1, A, "bob", "view", "alice");
    await shares.set(2, A, "bob", "view", "alice");
    await shares.forget(1);
    expect(await shares.list(1, A)).toEqual([]);
    expect(await shares.list(2, A)).toHaveLength(1);
  });
});
