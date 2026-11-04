import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TreeCache } from "../browse/tree-cache";
import { readRepository } from "../browse/repository";
import { type ConnectionErrorCode, isConnectionError } from "../connections/errors";
import { ConnectionService } from "../connections/service";
import { Keyring } from "../crypto/keyring";
import { CredentialStore } from "../crypto/store";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import { createLocalRepository } from "./create";
import { DEFAULT_LOCAL_LIMITS } from "./limits";

/**
 * Making a repository on this server and using it as any other connection (ROADMAP 3i), over the real databases and the real format module:
 * that what is made is the plan `fjord-core` makes for a drive or a journal, that it is read back as one, that the limits are told in words,
 * and that removing it, or an account's allowance, is exact.
 */
const { leg } = testTarget();
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);
const ALICE = "user-alice";
const BOB = "user-bob";

let database: Database;
let service: ConnectionService;
const A = () => (database.dialect === "postgres" ? postgresSchema : sqliteSchema);
const count = async (table: unknown, where = sql`1 = 1`) => Number((await dbAll<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${table as never} WHERE ${where}`))[0]!.n);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  service = new ConnectionService({
    database,
    credentials: new CredentialStore(database, new Keyring(randomBytes(32))),
    github: () => {
      throw new Error("no GitHub in this test");
    },
    localLimits: { ...DEFAULT_LOCAL_LIMITS, repositories: 3 },
    now: () => 1_800_000_000_000,
  });
});
afterAll(async () => database.close());
beforeEach(async () => {
  for (const table of [A().connection, A().accountDefault, A().treeCache, A().localBlob, A().localCommit, A().localBranch, A().localRepository]) await dbRun(database, sql`DELETE FROM ${table}`);
});

const deps = () => ({ service, format: fjord() });
async function refused(promise: Promise<unknown>, code: ConnectionErrorCode): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isConnectionError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
  return error as Error;
}

describe.runIf(available)(`a repository made on this server (${leg})`, () => {
  it("is a drive: fjord-core's plan, one vault with a starter note, read back as a drive", async () => {
    const connection = await createLocalRepository(deps(), ALICE, { name: "Notes", kind: "drive" });
    expect(connection).toMatchObject({ provider: "local", kind: "local", owner: "local", name: "Notes", branch: "main", isDefault: true, repoKind: null });
    expect(connection.address).toMatch(/^drive\/[0-9a-hjkmnp-tv-z]{8}$/);

    const used = (await service.provider(ALICE, connection.id))!;
    const read = await readRepository({ provider: used.provider, cache: new TreeCache(database), format: fjord() }, { id: connection.id, ref: { owner: connection.owner, name: connection.name }, branch: connection.branch });
    expect(read.manifest?.ok && read.manifest.kind).toBe("drive");
    expect(read.discovery.vaults.map((vault) => vault.directory)).toEqual(["Public"]);
    const paths = [...read.blobs.keys()];
    expect(paths).toEqual(expect.arrayContaining(["fjord.json", ".gitattributes"]));
    expect(paths.some((path) => path.startsWith("Public/") && path.endsWith(".md"))).toBe(true);
  });

  it("is a journal when asked for one, with its one vault", async () => {
    const connection = await createLocalRepository(deps(), ALICE, { name: "Diary", kind: "journal" });
    const used = (await service.provider(ALICE, connection.id))!;
    const read = await readRepository({ provider: used.provider, cache: new TreeCache(database), format: fjord() }, { id: connection.id, ref: { owner: connection.owner, name: connection.name }, branch: connection.branch });
    expect(read.manifest?.ok && read.manifest.kind).toBe("journal");
    expect(read.discovery.vaults.map((vault) => vault.directory)).toEqual(["journal"]);
  });

  it("takes the first as the account's default and not the ones after, and lists them as connections", async () => {
    const first = await createLocalRepository(deps(), ALICE, { name: "One", kind: "drive" });
    const second = await createLocalRepository(deps(), ALICE, { name: "Two", kind: "journal" });
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect((await service.list(ALICE)).map((c) => [c.name, c.provider, c.kind])).toEqual([["One", "local", "local"], ["Two", "local", "local"]]);
    expect(await service.list(BOB)).toEqual([]);
    expect(await service.get(BOB, first.id)).toBeUndefined();
  });

  it("can be told apart from a GitHub connection by `providerForShare` and `provider`, and is read with its owner's allowance", async () => {
    const connection = await createLocalRepository(deps(), ALICE, { name: "Notes", kind: "drive" });
    expect((await service.provider(ALICE, connection.id))!.provider.name).toBe("local");
    expect((await service.providerForShare(connection.id))!.provider.name).toBe("local");
    expect((await service.provider(BOB, connection.id))).toBeUndefined();
  });

  it("is refused with the limit that was reached, and nothing is left of what was refused", async () => {
    for (const name of ["One", "Two", "Three"]) await createLocalRepository(deps(), ALICE, { name, kind: "drive" });
    const error = await refused(createLocalRepository(deps(), ALICE, { name: "Four", kind: "drive" }), "limit_reached");
    expect(error.message).toMatch(/3 repositories/);
    expect(error.message).toMatch(/connect one to a git repository/i);
    expect(await count(A().connection, sql`account_id = ${ALICE}`)).toBe(3);
    expect(await count(A().localRepository, sql`account_id = ${ALICE}`)).toBe(3);
    // Someone else has their own three.
    await createLocalRepository(deps(), BOB, { name: "One", kind: "drive" });
  });

  it("is refused when the instance keeps none", async () => {
    const off = new ConnectionService({ database, credentials: new CredentialStore(database, new Keyring(randomBytes(32))), github: () => { throw new Error("no"); }, localLimits: { ...DEFAULT_LOCAL_LIMITS, repositories: 0 } });
    const error = await refused(createLocalRepository({ service: off, format: fjord() }, ALICE, { name: "One", kind: "drive" }), "limit_reached");
    expect(error.message).toMatch(/does not keep repositories on the server/);
    expect(await count(A().localRepository)).toBe(0);
  });

  it("is refused a name that cannot be used or that the account has, saying so", async () => {
    await refused(createLocalRepository(deps(), ALICE, { name: "   ", kind: "drive" }), "invalid_name");
    await refused(createLocalRepository(deps(), ALICE, { name: "a/b", kind: "drive" }), "invalid_name");
    await refused(createLocalRepository(deps(), ALICE, { name: ".hidden", kind: "drive" }), "invalid_name");
    await createLocalRepository(deps(), ALICE, { name: "Notes", kind: "drive" });
    const error = await refused(createLocalRepository(deps(), ALICE, { name: "notes", kind: "journal" }), "invalid_name");
    expect(error.message).toContain("already have");
    expect(await count(A().connection)).toBe(1);
    expect(await count(A().localRepository)).toBe(1);
  });

  it("trims the name it is given", async () => {
    expect((await createLocalRepository(deps(), ALICE, { name: "  Notes  ", kind: "drive" })).name).toBe("Notes");
  });

  it("is deleted entirely when it is removed, which frees the allowance, and the others are not touched", async () => {
    const one = await createLocalRepository(deps(), ALICE, { name: "One", kind: "drive" });
    await createLocalRepository(deps(), ALICE, { name: "Two", kind: "drive" });
    const before = await service.localUsage(ALICE);
    expect(before.repositories).toBe(2);
    expect(await service.remove(ALICE, one.id)).toBe(true);
    expect(await service.localUsage(ALICE)).toMatchObject({ repositories: 1 });
    expect(await count(A().localRepository, sql`name = 'One'`)).toBe(0);
    for (const table of [A().localBlob, A().localCommit, A().localBranch]) expect(await count(table, sql`repository_id NOT IN (SELECT id FROM ${A().localRepository})`)).toBe(0);
    expect(await count(A().localBlob)).toBeGreaterThan(0);
    // Another account cannot delete it, and it is not "its" connection.
    const two = (await service.list(ALICE))[0]!;
    expect(await service.remove(BOB, two.id)).toBe(false);
    expect(await count(A().localRepository)).toBe(1);
  });

  it("says how much is used and what the limits are", async () => {
    await createLocalRepository(deps(), ALICE, { name: "One", kind: "drive" });
    const usage = await service.localUsage(ALICE);
    expect(usage).toMatchObject({ repositories: 1, limits: { repositories: 3, files: 2000, bytes: 50 * 1024 * 1024 } });
    expect(usage.files).toBeGreaterThan(1);
    expect(usage.bytes).toBeGreaterThan(0);
    expect(await service.localUsage(BOB)).toMatchObject({ repositories: 0, files: 0, bytes: 0 });
  });
});
