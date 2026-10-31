import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeCache } from "../browse/tree-cache";
import { ConnectionService } from "../connections/service";
import { Keyring } from "../crypto/keyring";
import { CredentialStore } from "../crypto/store";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { MemoryProvider } from "../providers/memory";
import type { RepositoryRef } from "../providers/types";
import type { GitHubAppConfig } from "./config";
import { handleCallback, handleInstall, type InstallHttpDeps } from "./http";
import { completeInstall } from "./install";
import { handleGitHubWebhook } from "./webhook";

/**
 * Installing the GitHub App and what its webhook does (ROADMAP 1a.6), over the real databases. GitHub is a stand-in `fetch` for the
 * two things that are GitHub's own (trading the `code`, and asking which repositories the person can reach); the repositories the
 * App acts on are a git host in memory. What is checked is ours: who can connect what, what is kept, and what is not.
 */
const { leg } = testTarget();
let database: Database;
let credentials: CredentialStore;
let service: ConnectionService;
let host: MemoryProvider;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const CONFIG: GitHubAppConfig = { appId: "1", slug: "my-fjord", privateKey, clientId: "Iv1.id", clientSecret: "client-secret", webhookSecret: "a-webhook-secret-of-length" };
const API = "https://api.github.example";
const WEB = "https://github.example";
const ORIGIN = "https://fjord.example";
const ALICE = "user-alice";
const BOB = "user-bob";
const USER_TOKEN = "ghu_theusertokenthatmustneverbekept";
const INSTALLATION = 4242;

const NOTES: RepositoryRef = { owner: "acme", name: "notes" };
const DOCS: RepositoryRef = { owner: "acme", name: "docs" };

const connectionTable = () => (database.dialect === "postgres" ? postgresSchema.connection : sqliteSchema.connection);
const credentialTable = () => (database.dialect === "postgres" ? postgresSchema.credential : sqliteSchema.credential);
const treeTable = () => (database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache);
const defaultTable = () => (database.dialect === "postgres" ? postgresSchema.accountDefault : sqliteSchema.accountDefault);
const connections = async (account: string) => dbAll<{ id: number; kind: string; owner: string; name: string }>(database, sql`SELECT id, kind, owner, name FROM ${connectionTable()} WHERE account_id = ${account} ORDER BY id`);
const everything = async () => JSON.stringify([...(await dbAll(database, sql`SELECT * FROM ${connectionTable()}`)), ...(await dbAll(database, sql`SELECT * FROM ${credentialTable()}`))]);

/** What GitHub says: which repositories of an installation a person can reach, and whether the code is good. */
let reachable: Record<number, RepositoryRef[]>;
let code: { good: string | undefined };
const github = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  if (url.origin === WEB && url.pathname === "/login/oauth/access_token") {
    const body = JSON.parse(String(init?.body)) as { code: string; client_id: string; client_secret: string };
    expect(body.client_id).toBe(CONFIG.clientId);
    expect(body.client_secret).toBe(CONFIG.clientSecret);
    return Response.json(body.code === code.good ? { access_token: USER_TOKEN, token_type: "bearer" } : { error: "bad_verification_code" });
  }
  const m = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
  if (url.origin === API && m) {
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(`Bearer ${USER_TOKEN}`);
    const repos = reachable[Number(m[1])];
    if (!repos) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ total_count: repos.length, repositories: repos.map((r) => ({ name: r.name, owner: { login: r.owner } })) });
  }
  return new Response("{}", { status: 404 });
});

const completeFor = (accountId: string, input: { code: string; installationId: number }) =>
  completeInstall({ config: CONFIG, apiUrl: API, webUrl: WEB, fetch: github as unknown as typeof fetch, service, installation: () => host }, accountId, input);
const deps = (over: Partial<InstallHttpDeps> = {}): InstallHttpDeps => ({ config: CONFIG, webUrl: WEB, origin: ORIGIN, complete: completeFor, ...over });

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  credentials = new CredentialStore(database, new Keyring(randomBytes(32)));
  service = new ConnectionService({ database, credentials, github: () => host, githubApp: () => host, now: () => 1_800_000_000_000 });
});
afterAll(async () => database.close());
beforeEach(async () => {
  for (const table of [connectionTable(), credentialTable(), treeTable(), defaultTable()]) await dbRun(database, sql`DELETE FROM ${table}`);
  host = new MemoryProvider();
  for (const ref of [NOTES, DOCS]) {
    host.createRepository(ref);
    host.seed(ref, { "fjord.json": "{}" });
  }
  reachable = { [INSTALLATION]: [NOTES, DOCS] };
  code = { good: "the-code" };
  github.mockClear();
});

