import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DocIndex } from "../browse/doc-index";
import type { Source } from "../browse/ids";
import { readRepository } from "../browse/repository";
import { TreeCache } from "../browse/tree-cache";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import { MemoryProvider } from "../providers/memory";
import type { RepositoryRef } from "../providers/types";
import { unlockProof, hashPassword } from "../sharing/password";
import { type OpenPublishedDeps, type OpenedPublication, beginsWithHeading, openPublished } from "./open";

/** The page of an opened publication, or nothing for the rest. */
const opened = async (deps: OpenPublishedDeps, token: string, proof?: string) => {
  const result = await openPublished(deps, token, proof);
  return result?.state === "open" ? result.page : undefined;
};
import { PublicationService } from "./publications";

/**
 * Opening a published page: the real format module and databases, an in-memory host for the owner's repository. What matters is who is let in (anyone with a live
 * token, and nothing else), what they are shown (the title and the rendered body, never the header or the path), that the saved version is what is shown, and that
 * an ended address, a deleted Doc and a Doc of an encrypted vault are all just nothing.
 */
const { leg } = testTarget();
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const REF: RepositoryRef = { owner: "acme", name: "notes" };
const PLAIN = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });
const SECRET = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hw", name: "Secret", createdAt: "2026-10-16T09:34:00Z", encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container: "none", armor: false }, fileNaming: "plain" });
const ID = "01jagc4k7pt8y3wqnmzv5xrb8j";
const doc = (id: string, title: string, body = "The plan.") => `---\nid: ${id}\ntitle: ${title}\nx-secret: not for the reader\n---\n\n# ${title}\n\n${body}\n`;

let database: Database;
let publications: PublicationService;
const tables = () => [database.dialect === "postgres" ? postgresSchema.publication : sqliteSchema.publication, database.dialect === "postgres" ? postgresSchema.docIndex : sqliteSchema.docIndex, database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache];

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  publications = new PublicationService(database);
});
afterAll(async () => database?.close());
beforeEach(async () => {
  for (const table of tables()) await dbRun(database, sql`DELETE FROM ${table}`);
});

function setup(files: Record<string, string | null>) {
  const host = new MemoryProvider();
  host.createRepository(REF);
  host.seed(REF, { "Notes/fjord.vault.json": PLAIN, ...files });
  const deps: OpenPublishedDeps = {
    publications,
    sourceOf: async (connectionId): Promise<Source | undefined> => {
      if (connectionId !== 1) return undefined;
      const read = await readRepository({ provider: host, cache: new TreeCache(database), format: fjord() }, { id: 1, ref: REF, branch: "main" });
      return { connectionId, ref: REF, read, provider: host };
    },
    index: new DocIndex(database),
    format: fjord(),
    nameOf: async (id) => (id === "alice" ? "Alice Liddell" : undefined),
    secret: "s".repeat(32),
  };
  return { host, deps };
}

