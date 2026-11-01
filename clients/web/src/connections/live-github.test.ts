import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keyring } from "../crypto/keyring";
import { CredentialStore } from "../crypto/store";
import type { Database } from "../db/client";
import { dbAll } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase } from "../db/test-support";
import { GitHubProvider } from "../providers/github/provider";
import { type ConnectionErrorCode, isConnectionError } from "./errors";
import { ConnectionService } from "./service";

/**
 * Connecting a repository with a fine-grained personal access token, against the **real** GitHub (ROADMAP 1a.7). Everything else tests the connection against a
 * git-backed fake of GitHub's API; this is the one check that GitHub itself says what the fake says: that a token with "Contents: Read and write" passes the
 * no-change write the service tries (`canWrite`: the branch "moved" to where it already is), that one with "Contents: Read-only" is refused as read-only, and that a
 * wrong token and a repository the token cannot see are told apart. It writes nothing to the repository.
 *
 * It is skipped unless it is given a repository and tokens, so it never runs in CI or by accident. To run it, make two fine-grained tokens for **one repository you own**,
 * then (the tokens are read without being echoed or put in your shell history):
 *
 *     read -rs FJORD_LIVE_TOKEN_RW && export FJORD_LIVE_TOKEN_RW      # Contents: Read and write, Metadata: Read-only
 *     read -rs FJORD_LIVE_TOKEN_RO && export FJORD_LIVE_TOKEN_RO      # Contents: Read-only,       Metadata: Read-only
 *     FJORD_LIVE_REPO=owner/name pnpm exec vitest run src/connections/live-github.test.ts
 *
 * `FJORD_LIVE_API` names another API address (GitHub Enterprise Server). Nothing it prints holds a token: failures name the step, never the value.
 */
const repository = process.env.FJORD_LIVE_REPO;
const rw = process.env.FJORD_LIVE_TOKEN_RW;
const ro = process.env.FJORD_LIVE_TOKEN_RO;
const api = process.env.FJORD_LIVE_API ?? "https://api.github.com";
const ready = Boolean(repository && rw && ro);
if (!ready) console.warn("[fjord] live GitHub check skipped: FJORD_LIVE_REPO, FJORD_LIVE_TOKEN_RW and FJORD_LIVE_TOKEN_RO are not all set (see src/connections/live-github.test.ts)");

let database: Database;
let credentials: CredentialStore;
let service: ConnectionService;
const connectionTable = () => (database.dialect === "postgres" ? postgresSchema.connection : sqliteSchema.connection);
const credentialTable = () => (database.dialect === "postgres" ? postgresSchema.credential : sqliteSchema.credential);

const codeOf = async (attempt: Promise<unknown>): Promise<ConnectionErrorCode | "no error"> =>
  attempt.then(
    () => "no error" as const,
    (error: unknown) => (isConnectionError(error) ? (error.code as ConnectionErrorCode) : (`unexpected ${error instanceof Error ? error.name : "failure"}` as never)),
  );

beforeAll(async () => {
  if (!ready) return;
  ({ database } = await freshDatabase());
  await runMigrations(database);
  credentials = new CredentialStore(database, new Keyring(randomBytes(32)));
  service = new ConnectionService({ database, credentials, github: (token) => new GitHubProvider({ apiUrl: api, token: async () => token, scope: "user" }) });
});
afterAll(async () => database?.close());

describe.skipIf(!ready)("a fine-grained token, against the real GitHub", () => {
  it("is refused with the read-only message when it can read the repository but not write to it, and nothing is kept", async () => {
    const error = await service.addWithToken("live-account", { repository: repository as string, token: ro as string }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(isConnectionError(error), `expected a connection error, got ${String(error)}`).toBe(true);
    expect((error as { code: string }).code).toBe("read_only");
    expect((error as Error).message).toMatch(/Contents: Read and write/);
    expect(await dbAll(database, sql`SELECT * FROM ${connectionTable()}`)).toEqual([]);
    expect(await dbAll(database, sql`SELECT * FROM ${credentialTable()}`)).toEqual([]);
  });

  it("connects when it can write, changes nothing in the repository, and keeps the token only sealed", async () => {
    const provider = new GitHubProvider({ apiUrl: api, token: async () => rw as string, scope: "user" });
    const { ref, defaultBranch } = await provider.getRepository({ owner: (repository as string).split("/")[0] as string, name: (repository as string).split("/")[1] as string });
    const before = await provider.getHead(ref, defaultBranch);

    const added = await service.addWithToken("live-account", { repository: repository as string, token: rw as string });
    expect(`${added.connection.owner}/${added.connection.name}`.toLowerCase()).toBe((repository as string).toLowerCase());
    expect(added.connection).toMatchObject({ branch: defaultBranch, isDefault: true });

    // The no-change write did not move the branch.
    const after = await provider.getHead(ref, defaultBranch);
    expect(before.changed && after.changed && after.head.commit).toBe(before.changed && before.head.commit);

    // The token is in the database only as an envelope: nowhere in any column.
    const everything = JSON.stringify([...(await dbAll(database, sql`SELECT * FROM ${connectionTable()}`)), ...(await dbAll(database, sql`SELECT * FROM ${credentialTable()}`))]);
    expect(everything.includes(rw as string)).toBe(false);
    expect(everything.includes((rw as string).slice(-12))).toBe(false);

    // And it can be used to read the repository's tree through the stored credential.
    const used = await service.provider("live-account", added.connection.id);
    expect(used).toBeDefined();
    const tree = await used!.provider.getTree(ref, (after.changed ? after.head.commit : "") as string);
    expect(tree.entries.length).toBeGreaterThan(0);
  });

  it("is told apart from a token GitHub does not know, and from a repository the token cannot see", async () => {
    const stranger = "github_pat_" + "x".repeat(70);
    expect(await codeOf(service.addWithToken("live-account-2", { repository: repository as string, token: stranger }))).toBe("bad_token");
    expect(await codeOf(service.addWithToken("live-account-2", { repository: `${(repository as string).split("/")[0]}/fjord-no-such-repository-${Date.now()}`, token: rw as string }))).toBe("not_found");
  });
});