const callbackRequest = (query: Record<string, string>, cookie: string | null = "S") =>
  new Request(`${ORIGIN}/api/github-app/callback?${new URLSearchParams(query)}`, { headers: cookie === null ? {} : { cookie: `fjord_github_app=${cookie}` } });
const good = { code: "the-code", installation_id: String(INSTALLATION), state: "S", setup_action: "install" };
const location = (response: Response) => new URL(response.headers.get("location") as string);

describe(`leaving for GitHub to install the App (${leg})`, () => {
  it("sends a signed-in person to the App's install page, with a state that is also in a cookie only this site reads", () => {
    const response = handleInstall(new Request(`${ORIGIN}/api/github-app/install`), { accountId: ALICE }, deps());
    expect(response.status).toBe(303);
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe(`${WEB}/apps/my-fjord/installations/new`);
    const state = to.searchParams.get("state") as string;
    expect(state.length).toBeGreaterThanOrEqual(32);
    const cookie = response.headers.get("set-cookie") as string;
    expect(cookie).toContain(`fjord_github_app=${state}`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Path=\/api\/github-app/);
  });

  it("gives each trip its own state", () => {
    const states = [1, 2].map(() => location(handleInstall(new Request(`${ORIGIN}/x`), { accountId: ALICE }, deps())).searchParams.get("state"));
    expect(states[0]).not.toBe(states[1]);
  });

  it("is refused for nobody who is signed in, and is not there on an instance with no App", async () => {
    expect(handleInstall(new Request(`${ORIGIN}/x`), null, deps()).status).toBe(401);
    expect(handleInstall(new Request(`${ORIGIN}/x`), { accountId: ALICE }, deps({ config: undefined })).status).toBe(404);
    expect((await handleCallback(callbackRequest(good), null, deps())).status).toBe(401);
    expect((await handleCallback(callbackRequest(good), { accountId: ALICE }, deps({ config: undefined }))).status).toBe(404);
    expect(github).not.toHaveBeenCalled();
  });
});

