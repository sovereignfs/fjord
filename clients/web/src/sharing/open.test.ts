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
import { type OpenDeps, openShared } from "./open";
import { ShareService } from "./shares";

/**
 * Opening a document that was shared (ROADMAP 1c.2): the real format module and databases, an in-memory host for the owner's
 * repository. What matters is who is let in (only an account with a share, on that document), what they are shown (the body,
 * never the header or the path), and that what has moved is still found.
 */
const { leg } = testTarget();
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const REF: RepositoryRef = { owner: "acme", name: "notes" };
const VAULT = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });
const ID = "01jagc4k7pt8y3wqnmzv5xrb8j";
const NOTE_ID = "01jagc4k7pt8y3wqnmzv5xrb9k";
const doc = (id: string, title: string, body = "The plan.") => `---\nid: ${id}\ntitle: ${title}\nx-secret: not for the reader\n---\n\n# ${title}\n\n${body}\n`;

let database: Database;
let shares: ShareService;
const sharesTable = () => (database.dialect === "postgres" ? postgresSchema.shareUser : sqliteSchema.shareUser);
const indexTable = () => (database.dialect === "postgres" ? postgresSchema.docIndex : sqliteSchema.docIndex);
const treeTable = () => (database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  shares = new ShareService(database);
});
afterAll(async () => database?.close());
beforeEach(async () => {
  for (const table of [sharesTable(), indexTable(), treeTable()]) await dbRun(database, sql`DELETE FROM ${table}`);
});

function setup(files: Record<string, string | null>, options: { unreadable?: boolean } = {}) {
  const host = new MemoryProvider();
  host.createRepository(REF);
  host.seed(REF, { "Notes/fjord.vault.json": VAULT, ...files });
  const deps: OpenDeps = {
    shares,
    sourceOf: async (connectionId): Promise<Source | undefined> => {
      if (options.unreadable || connectionId !== 1) return undefined;
      const read = await readRepository({ provider: host, cache: new TreeCache(database), format: fjord() }, { id: 1, ref: REF, branch: "main" });
      return { connectionId, ref: REF, read, provider: host };
    },
    index: new DocIndex(database),
    format: fjord(),
    nameOf: async (id) => (id === "alice" ? "Alice" : undefined),
  };
  return { host, deps };
}

describe.skipIf(!available)(`opening what was shared (${leg})`, () => {
  it("shows the document to the account it was shared with: the title and the body, at the role it was given, and who shared it", async () => {
    const { deps } = setup({ "Notes/Plans/Plan.fj.md": doc(ID, "Q4 plan") });
    await shares.set(1, ID, "bob", "comment", "alice");
    const opened = await openShared(deps, "bob", ID);
    expect(opened).toEqual({ title: "Q4 plan", body: "\n# Q4 plan\n\nThe plan.\n", role: "comment", sharedBy: "Alice" });
    // The header, with whatever else is in it, and the path, are not in what is given.
    expect(JSON.stringify(opened)).not.toMatch(/x-secret|Plans|not for the reader|Plan\.fj\.md/);
  });

  it("shows nothing to an account it was not shared with, to the owner's other documents, or when nothing was shared", async () => {
    const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan"), "Notes/Other.fj.md": doc("01jagc4k7pt8y3wqnmzv5xrbzz", "Other") });
    await shares.set(1, ID, "bob", "view", "alice");
    expect(await openShared(deps, "carol", ID)).toBeUndefined();
    expect(await openShared(deps, "bob", "01jagc4k7pt8y3wqnmzv5xrbzz")).toBeUndefined();
    expect(await openShared(deps, "mallory", ID)).toBeUndefined();
  });

  it("stops at once when the share is taken away", async () => {
    const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
    await shares.set(1, ID, "bob", "view", "alice");
    expect(await openShared(deps, "bob", ID)).toBeDefined();
    await shares.remove(1, ID, "bob");
    expect(await openShared(deps, "bob", ID)).toBeUndefined();
  });

  it("follows the document when it is moved or renamed, and shows what it says now", async () => {
    const { deps, host } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
    await shares.set(1, ID, "bob", "view", "alice");
    expect((await openShared(deps, "bob", ID))?.title).toBe("Q4 plan");
    host.seed(REF, { "Notes/Plan.fj.md": null, "Notes/Archive/Old plan.fj.md": doc(ID, "Q4 plan, final", "Changed.") });
    const again = await openShared(deps, "bob", ID);
    expect(again).toMatchObject({ title: "Q4 plan, final" });
    expect(again?.body).toContain("Changed.");
  });

  it("finds nothing once the document is gone, or when it was never a document", async () => {
    const { deps, host } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan"), "Notes/idea.md": doc(NOTE_ID, "An idea") });
    await shares.set(1, ID, "bob", "view", "alice");
    await shares.set(1, NOTE_ID, "bob", "view", "alice"); // a share of a note: shares are of documents only
    expect(await openShared(deps, "bob", NOTE_ID)).toBeUndefined();
    host.seed(REF, { "Notes/Plan.fj.md": null });
    expect(await openShared(deps, "bob", ID)).toBeUndefined();
  });

  it("finds nothing when the owner's repository cannot be read", async () => {
    const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") }, { unreadable: true });
    await shares.set(1, ID, "bob", "view", "alice");
    expect(await openShared(deps, "bob", ID)).toBeUndefined();
  });

  it("does not share what is in an encrypted vault", async () => {
    const encrypted = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hw", name: "Secret", createdAt: "2026-10-16T09:34:00Z", encryption: { mode: "none" }, fileNaming: "plain" });
    const { deps } = setup({ "Secret/fjord.vault.json": encrypted, "Secret/Plan.fj.md": doc(ID, "Hidden") });
    await shares.set(1, ID, "bob", "view", "alice");
    expect(await openShared(deps, "bob", ID)).toBeUndefined();
  });

  it("does not open a document whose header has no readable id, and says nothing of the sharer if their account is gone", async () => {
    const { deps } = setup({ "Notes/Plan.fj.md": `---\nid: ${ID}\nbroken: [\n---\nbody\n` });
    // A header that cannot be read has no id, so it is not the document that was shared: nothing is opened.
    await shares.set(1, ID, "bob", "view", "alice");
    expect(await openShared(deps, "bob", ID)).toBeUndefined();
    await shares.remove(1, ID, "bob");
    const second = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
    await shares.set(1, ID, "bob", "view", "gone-account");
    expect((await openShared(second.deps, "bob", ID))?.sharedBy).toBeUndefined();
  });
});
