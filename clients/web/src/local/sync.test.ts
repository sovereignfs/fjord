import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { GitHubProvider } from "../providers/github/provider";
import type { Provider } from "../providers/types";
import { FakeGitHub } from "../providers/testing/fake-github";
import { DEFAULT_LOCAL_LIMITS } from "./limits";
import { tables } from "./provider";
import { syncToGitHub } from "./sync";

/**
 * Moving a repository from this server to a git repository, over the real databases and a GitHub whose storage is a real git repository
 * (ROADMAP 3i). What matters is the order: the server's copy is deleted only after the git repository has been seen to hold every file,
 * nothing that is in the git repository is ever overwritten, an edit made during the move is never lost, and any of it can be run again.
 */
const { leg } = testTarget();
const GOOD = "github_pat_goodtoken0123456789abcdefghijklmnopqrstuvwxyz";
const READ_ONLY = "github_pat_readonlytoken0123456789abcdefghijklmnopqrstu";
const ALICE = "user-alice";
const BOB = "user-bob";
const encode = (text: string) => new TextEncoder().encode(text);

let database: Database;
let fake: FakeGitHub;
let credentials: CredentialStore;
let service: ConnectionService;
let wrap: (provider: Provider) => Provider = (provider) => provider;

const A = () => (database.dialect === "postgres" ? postgresSchema : sqliteSchema);
const count = async (table: unknown, where = sql`1 = 1`) => Number((await dbAll<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${table as never} WHERE ${where}`))[0]!.n);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  fake = new FakeGitHub({ tokens: { [GOOD]: { push: true }, [READ_ONLY]: { push: false } } });
  await fake.start();
  credentials = new CredentialStore(database, new Keyring(randomBytes(32)));
  service = new ConnectionService({
    database,
    credentials,
    github: (token) => wrap(new GitHubProvider({ apiUrl: fake.url, token: async () => token, scope: "user", sleep: async () => undefined })),
    localLimits: { ...DEFAULT_LOCAL_LIMITS, repositories: 3 },
    now: () => 1_800_000_000_000,
  });
});
afterAll(async () => {
  await fake.stop();
  await database.close();
});
beforeEach(async () => {
  wrap = (provider) => provider;
  for (const table of [A().connection, A().credential, A().accountDefault, A().treeCache, A().workingCopy, A().localBlob, A().localCommit, A().localBranch, A().localRepository]) {
    await dbRun(database, sql`DELETE FROM ${table}`);
  }
  await fake.commitFiles({ "README.md": "# Notes\n" }, { replace: true });
});

const FILES = { "fjord.json": encode('{"fjord":"0.1"}'), "Public/a.md": encode("# A"), "Public/b.md": encode("# B") };
const make = async (files: Record<string, Uint8Array> = FILES, name = "Notes", account = ALICE) => service.addLocal(account, { name, files });
const sync = (id: number, account = ALICE, token = GOOD) => syncToGitHub(service, account, id, { repository: "acme/notes", token });

async function refused(promise: Promise<unknown>, code: ConnectionErrorCode): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isConnectionError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
  return error as Error;
}

const wholeLocalCopy = async () => (await count(A().localRepository)) + (await count(A().localBlob)) + (await count(A().localCommit)) + (await count(A().localBranch));

describe(`moving a repository from this server to git (${leg})`, () => {
  it("adds the files in one commit on the repository's head, then switches the connection to it and deletes the server's copy", async () => {
    const connection = await make();
    expect(connection).toMatchObject({ provider: "local", kind: "local", owner: "local", name: "Notes" });
    const before = (await fake.branchHead())!;

    const result = await sync(connection.id);

    expect(result).toMatchObject({ added: 3, already: 0 });
    const head = (await fake.branchHead())!;
    expect(result.commit).toBe(head);
    expect(await fake.show(head, "%P")).toBe(before);
    expect(await fake.filesAt(head)).toEqual({ "README.md": "# Notes\n", "fjord.json": '{"fjord":"0.1"}', "Public/a.md": "# A", "Public/b.md": "# B" });
    expect(await fake.show(head, "%s")).toBe("Import “Notes” from Fjord Web");
    await fake.fsck();

    // The same connection, now GitHub's: its id, its address and what hangs on it are unchanged.
    expect(result.connection).toMatchObject({ id: connection.id, publicId: connection.publicId, provider: "github", kind: "pat", owner: "acme", name: "notes", branch: "main" });
    expect(await service.list(ALICE)).toEqual([result.connection]);
    expect(await wholeLocalCopy()).toBe(0);
    expect(await count(A().credential)).toBe(1);
    // The connection reads the repository through GitHub now.
    const used = await service.provider(ALICE, connection.id);
    expect(used?.provider.name).toBe("github");
  });

  it("frees the account's allowance: what was held on the server is not any more", async () => {
    const connection = await make();
    expect((await service.localUsage(ALICE)).repositories).toBe(1);
    await sync(connection.id);
    expect(await service.localUsage(ALICE)).toMatchObject({ repositories: 0, files: 0, bytes: 0 });
  });

  it("keeps what hangs on the connection: a draft of a file, which is of the same blob in git", async () => {
    const connection = await make();
    const local = service.localProvider(ALICE);
    const head = await local.getHead({ owner: "local", name: "Notes" }, "main");
    if (!head.changed) throw new Error("head");
    const blob = (await local.getTree({ owner: "local", name: "Notes" }, head.head.commit)).entries.find((e) => e.path === "Public/a.md")!.id;
    await dbRun(
      database,
      sql`INSERT INTO ${A().workingCopy} (connection_id, path, base_blob, content, encrypted, editors, created_at, last_edit) VALUES (${connection.id}, 'Public/a.md', ${blob}, '# A, edited', 0, '[]', 1, 1)`,
    );
    const drafts = await count(A().workingCopy, sql`connection_id = ${connection.id}`);
    expect(drafts).toBeGreaterThan(0);
    await sync(connection.id);
    expect(await count(A().workingCopy, sql`connection_id = ${connection.id}`)).toBe(drafts);
    // And the blob the draft is of is what git calls it.
    const remote = await service.provider(ALICE, connection.id);
    const tree = await remote!.provider.getTree({ owner: "acme", name: "notes" }, (await fake.branchHead())!);
    expect(tree.entries.find((e) => e.path === "Public/a.md")!.id).toBe(blob);
  });

  it("keeps the token only as encrypted", async () => {
    const connection = await make();
    await sync(connection.id);
    const dump = JSON.stringify([...(await dbAll(database, sql`SELECT * FROM ${A().connection}`)), ...(await dbAll(database, sql`SELECT * FROM ${A().credential}`))]);
    expect(dump).not.toContain(GOOD);
    expect(dump).not.toContain("github_pat_");
  });

  describe("never overwrites what is there", () => {
    it("refuses when the repository has a file by the same name with other content, names it, and writes nothing and deletes nothing", async () => {
      await fake.commitFiles({ "Public/a.md": "someone else's" });
      const before = (await fake.branchHead())!;
      const connection = await make();
      const error = await refused(sync(connection.id), "would_overwrite");
      expect(error.message).toContain("Public/a.md");
      expect(error.message).not.toContain("Public/b.md");
      expect(await fake.branchHead()).toBe(before);
      expect((await fake.filesAt(before))["Public/a.md"]).toBe("someone else's");
      // Still on the server, still its own connection, and no token kept.
      expect(await service.list(ALICE)).toEqual([connection]);
      expect(await wholeLocalCopy()).toBeGreaterThan(0);
      expect(await count(A().credential)).toBe(0);
    });

    it("names only the first few of many", async () => {
      const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.md`, `theirs ${i}`]));
      await fake.commitFiles(many);
      const connection = await make(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.md`, encode(`mine ${i}`)])));
      const error = await refused(sync(connection.id), "would_overwrite");
      expect(error.message).toMatch(/and 4 more/);
    });

    it("refuses a name that differs only by case (spec §5), a folder where a file is, and a file where a folder is", async () => {
      await fake.commitFiles({ "notes.md": "x", "docs": "a file", "dir/inside.md": "y" });
      for (const path of ["Notes.md", "docs/page.md", "dir"]) {
        const connection = await make({ [path]: encode("mine") }, `R-${path.replace(/\W/g, "")}`);
        await refused(sync(connection.id), "would_overwrite");
      }
      expect(await count(A().credential)).toBe(0);
    });

    it("is not a clash when the repository has the file already with the same content, which is what a retry finds", async () => {
      await fake.commitFiles({ "Public/a.md": "# A" });
      const connection = await make();
      const result = await sync(connection.id);
      expect(result).toMatchObject({ added: 2, already: 1 });
      expect((await fake.filesAt((await fake.branchHead())!))["Public/a.md"]).toBe("# A");
    });

    it("adds the lines of its .gitattributes that the repository's lacks to the end of it, and changes nothing else of it", async () => {
      await fake.commitFiles({ ".gitattributes": "* text=auto\n" });
      const connection = await make({ ...FILES, ".gitattributes": encode("*.age binary -diff -merge\n") });
      await sync(connection.id);
      expect((await fake.filesAt((await fake.branchHead())!))[".gitattributes"]).toBe("* text=auto\n*.age binary -diff -merge\n");
    });

    it("leaves a .gitattributes that has the lines already exactly as it is", async () => {
      await fake.commitFiles({ ".gitattributes": "# mine\n*.age binary -diff -merge\n* text=auto" });
      const connection = await make({ ...FILES, ".gitattributes": encode("*.age binary -diff -merge\n") });
      const result = await sync(connection.id);
      expect(result.added).toBe(3);
      expect((await fake.filesAt((await fake.branchHead())!))[".gitattributes"]).toBe("# mine\n*.age binary -diff -merge\n* text=auto");
    });

    it("adds .gitattributes whole when the repository has none", async () => {
      const connection = await make({ ...FILES, ".gitattributes": encode("*.age binary -diff -merge\n") });
      await sync(connection.id);
      expect((await fake.filesAt((await fake.branchHead())!))[".gitattributes"]).toBe("*.age binary -diff -merge\n");
    });
  });

  describe("can be run again after any part of it", () => {
    it("finds the files there already when an earlier run got as far as the commit, makes no second commit, and finishes", async () => {
      const connection = await make();
      // What the earlier run did, and then stopped before switching.
      await fake.commitFiles({ "fjord.json": '{"fjord":"0.1"}', "Public/a.md": "# A", "Public/b.md": "# B" });
      const head = (await fake.branchHead())!;
      const result = await sync(connection.id);
      expect(result).toMatchObject({ added: 0, already: 3, commit: head });
      expect(await fake.branchHead()).toBe(head);
      expect(result.connection.provider).toBe("github");
      expect(await wholeLocalCopy()).toBe(0);
    });

    it("says it is already in git, and does nothing, when it is run on one that was moved", async () => {
      const connection = await make();
      await sync(connection.id);
      await refused(sync(connection.id), "not_local");
    });

    it("when the repository moved while the files were being copied: head_moved, nothing written, nothing deleted, and the next run goes through", async () => {
      const connection = await make();
      let moved = false;
      fake.before(/\/git\/commits$/, async () => {
        if (moved) return;
        moved = true;
        await fake.commitFiles({ "other.md": "pushed meanwhile" });
      }, "POST");
      await refused(sync(connection.id), "head_moved");
      expect(await wholeLocalCopy()).toBeGreaterThan(0);
      expect((await service.list(ALICE))[0]).toMatchObject({ provider: "local" });
      const result = await sync(connection.id);
      expect(result.added).toBe(3);
      expect((await fake.filesAt((await fake.branchHead())!))["other.md"]).toBe("pushed meanwhile");
    });
  });

  describe("never loses an edit, and never deletes before the repository has the files", () => {
    it("refuses to delete when something was committed on the server after its files were read, which then goes with the next run", async () => {
      const connection = await make();
      const ref = { owner: "local", name: "Notes" };
      const local = service.localProvider(ALICE);
      const lateEdit = async () => {
        const head = await local.getHead(ref, "main");
        if (!head.changed) throw new Error("head");
        await local.commit(ref, { branch: "main", expectedHead: head.head.commit, message: "Late edit", changes: [{ path: "Public/late.md", content: encode("typed during the move") }] });
      };
      // A hook runs once. The first request that moves a ref is the check that the token can write; the second moves the branch, which is the import being
      // written to git. Meanwhile the person saves another version here.
      fake.before(/\/git\/refs\/heads\/main$/, async () => fake.before(/\/git\/refs\/heads\/main$/, lateEdit, "PATCH"), "PATCH");
      await refused(sync(connection.id), "head_moved");

      // The late file is on the server, which is thawed and writable, and the connection is still its own.
      expect((await service.list(ALICE))[0]).toMatchObject({ provider: "local" });
      const head = await local.getHead(ref, "main");
      if (!head.changed) throw new Error("head");
      expect((await local.getTree(ref, head.head.commit)).entries.map((e) => e.path)).toContain("Public/late.md");
      expect(await count(A().credential)).toBe(0);

      // The next run imports it too, and the repository ends up with every file.
      const result = await sync(connection.id);
      expect(result.already).toBe(3);
      expect(result.added).toBe(1);
      expect((await fake.filesAt((await fake.branchHead())!))["Public/late.md"]).toBe("typed during the move");
    });

    it("does not delete when the repository cannot be read back with every file in it", async () => {
      const connection = await make();
      let lie = false;
      wrap = (provider) =>
        new Proxy(provider, {
          get(target, property, receiver) {
            if (property === "commit") {
              return async (...args: Parameters<Provider["commit"]>) => {
                const result = await target.commit(...args);
                lie = true;
                return result;
              };
            }
            if (property === "getTree") {
              return async (...args: Parameters<Provider["getTree"]>) => {
                const tree = await target.getTree(...args);
                return lie ? { ...tree, entries: tree.entries.filter((entry) => entry.path !== "Public/b.md") } : tree;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      await refused(sync(connection.id), "not_verified");
      expect(await wholeLocalCopy()).toBeGreaterThan(0);
      expect((await service.list(ALICE))[0]).toMatchObject({ provider: "local" });
      expect(await count(A().credential)).toBe(0);
    });

    it("does not delete when the commit is refused", async () => {
      const connection = await make();
      fake.fail(/\/git\/commits$/, { status: 422, body: { message: "boom" }, method: "POST", times: 1 });
      await sync(connection.id).then(
        () => expect.unreachable("it should not have gone through"),
        () => undefined,
      );
      expect(await wholeLocalCopy()).toBeGreaterThan(0);
      expect((await service.list(ALICE))[0]).toMatchObject({ provider: "local" });
      expect(await count(A().credential)).toBe(0);
    });
  });

  describe("checks the target as connecting does, and changes nothing when it is wrong", () => {
    it("a token that can read and not write", async () => {
      const connection = await make();
      const before = (await fake.branchHead())!;
      const error = await refused(sync(connection.id, ALICE, READ_ONLY), "read_only");
      expect(error.message).toMatch(/Contents: Read and write/);
      expect(await fake.branchHead()).toBe(before);
      expect(await wholeLocalCopy()).toBeGreaterThan(0);
    });

    it("a repository the account has connected already", async () => {
      await service.addWithToken(ALICE, { repository: "acme/notes", token: GOOD });
      const connection = await make();
      await refused(sync(connection.id), "already_connected");
      expect(await wholeLocalCopy()).toBeGreaterThan(0);
    });

    it("a repository with nothing in it yet", async () => {
      const connection = await make();
      const empty = new FakeGitHub({ tokens: { [GOOD]: { push: true } } });
      await empty.start();
      try {
        wrap = () => new GitHubProvider({ apiUrl: empty.url, token: async () => GOOD, scope: "user", sleep: async () => undefined });
        await refused(sync(connection.id), "empty_repository");
      } finally {
        await empty.stop();
      }
      expect(await wholeLocalCopy()).toBeGreaterThan(0);
    });

    it("a repository that is not on the server, and one that is not the account's", async () => {
      const github = await service.addWithToken(ALICE, { repository: "acme/notes", token: GOOD });
      await refused(sync(github.connection.id), "not_local");
      const connection = await make();
      await refused(sync(connection.id, BOB), "not_found");
      await refused(sync(connection.id + 1000), "not_found");
      expect((await service.list(ALICE)).find((c) => c.id === connection.id)).toMatchObject({ provider: "local" });
    });
  });

  it("is two accounts' own: one account's move never touches the other's repository of the same name", async () => {
    const alice = await make(FILES, "Notes", ALICE);
    const bob = await make({ "b.md": encode("bob's") }, "Notes", BOB);
    await sync(alice.id);
    expect((await service.list(BOB))[0]).toMatchObject({ id: bob.id, provider: "local", name: "Notes" });
    const left = await dbAll<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${tables(database).repository}`);
    expect(Number(left[0]!.n)).toBe(1);
    expect(await wholeLocalCopy()).toBeGreaterThan(0);
  });
});