describe(`coming back from GitHub (${leg})`, () => {
  it("connects the repositories the person picked, each through the installation and with no token kept", async () => {
    const response = await handleCallback(callbackRequest(good), { accountId: ALICE }, deps());
    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe("/repositories");
    expect(Object.fromEntries(location(response).searchParams)).toEqual({ github_app: "ok", added: "2", already: "0", skipped: "0" });
    expect((await connections(ALICE)).map((c) => `${c.kind}:${c.owner}/${c.name}`)).toEqual(["app:acme/notes", "app:acme/docs"]);

    // The first is the default, as when a token connects one.
    const list = await service.list(ALICE);
    expect(list.map((c) => c.isDefault)).toEqual([true, false]);
    expect(list.every((c) => c.kind === "app")).toBe(true);

    // What is kept is which installation, encrypted; the person's token was used and forgotten.
    expect(await everything()).not.toContain(USER_TOKEN);
    expect(await everything()).not.toContain("client-secret");
    const [first] = await connections(ALICE);
    const used = await service.provider(ALICE, first!.id);
    expect(used?.provider).toBe(host);
    const stored = await dbAll<{ credentialId: string }>(database, sql`SELECT credential_id AS "credentialId" FROM ${connectionTable()} WHERE id = ${first!.id}`);
    expect((await credentials.get(stored[0]!.credentialId)).secret).toBe(String(INSTALLATION));
    expect(await everything()).not.toContain(`"${INSTALLATION}"`);
  });

  it("connects only the repositories of the installation that this person can reach themselves", async () => {
    reachable[INSTALLATION] = [DOCS];
    const response = await handleCallback(callbackRequest(good), { accountId: ALICE }, deps());
    expect(location(response).searchParams.get("added")).toBe("1");
    expect((await connections(ALICE)).map((c) => c.name)).toEqual(["docs"]);
  });

  it("connects nothing for an installation that is not the person's, and says so", async () => {
    reachable = {};
    const response = await handleCallback(callbackRequest(good), { accountId: ALICE }, deps());
    expect(location(response).searchParams.get("github_app")).toBe("not_yours");
    expect(await connections(ALICE)).toEqual([]);
  });

  it("connects nothing when the person can reach none of an installation's repositories", async () => {
    reachable[INSTALLATION] = [];
    const response = await handleCallback(callbackRequest(good), { accountId: ALICE }, deps());
    expect(location(response).searchParams.get("github_app")).toBe("nothing_to_connect");
    expect(await connections(ALICE)).toEqual([]);
  });

  it("connects nothing for a code GitHub does not accept", async () => {
    const response = await handleCallback(callbackRequest({ ...good, code: "stolen-or-old" }), { accountId: ALICE }, deps());
    expect(location(response).searchParams.get("github_app")).toBe("code_rejected");
    expect(await connections(ALICE)).toEqual([]);
  });

  it("does not take an installation number by itself: without a code that proves it, nothing is asked of GitHub", async () => {
    for (const query of [{ installation_id: String(INSTALLATION), state: "S" } as Record<string, string>, { code: "the-code", state: "S" }, { code: "the-code", installation_id: "12abc", state: "S" }, { code: "the-code", installation_id: "0", state: "S" }]) {
      const response = await handleCallback(callbackRequest(query), { accountId: ALICE }, deps());
      expect(location(response).searchParams.get("github_app")).toBe("incomplete");
    }
    expect(github).not.toHaveBeenCalled();
    expect(await connections(ALICE)).toEqual([]);
  });

  it.each([
    ["with no cookie", null],
    ["with a cookie of another trip", "T"],
    ["with an empty one", ""],
  ])("connects nothing when this browser did not start it (%s)", async (_name, cookie) => {
    const response = await handleCallback(callbackRequest(good, cookie), { accountId: ALICE }, deps());
    expect(location(response).searchParams.get("github_app")).toBe("state");
    expect(github).not.toHaveBeenCalled();
    expect(await connections(ALICE)).toEqual([]);
  });

  it("connects nothing without a state in the address, even with a cookie", async () => {
    const { state: _gone, ...rest } = good;
    const response = await handleCallback(callbackRequest(rest), { accountId: ALICE }, deps());
    expect(location(response).searchParams.get("github_app")).toBe("state");
  });

  it("asks nothing and connects nothing when an organisation's owners have yet to approve", async () => {
    const response = await handleCallback(callbackRequest({ setup_action: "request", state: "S" }), { accountId: ALICE }, deps());
    expect(location(response).searchParams.get("github_app")).toBe("requested");
    expect(github).not.toHaveBeenCalled();
  });

  it("ends the trip: the cookie is cleared whatever came of it", async () => {
    for (const request of [callbackRequest(good), callbackRequest(good, "T")]) {
      expect((await handleCallback(request, { accountId: ALICE }, deps())).headers.get("set-cookie")).toMatch(/Max-Age=0/);
    }
  });

  it("leaves out an empty repository and one the App cannot write to, and connects the rest", async () => {
    host.createRepository({ owner: "acme", name: "empty" });
    host.createRepository({ owner: "acme", name: "locked" }, { canPush: false });
    host.seed({ owner: "acme", name: "locked" }, { "a.md": "x" });
    reachable[INSTALLATION] = [NOTES, { owner: "acme", name: "empty" }, { owner: "acme", name: "locked" }];
    const response = await handleCallback(callbackRequest(good), { accountId: ALICE }, deps());
    expect(Object.fromEntries(location(response).searchParams)).toMatchObject({ github_app: "ok", added: "1", skipped: "2" });
    expect((await connections(ALICE)).map((c) => c.name)).toEqual(["notes"]);
  });

  it("adds what is new when it is done again, and does not connect twice", async () => {
    reachable[INSTALLATION] = [NOTES];
    await handleCallback(callbackRequest(good), { accountId: ALICE }, deps());
    reachable[INSTALLATION] = [NOTES, DOCS];
    const again = await handleCallback(callbackRequest(good), { accountId: ALICE }, deps());
    expect(Object.fromEntries(location(again).searchParams)).toMatchObject({ added: "1", already: "1" });
    expect((await connections(ALICE)).map((c) => c.name)).toEqual(["notes", "docs"]);
  });

  it("connects for the account that came back and no other, and two accounts can each connect the same repository", async () => {
    await handleCallback(callbackRequest(good), { accountId: ALICE }, deps());
    await handleCallback(callbackRequest(good), { accountId: BOB }, deps());
    expect((await connections(ALICE)).length).toBe(2);
    expect((await connections(BOB)).length).toBe(2);
    expect(await service.get(BOB, (await connections(ALICE))[0]!.id)).toBeUndefined();
  });

  it("forgets the installation with the connection", async () => {
    await handleCallback(callbackRequest(good), { accountId: ALICE }, deps());
    for (const c of await connections(ALICE)) await service.remove(ALICE, c.id);
    expect(await connections(ALICE)).toEqual([]);
    expect(Number((await dbAll<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${credentialTable()}`))[0]!.n)).toBe(0);
  });

  it("tells a person when GitHub could not be reached, and keeps nothing", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const outcome = await completeInstall({ config: CONFIG, apiUrl: API, webUrl: WEB, fetch: down, service, installation: () => host }, ALICE, { code: "c", installationId: INSTALLATION });
    expect(outcome).toEqual({ ok: false, reason: "unavailable" });
    expect(await connections(ALICE)).toEqual([]);
  });
});

describe(`the webhook (${leg})`, () => {
  const sign = (body: string, secret = CONFIG.webhookSecret) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const push = (repository = "acme/notes", ref = "refs/heads/main") => JSON.stringify({ ref, before: "a".repeat(40), after: "b".repeat(40), deleted: false, repository: { full_name: repository } });
  const post = (body: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/webhooks/github`, { method: "POST", body, headers: { "x-github-event": "push", "x-hub-signature-256": sign(body), ...headers } });
  const webhook = (pushed = (ref: RepositoryRef, branch: string) => service.pushed(ref, branch), secret: string | null = CONFIG.webhookSecret) => ({ secret: secret ?? undefined, pushed });

  async function connectBoth() {
    await handleCallback(callbackRequest(good), { accountId: ALICE }, deps());
    await handleCallback(callbackRequest(good), { accountId: BOB }, deps());
    const all = await dbAll<{ id: number; owner: string; name: string }>(database, sql`SELECT id, owner, name FROM ${connectionTable()} ORDER BY id`);
    const cache = new TreeCache(database);
    for (const c of all) await cache.put(Number(c.id), { commit: "c".repeat(40), entries: [], complete: true });
    return { all, cache };
  }
  const cached = async (id: number) => (await new TreeCache(database).get(id, "c".repeat(40))) !== undefined;

  it("forgets the cached trees of every connection to the repository that was pushed to, and of no other", async () => {
    const { all } = await connectBoth();
    const response = await handleGitHubWebhook(post(push("acme/notes")), webhook());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ connections: 2 });
    for (const c of all) expect(await cached(Number(c.id)), `${c.owner}/${c.name}`).toBe(c.name !== "notes");
  });

  it("leaves connections that follow another branch alone", async () => {
    const { all } = await connectBoth();
    const response = await handleGitHubWebhook(post(push("acme/notes", "refs/heads/feature")), webhook());
    expect(await response.json()).toEqual({ connections: 0 });
    for (const c of all) expect(await cached(Number(c.id))).toBe(true);
  });

  it("refuses a request without the right signature, before it is read or the database touched", async () => {
    const pushed = vi.fn(async () => 0);
    const body = push();
    for (const headers of [{ "x-hub-signature-256": sign(body, "another-secret-entirely") }, { "x-hub-signature-256": "" }, { "x-hub-signature-256": sign(body + " ") }]) {
      expect((await handleGitHubWebhook(post(body, headers), webhook(pushed))).status).toBe(401);
    }
    const unsigned = new Request(`${ORIGIN}/api/webhooks/github`, { method: "POST", body, headers: { "x-github-event": "push" } });
    expect((await handleGitHubWebhook(unsigned, webhook(pushed))).status).toBe(401);
    expect(pushed).not.toHaveBeenCalled();
  });

  it("answers a ping, ignores other events, and is not there on an instance with no App", async () => {
    const pushed = vi.fn(async () => 0);
    const body = "{}";
    expect((await handleGitHubWebhook(post(body, { "x-github-event": "ping" }), webhook(pushed))).status).toBe(200);
    expect((await handleGitHubWebhook(post(body, { "x-github-event": "issues" }), webhook(pushed))).status).toBe(202);
    expect((await handleGitHubWebhook(post(push()), webhook(pushed, null))).status).toBe(404);
    expect((await handleGitHubWebhook(new Request(`${ORIGIN}/api/webhooks/github`), webhook(pushed))).status).toBe(405);
    expect(pushed).not.toHaveBeenCalled();
  });

  it("refuses a body past the limit without reading its signature", async () => {
    const big = new Request(`${ORIGIN}/api/webhooks/github`, { method: "POST", body: "x".repeat(10), headers: { "content-length": String(6 * 1024 * 1024) } });
    expect((await handleGitHubWebhook(big, webhook())).status).toBe(413);
  });

  it("does not say what went wrong inside when the database fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handleGitHubWebhook(post(push()), webhook(async () => {
      throw new Error("password=hunter2");
    }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("hunter2");
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
    log.mockRestore();
  });
});
