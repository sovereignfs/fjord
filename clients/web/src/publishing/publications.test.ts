import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { TOKEN_PATTERN, hashToken } from "../sharing/tokens";
import { PublicationService, copyKey } from "./publications";

const { leg } = testTarget();
let database: Database;
let publications: PublicationService;
const table = () => (database.dialect === "postgres" ? postgresSchema.publication : sqliteSchema.publication);
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const OTHER = "01jagc4k7pt8y3wqnmzv5xrb9k";

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  publications = new PublicationService(database, () => 1_800_000_000_000);
});
afterAll(async () => database.close());
beforeEach(async () => dbRun(database, sql`DELETE FROM ${table()}`));

describe(`published pages (${leg})`, () => {
  it("makes an address of a token that opens the Doc, and keeps only the token's hash", async () => {
    const { token } = await publications.publish(1, DOC, "alice");
    expect(token).toMatch(TOKEN_PATTERN);
    expect(await publications.find(token)).toMatchObject({ connectionId: 1, docId: DOC, createdBy: "alice", passwordHash: null, comments: "off" });
    const rows = await dbAll<Record<string, unknown>>(database, sql`SELECT * FROM ${table()}`);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).toContain(hashToken(token));
    expect(await publications.status(1, DOC)).toEqual({ publishedAt: 1_800_000_000_000, passwordProtected: false, comments: "off" });
  });

  it("opens nothing for a token that was never made, or is not one", async () => {
    await publications.publish(1, DOC, "alice");
    for (const token of ["", "x", "a".repeat(43), hashToken("anything")]) expect(await publications.find(token), token).toBeUndefined();
  });

  it("publishes again to a new address and ends the old one", async () => {
    const first = await publications.publish(1, DOC, "alice");
    const second = await publications.publish(1, DOC, "alice");
    expect(second.token).not.toBe(first.token);
    expect(await publications.find(first.token)).toBeUndefined();
    expect(await publications.find(second.token)).toMatchObject({ connectionId: 1, docId: DOC });
  });

  it("publishes a copy of an encrypted file under its path, hands the copy back with the address, and ends it like any other", async () => {
    const { token } = await publications.publishCopy(1, "Secret/Plan.md.age", "alice", { title: "Q4 plan", body: "# Q4 plan\n" });
    expect(await publications.find(token)).toMatchObject({ connectionId: 1, docId: "file:Secret/Plan.md.age", copy: { title: "Q4 plan", body: "# Q4 plan\n" } });
    expect(copyKey("Secret/Plan.md.age")).toBe("file:Secret/Plan.md.age");
    expect(await publications.status(1, copyKey("Secret/Plan.md.age"))).toMatchObject({ publishedAt: 1_800_000_000_000 });
    // Publishing it again ends the old address and replaces the copy.
    const again = await publications.publishCopy(1, "Secret/Plan.md.age", "alice", { title: "Q4 plan", body: "Newer.\n" });
    expect(await publications.find(token)).toBeUndefined();
    expect((await publications.find(again.token))?.copy?.body).toBe("Newer.\n");
    // A Doc of a plaintext vault carries no copy.
    const plain = await publications.publish(1, DOC, "alice");
    expect((await publications.find(plain.token))?.copy).toBeUndefined();
    expect(await publications.unpublish(1, copyKey("Secret/Plan.md.age"))).toBe(true);
    expect(await publications.find(again.token)).toBeUndefined();
  });

  it("unpublishes at once, and says whether there was an address; one Doc's ending leaves another's", async () => {
    const mine = await publications.publish(1, DOC, "alice");
    const theirs = await publications.publish(1, OTHER, "alice");
    const elsewhere = await publications.publish(2, DOC, "bob");
    expect(await publications.unpublish(1, DOC)).toBe(true);
    expect(await publications.unpublish(1, DOC)).toBe(false);
    expect(await publications.find(mine.token)).toBeUndefined();
    expect(await publications.status(1, DOC)).toBeUndefined();
    expect(await publications.find(theirs.token)).toMatchObject({ connectionId: 1, docId: OTHER });
    expect(await publications.find(elsewhere.token)).toMatchObject({ connectionId: 2, docId: DOC });
  });
});
