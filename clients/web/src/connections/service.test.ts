import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Keyring } from "../crypto/keyring";
import { CredentialStore } from "../crypto/store";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { GitHubProvider } from "../providers/github/provider";
import { MemoryProvider } from "../providers/memory";
import { FakeGitHub } from "../providers/testing/fake-github";
import { type ConnectionErrorCode, isConnectionError } from "./errors";
import { ConnectionService } from "./service";

/**
 * Connecting a repository with a token, over the real databases and against a GitHub whose storage
 * is a real git repository: that a token is checked before anything is kept, that a token that
 * fails the check leaves nothing behind, and that what is kept is encrypted and belongs to one
 * account.
 */
const { leg } = testTarget();
let database: Database;
let fake: FakeGitHub;
let credentials: CredentialStore;
let service: ConnectionService;

const GOOD = "github_pat_goodtoken0123456789abcdefghijklmnopqrstuvwxyz";
const READ_ONLY = "github_pat_readonlytoken0123456789abcdefghijklmnopqrstu";
const REVOKED = "github_pat_revokedtoken0123456789abcdefghijklmnopqrstu";
const ALICE = "user-alice";
const BOB = "user-bob";

const connectionTable = () => (database.dialect === "postgres" ? postgresSchema.connection : sqliteSchema.connection);
const credentialTable = () => (database.dialect === "postgres" ? postgresSchema.credential : sqliteSchema.credential);
const count = async (table: unknown) => Number((await dbAll<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${table as never}`))[0]!.n);
const everything = async () => JSON.stringify([...(await dbAll(database, sql`SELECT * FROM ${connectionTable()}`)), ...(await dbAll(database, sql`SELECT * FROM ${credentialTable()}`))]);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  fake = new FakeGitHub({ tokens: { [GOOD]: { push: true }, [READ_ONLY]: { push: false } } });
  await fake.start();
  credentials = new CredentialStore(database, new Keyring(randomBytes(32)));
  service = new ConnectionService({
    database,
    credentials,
    github: (token) => new GitHubProvider({ apiUrl: fake.url, token: async () => token, scope: "user", sleep: async () => undefined }),
    now: () => 1_800_000_000_000,
  });
});
afterAll(async () => {
  await fake.stop();
  await database.close();
});
beforeEach(async () => {
  await dbRun(database, sql`DELETE FROM ${connectionTable()}`);
  await dbRun(database, sql`DELETE FROM ${credentialTable()}`);
  await fake.commitFiles({ "fjord.json": "{}" }, { replace: true });
});

async function refused(promise: Promise<unknown>, code: ConnectionErrorCode): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isConnectionError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
  return error as Error;
}

describe(`connecting with a token (${leg})`, () => {
  it("keeps a repository the token can read and write", async () => {
    const { connection, warnings } = await service.addWithToken(ALICE, { repository: "https://github.com/acme/notes", token: GOOD });
    expect(connection).toEqual({ id: expect.any(Number), provider: "github", kind: "pat", owner: "acme", name: "notes", branch: "main", createdAt: 1_800_000_000_000 });
    expect(warnings).toEqual([]);
    expect(await service.list(ALICE)).toEqual([connection]);
  });

  it("keeps the token only as encrypted, and not in any column of either table", async () => {
    await service.addWithToken(ALICE, { repository: "acme/notes", token: GOOD });
    const dump = await everything();
    expect(dump).not.toContain(GOOD);
    expect(dump).not.toContain("github_pat_");
    expect(await count(credentialTable())).toBe(1);
  });

  it("changes nothing in the repository to find out that the token can write", async () => {
    const before = await fake.branchHead();
    fake.requests.length = 0;
    await service.addWithToken(ALICE, { repository: "acme/notes", token: GOOD });
    expect(await fake.branchHead()).toBe(before);
    await fake.fsck();
    // Looked, and made a no-op update, and never forced it.
    const writes = fake.requests.filter((r) => r.method !== "GET");
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual(["PATCH /repos/acme/notes/git/refs/heads/main"]);
    expect(writes[0]!.body).toMatchObject({ force: false });
  });

  it("uses the repository's own spelling of its name, however it was typed", async () => {
    const { connection } = await service.addWithToken(ALICE, { repository: "git@github.com:acme/notes.git", token: GOOD });
    expect(connection).toMatchObject({ owner: "acme", name: "notes" });
  });

  describe("refuses, in words a person can act on, and keeps nothing", () => {
    const nothingKept = async () => {
      expect(await count(connectionTable())).toBe(0);
      expect(await count(credentialTable())).toBe(0);
    };

    it("a token that can read but not write", async () => {
      const error = await refused(service.addWithToken(ALICE, { repository: "acme/notes", token: READ_ONLY }), "read_only");
      expect(error.message).toMatch(/Contents: Read and write/);
      await nothingKept();
    });

    it("a token GitHub does not accept", async () => {
      const error = await refused(service.addWithToken(ALICE, { repository: "acme/notes", token: REVOKED }), "bad_token");
      expect(error.message).toMatch(/expired or been revoked/);
      await nothingKept();
    });

    it("a repository the token cannot see", async () => {
      const error = await refused(service.addWithToken(ALICE, { repository: "acme/secret", token: GOOD }), "not_found");
      expect(error.message).toMatch(/given access to this repository/);
      await nothingKept();
    });

    it("an address that is not a repository, and an address on another host", async () => {
      await refused(service.addWithToken(ALICE, { repository: "https://github.com/acme", token: GOOD }), "invalid_repository");
      await refused(service.addWithToken(ALICE, { repository: "https://gitlab.com/acme/notes", token: GOOD }), "unsupported_host");
      await nothingKept();
    });

    it("an empty token, and one that is not in one piece", async () => {
      await refused(service.addWithToken(ALICE, { repository: "acme/notes", token: "   " }), "invalid_token");
      await refused(service.addWithToken(ALICE, { repository: "acme/notes", token: "two words" }), "invalid_token");
      await refused(service.addWithToken(ALICE, { repository: "acme/notes", token: "x".repeat(2000) }), "invalid_token");
      await nothingKept();
    });

    it("a repository with nothing in it yet", async () => {
      const empty = new FakeGitHub({ tokens: { [GOOD]: { push: true } } });
      await empty.start();
      try {
        const onEmpty = new ConnectionService({
          database,
          credentials,
          github: (token) => new GitHubProvider({ apiUrl: empty.url, token: async () => token, scope: "user", sleep: async () => undefined }),
        });
        const error = await refused(onEmpty.addWithToken(ALICE, { repository: "acme/notes", token: GOOD }), "empty_repository");
        expect(error.message).toMatch(/README/);
        await nothingKept();
      } finally {
        await empty.stop();
      }
    });

    it("a repository this account has already connected, without a second copy of the token", async () => {
      await service.addWithToken(ALICE, { repository: "acme/notes", token: GOOD });
      await refused(service.addWithToken(ALICE, { repository: "https://github.com/acme/notes", token: GOOD }), "already_connected");
      expect(await count(connectionTable())).toBe(1);
      expect(await count(credentialTable())).toBe(1);
    });

    it("when GitHub is down or limiting, and says so plainly", async () => {
      fake.fail(/\/repos\/acme\/notes$/, { status: 503, body: { message: "Service Unavailable" }, times: 3 });
      await refused(service.addWithToken(ALICE, { repository: "acme/notes", token: GOOD }), "unavailable");
      fake.fail(/\/repos\/acme\/notes$/, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) }, body: { message: "API rate limit exceeded" } });
      await refused(service.addWithToken(ALICE, { repository: "acme/notes", token: GOOD }), "rate_limited");
      await nothingKept();
    });

    it("without ever putting the token, or anything of GitHub's text, in the message", async () => {
      for (const [repository, token] of [
        ["acme/notes", READ_ONLY],
        ["acme/notes", REVOKED],
        ["acme/secret", GOOD],
      ] as const) {
        const error = await service.addWithToken(ALICE, { repository, token }).catch((e: unknown) => e as Error);
        expect((error as Error).message).not.toContain(token);
        expect((error as Error).message).not.toMatch(/Bad credentials|Resource not accessible|documentation/i);
      }
    });
  });

  it("warns, and still connects, when the token reaches other repositories too", async () => {
    const memory = new MemoryProvider();
    memory.createRepository({ owner: "acme", name: "notes" });
    memory.seed({ owner: "acme", name: "notes" }, { "fjord.json": "{}" });
    memory.createRepository({ owner: "acme", name: "other-one" });
    memory.createRepository({ owner: "acme", name: "other-two" });
    const broad = new ConnectionService({ database, credentials, github: () => memory });
    const { connection, warnings } = await broad.addWithToken(ALICE, { repository: "acme/notes", token: GOOD });
    expect(connection.name).toBe("notes");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/2 other repositories/);
    expect(warnings[0]).not.toContain(GOOD);
  });

  it("refuses a repository the memory provider says is read-only, as it does a real one", async () => {
    const memory = new MemoryProvider();
    memory.createRepository({ owner: "acme", name: "notes" }, { canPush: false });
    memory.seed({ owner: "acme", name: "notes" }, { "a.md": "a" });
    const readOnly = new ConnectionService({ database, credentials, github: () => memory });
    await refused(readOnly.addWithToken(ALICE, { repository: "acme/notes", token: GOOD }), "read_only");
  });

  it("does not leave a token behind when it cannot record the connection", async () => {
    // Everything passes and the token is stored; only recording the connection fails (a time that
    // cannot be written), so what is under test is the clean-up and not an earlier check.
    let calls = 0;
    const failing = new ConnectionService({
      database,
      credentials,
      github: (token) => new GitHubProvider({ apiUrl: fake.url, token: async () => token, scope: "user", sleep: async () => undefined }),
      now: () => (++calls === 1 ? 1_800_000_000_000 : (null as unknown as number)),
    });
    await expect(failing.addWithToken(ALICE, { repository: "acme/notes", token: GOOD })).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(2);
    expect(await count(connectionTable())).toBe(0);
    expect(await count(credentialTable())).toBe(0);
  });
});

describe(`using and removing a connection (${leg})`, () => {
  it("gives the server a provider that works with the stored token, and no way to read the token", async () => {
    const { connection } = await service.addWithToken(ALICE, { repository: "acme/notes", token: GOOD });
    const used = await service.provider(ALICE, connection.id);
    expect(used).toBeDefined();
    expect(Object.keys(used!.connection)).not.toContain("token");
    const head = await used!.provider.getHead(fake.ref, "main");
    expect(head.changed).toBe(true);
    expect(JSON.stringify(used!.connection)).not.toContain(GOOD);
    // The request that proved it used the token that was stored.
    expect(fake.requests.at(-1)!.headers.authorization).toBe(`Bearer ${GOOD}`);
  });

  it("shows an account only its own connections, and answers for another's as if there were none", async () => {
    const mine = (await service.addWithToken(ALICE, { repository: "acme/notes", token: GOOD })).connection;
    expect(await service.list(BOB)).toEqual([]);
    expect(await service.get(BOB, mine.id)).toBeUndefined();
    expect(await service.provider(BOB, mine.id)).toBeUndefined();
    expect(await service.remove(BOB, mine.id)).toBe(false);
    expect(await service.list(ALICE)).toEqual([mine]);
    expect(await count(credentialTable())).toBe(1);
  });

  it("lets two accounts connect the same repository, each with a token of their own", async () => {
    await service.addWithToken(ALICE, { repository: "acme/notes", token: GOOD });
    await service.addWithToken(BOB, { repository: "acme/notes", token: GOOD });
    expect(await count(connectionTable())).toBe(2);
    expect(await count(credentialTable())).toBe(2);
  });

  it("disconnects, deleting the connection and the token with it", async () => {
    const { connection } = await service.addWithToken(ALICE, { repository: "acme/notes", token: GOOD });
    expect(await service.remove(ALICE, connection.id)).toBe(true);
    expect(await service.list(ALICE)).toEqual([]);
    expect(await count(credentialTable())).toBe(0);
    expect(await service.remove(ALICE, connection.id)).toBe(false);
  });
});
