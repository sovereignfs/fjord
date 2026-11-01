import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { MAX_SEALED_PER_FILE, SealedShareService } from "./service";

/** Sealed copies over the real databases (ROADMAP 2c.1): only a hash of the token is kept, the token opens its copy and nothing else, and revoking deletes the copy. */
const { leg } = testTarget();
let database: Database;
let service: SealedShareService;
const table = () => (database.dialect === "postgres" ? postgresSchema.sealedShare : sqliteSchema.sealedShare);
const COPY = Buffer.from("age-encryption.org/v1\n-> X25519 abc\nbody").toString("base64");

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  service = new SealedShareService(database, { now: () => 1_800_000_000_000 });
});
afterAll(async () => database.close());
beforeEach(async () => dbRun(database, sql`DELETE FROM ${table()}`));

const make = async (over: Partial<Parameters<SealedShareService["create"]>[1]> = {}, connection = 1) => {
  const made = await service.create(connection, { path: "Secret/a.md.age", mode: "key", ciphertext: COPY, createdBy: "alice", ...over });
  if (!made.ok) throw new Error(made.reason);
  return made;
};

describe(`sealed shares (${leg})`, () => {
  it("gives the token once, and the token opens the copy that was kept and its mode", async () => {
    const { token, record } = await make({ mode: "password" });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record).toMatchObject({ connectionId: 1, path: "Secret/a.md.age", mode: "password", createdAt: 1_800_000_000_000 });
    expect(await service.byToken(token)).toEqual({ mode: "password", ciphertext: COPY, createdAt: 1_800_000_000_000 });
  });

  it("keeps only a hash of the token, never the token", async () => {
    const { token } = await make();
    const dump = JSON.stringify(await dbAll(database, sql`SELECT * FROM ${table()}`));
    expect(dump).not.toContain(token);
    expect(dump).toContain(COPY);
  });

  it("finds nothing for a token that is not one, is wrong, or whose copy was revoked: the row is gone", async () => {
    const { token, record } = await make();
    for (const other of ["", "short", `${token.slice(0, 42)}${token.endsWith("A") ? "B" : "A"}`, `${token}x`]) expect(await service.byToken(other), other).toBeUndefined();
    expect(await service.revoke(1, record.id)).toBe(true);
    expect(await service.byToken(token)).toBeUndefined();
    expect(await dbAll(database, sql`SELECT * FROM ${table()}`)).toEqual([]);
    expect(await service.revoke(1, record.id)).toBe(false);
  });

  it("revokes only a share of the connection asked, never another's", async () => {
    const mine = await make({}, 1);
    const theirs = await make({}, 2);
    expect(await service.revoke(2, mine.record.id)).toBe(false);
    expect(await service.byToken(mine.token)).toBeDefined();
    expect(await service.revoke(2, theirs.record.id)).toBe(true);
  });

  it("lists one file's shares, newest first, without the copy", async () => {
    const first = await make();
    const second = await make();
    await make({ path: "Secret/b.md.age" });
    const listed = await service.list(1, "Secret/a.md.age");
    expect(listed.map((record) => record.id)).toEqual([second.record.id, first.record.id]);
    expect(JSON.stringify(listed)).not.toContain(COPY);
  });

  it("is bounded for a file", async () => {
    for (let i = 0; i < MAX_SEALED_PER_FILE; i++) await make();
    expect(await service.create(1, { path: "Secret/a.md.age", mode: "key", ciphertext: COPY, createdBy: "alice" })).toEqual({ ok: false, reason: "too_many_for_file" });
    expect((await service.create(1, { path: "Secret/other.md.age", mode: "key", ciphertext: COPY, createdBy: "alice" })).ok).toBe(true);
  });

  it("goes with the repository", async () => {
    const { token } = await make();
    await service.forget(1);
    expect(await service.byToken(token)).toBeUndefined();
  });
});