describe.skipIf(!available)(`opening a published page (${leg})`, () => {
  it("shows the title and the rendered body to anyone with the address, and nothing of the header or the path", async () => {
    const { deps } = setup({ "Notes/Plans/Plan.md": doc(ID, "Q4 plan", "A *plan*, with <script>alert(1)</script> in it.") });
    const { token } = await publications.publish(1, ID, "alice");
    const page = await opened(deps, token);
    expect(page?.title).toBe("Q4 plan");
    expect(page?.html).toContain("<h1>Q4 plan</h1>");
    expect(page?.html).toContain("<em>plan</em>");
    expect(page?.html).toContain("&lt;script&gt;");
    expect(JSON.stringify(page)).not.toMatch(/<script|x-secret|not for the reader|Plans|Plan\.md/);
  });

  it("shows the saved version as it is now, and follows the Doc when it is moved or edited elsewhere", async () => {
    const { deps, host } = setup({ "Notes/Plan.md": doc(ID, "Q4 plan", "First.") });
    const { token } = await publications.publish(1, ID, "alice");
    expect((await opened(deps, token))?.html).toContain("First.");
    host.seed(REF, { "Notes/Plan.md": null, "Notes/Archive/Plan.md": doc(ID, "Q4 plan, final", "Second.") });
    const again = await opened(deps, token);
    expect(again?.title).toBe("Q4 plan, final");
    expect(again?.html).toContain("Second.");
  });

  it("shows nothing once the address is ended, for a token never made or not one, or once the Doc is gone", async () => {
    const { deps, host } = setup({ "Notes/Plan.md": doc(ID, "Q4 plan") });
    const { token } = await publications.publish(1, ID, "alice");
    for (const bad of ["", "x", "a".repeat(43), "a".repeat(44), `${token}.`, token.toUpperCase()]) expect(await openPublished(deps, bad), bad).toBeUndefined();
    host.seed(REF, { "Notes/Plan.md": null });
    expect(await openPublished(deps, token)).toBeUndefined();
    host.seed(REF, { "Notes/Plan.md": doc(ID, "Q4 plan") });
    expect(await opened(deps, token)).toMatchObject({ title: "Q4 plan" });
    await publications.unpublish(1, ID);
    expect(await openPublished(deps, token)).toBeUndefined();
  });

  it("shows nothing for a Doc in an encrypted vault, whatever was recorded: the server has no key", async () => {
    const { deps } = setup({ "Secret/fjord.vault.json": SECRET, "Secret/recipients.txt": "age1x\n", "Secret/Plan.md.age": "age-encryption.org/v1\n" });
    const { token } = await publications.publish(1, ID, "alice");
    expect(await openPublished(deps, token)).toBeUndefined();
  });

  it("shows a copy that was handed over, without reading the repository, rendered the same way and as safely", async () => {
    const { deps } = setup({});
    const { token } = await publications.publishCopy(1, "Secret/Plan.md.age", "alice", { title: "Secret plan", body: "# Secret plan\n\nSee <script>alert(1)</script> and [x](javascript:alert(1)).\n" });
    const page = await opened({ ...deps, sourceOf: async () => undefined }, token);
    expect(page?.title).toBe("Secret plan");
    expect(page?.html).toContain("<h1>Secret plan</h1>");
    expect(page?.html).not.toMatch(/<script|<a /);
    await publications.unpublish(1, "file:Secret/Plan.md.age");
    expect(await openPublished(deps, token)).toBeUndefined();
  });

  it("shows nothing when the repository cannot be read", async () => {
    const { deps } = setup({ "Notes/Plan.md": doc(ID, "Q4 plan") });
    const { token } = await publications.publish(2, ID, "alice");
    expect(await openPublished(deps, token)).toBeUndefined();
  });

  it("says who published it, when the document was made and when its file last changed, so that the page can show them", async () => {
    const { deps } = setup({ "Notes/Plan.md": `---\nid: ${ID}\ntitle: Q4 plan\ncreated: 2026-09-20T08:00:00Z\n---\n\n# Q4 plan\n\nThe plan.\n` });
    const { token } = await publications.publish(1, ID, "alice");
    const page = await opened(deps, token);
    expect(page).toMatchObject({ author: "Alice Liddell", created: "2026-09-20T08:00:00Z", startsWithHeading: true, comments: "off" });
    // The in-memory host keeps no history: the date of the last change is then not known, which the page leaves out.
    expect(page?.updated === null || typeof page?.updated === "string").toBe(true);
  });

  it("knows whether a body begins with a heading, in either style, past blank lines", () => {
    for (const yes of ["# T\n\ntext", "\n\n## T", "  ### T", "Title\n=====\n", "Title\n-----\n"]) expect(beginsWithHeading(yes), yes).toBe(true);
    for (const no of ["text\n\n# T", "- # in a list", "#hashtag", "    # code", ""]) expect(beginsWithHeading(no), no).toBe(false);
  });

  describe("with a password", () => {
    it("shows nothing of the document, not even its title, until the proof that it was given, which only that page's password makes", async () => {
      const { deps } = setup({ "Notes/Plan.md": doc(ID, "Q4 plan", "Private words.") });
      const passwordHash = await hashPassword("correct horse battery");
      const { token } = await publications.publish(1, ID, "alice", { passwordHash });
      const locked = await openPublished(deps, token);
      expect(locked).toEqual({ state: "locked" });
      expect(JSON.stringify(locked)).not.toMatch(/Q4 plan|Private/);
      const found = (await publications.find(token))!;
      expect(await openPublished(deps, token, "not the proof")).toEqual({ state: "locked" });
      expect(await openPublished(deps, token, unlockProof(deps.secret, found.id, "another hash", "fjord-publication-unlock"))).toEqual({ state: "locked" });
      // A proof made for a link's password, with the same numbers, is not one.
      expect(await openPublished(deps, token, unlockProof(deps.secret, found.id, passwordHash))).toEqual({ state: "locked" });
      const right = unlockProof(deps.secret, found.id, passwordHash, "fjord-publication-unlock");
      expect(await openPublished(deps, token, right)).toMatchObject({ state: "open", page: { title: "Q4 plan" } });
      // A new password ends every proof given for the old one.
      await publications.update(1, ID, { passwordHash: await hashPassword("another password") });
      expect(await openPublished(deps, token, right)).toEqual({ state: "locked" });
      // Taken off, the page is open to anyone again.
      await publications.update(1, ID, { passwordHash: null });
      expect(await openPublished(deps, token)).toMatchObject({ state: "open" });
    });

    it("keeps a copy of an encrypted vault's file behind it too", async () => {
      const { deps } = setup({});
      const passwordHash = await hashPassword("correct horse battery");
      const { token } = await publications.publishCopy(1, "Secret/Plan.md.age", "alice", { title: "Secret plan", body: "# Secret plan\n\nWords.\n" });
      await publications.update(1, "file:Secret/Plan.md.age", { passwordHash });
      expect(await openPublished({ ...deps, sourceOf: async () => undefined }, token)).toEqual({ state: "locked" });
    });
  });

  it("keeps how a page is open: whether it asks for a password, and who may comment", async () => {
    const { token } = await publications.publish(1, ID, "alice", { passwordHash: "hash", comments: "users" });
    expect(await publications.status(1, ID)).toMatchObject({ passwordProtected: true, comments: "users" });
    expect(JSON.stringify(await publications.status(1, ID))).not.toContain("hash");
    await publications.update(1, ID, { comments: "off" });
    expect(await publications.status(1, ID)).toMatchObject({ passwordProtected: true, comments: "off" });
    expect(await publications.update(1, "01jagc4k7pt8y3wqnmzv5xrb00", { comments: "off" })).toBe(false);
    expect((await publications.find(token))?.comments).toBe("off");
  });

  it("slows the tries at a password: one at a time, longer after each wrong one, forgotten by the right one", async () => {
    let now = 1_000_000;
    const timed = new PublicationService(database, () => now);
    await timed.publish(1, ID, "alice", { passwordHash: "hash" });
    const id = (await dbFindId(timed))!;
    expect(await timed.claimTry(id)).toEqual({ claimed: true });
    expect(await timed.claimTry(id)).toMatchObject({ claimed: false });
    await timed.recordFailure(id);
    now += 500;
    expect(await timed.claimTry(id)).toMatchObject({ claimed: false });
    now += 2000;
    expect(await timed.claimTry(id)).toEqual({ claimed: true });
    await timed.recordSuccess(id);
    expect(await timed.claimTry(id)).toEqual({ claimed: true });
  });
});

/** The id of the one publication there is, which a test that is not given a token reads. */
async function dbFindId(service: PublicationService): Promise<number | undefined> {
  const { dbGet } = await import("../db/exec");
  const row = await dbGet<{ id: number | string }>(database, sql`SELECT id FROM ${database.dialect === "postgres" ? postgresSchema.publication : sqliteSchema.publication} LIMIT 1`);
  void service;
  return row ? Number(row.id) : undefined;
}
