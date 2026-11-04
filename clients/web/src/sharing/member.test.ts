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
import { RateLimiter } from "../limits/rate";
import { MemoryProvider } from "../providers/memory";
import type { RepositoryRef } from "../providers/types";
import { WorkingCopyService } from "../working/service";
import { GUEST_EDIT_RATES } from "./guest";
import { type MemberDeps, saveMemberDraft } from "./member";
import { type OpenDeps, listShared, openShared } from "./open";
import { ShareService } from "./shares";

/**
 * Editing a document that was shared with an account: the real format module and databases, an in-memory host for the owner's repository. What matters is who may (an account whose share is at the edit
 * role, and no other), where it goes (the working copy, as that account, never the repository), what they cannot touch (the header), and what the list of what was shared says.
 */
const { leg } = testTarget();
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const REF: RepositoryRef = { owner: "acme", name: "notes" };
const VAULT = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });
const ID = "01jagc4k7pt8y3wqnmzv5xrb8j";
const OTHER_ID = "01jagc4k7pt8y3wqnmzv5xrb9k";
const HEADER = `---\nid: ${ID}\ntitle: Q4 plan\nx-secret: not for the editor\n---\n`;
const DOC = `${HEADER}\n# Q4 plan\n\nThe plan.\n`;
const PATH = "Notes/Plan.fj.md";

let database: Database;
let shares: ShareService;
let drafts: WorkingCopyService;
let clock = 1_800_000_000_000;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  shares = new ShareService(database, () => clock);
  drafts = new WorkingCopyService(database, { now: () => clock });
});
afterAll(async () => database?.close());
beforeEach(async () => {
  clock = 1_800_000_000_000;
  const schema = database.dialect === "postgres" ? postgresSchema : sqliteSchema;
  for (const table of [schema.shareUser, schema.workingCopy, schema.docIndex, schema.treeCache, schema.rateBucket]) await dbRun(database, sql`DELETE FROM ${table}`);
});

function setup(files: Record<string, string | null> = { [PATH]: DOC }) {
  const host = new MemoryProvider();
  host.createRepository(REF);
  host.seed(REF, { "Notes/fjord.vault.json": VAULT, ...files });
  const sourceOf = async (connectionId: number): Promise<Source | undefined> => {
    if (connectionId !== 1) return undefined;
    const read = await readRepository({ provider: host, cache: new TreeCache(database), format: fjord() }, { id: connectionId, ref: REF, branch: "main" });
    return { connectionId, ref: REF, read, provider: host };
  };
  const index = new DocIndex(database);
  const deps: MemberDeps = { shares, sourceOf, index, format: fjord(), drafts, now: () => clock };
  const open: OpenDeps & { shares: ShareService } = { shares, sourceOf, index, format: fjord(), nameOf: async (id) => (id === "ada" ? "Ada Lovelace" : undefined), drafts, now: () => clock };
  return { host, deps, open };
}

describe.skipIf(!available)(`editing a document shared with an account (${leg})`, () => {
  it("keeps what is typed as the working copy, as that account, with the header as it was, and writes nothing to the repository", async () => {
    const { deps, host } = setup();
    await shares.set(1, ID, "grace", "edit", "ada");
    const head = await host.getHead(REF, "main");
    expect(await saveMemberDraft(deps, { accountId: "grace", docId: ID, body: "\n# Q4 plan\n\nThe plan, and a line from Grace.\n" })).toEqual({ ok: true, savedAt: expect.any(Number) });
    const draft = (await drafts.get(1, PATH))!;
    expect(draft.content).toBe(`${HEADER}\n# Q4 plan\n\nThe plan, and a line from Grace.\n`);
    expect(draft.editors).toEqual([{ type: "account", id: "grace" }]);
    expect(await host.getHead(REF, "main")).toEqual(head);
  });

  it("is for the edit role alone: a comment or view share may not (and is told so), and an account with no share is told nothing", async () => {
    const { deps } = setup();
    await shares.set(1, ID, "carol", "comment", "ada");
    await shares.set(1, ID, "victor", "view", "ada");
    expect(await saveMemberDraft(deps, { accountId: "carol", docId: ID, body: "x" })).toEqual({ ok: false, reason: "forbidden" });
    expect(await saveMemberDraft(deps, { accountId: "victor", docId: ID, body: "x" })).toEqual({ ok: false, reason: "forbidden" });
    expect(await saveMemberDraft(deps, { accountId: "mallory", docId: ID, body: "x" })).toEqual({ ok: false, reason: "hidden" });
    // A share of another document is no share of this one.
    await shares.set(1, OTHER_ID, "mallory", "edit", "ada");
    expect(await saveMemberDraft(deps, { accountId: "mallory", docId: ID, body: "x" })).toEqual({ ok: false, reason: "hidden" });
    expect(await drafts.get(1, PATH)).toBeUndefined();
  });

  it("adds up with the owner's own typing and another editor's: the draft lists each, once, and keeps its base", async () => {
    const { deps } = setup();
    await shares.set(1, ID, "grace", "edit", "ada");
    await shares.set(1, ID, "linus", "edit", "ada");
    await saveMemberDraft(deps, { accountId: "grace", docId: ID, body: "\nFirst.\n" });
    const first = (await drafts.get(1, PATH))!;
    await saveMemberDraft(deps, { accountId: "linus", docId: ID, body: "\nFirst. Second.\n" });
    await saveMemberDraft(deps, { accountId: "grace", docId: ID, body: "\nFirst. Second. Third.\n" });
    const draft = (await drafts.get(1, PATH))!;
    expect(draft.content).toBe(`${HEADER}\nFirst. Second. Third.\n`);
    expect(draft.baseBlob).toBe(first.baseBlob);
    expect(draft.editors).toEqual([{ type: "account", id: "grace" }, { type: "account", id: "linus" }]);
  });

  it("leaves no draft when nothing was changed, and is told nothing of a document that is not there", async () => {
    const { deps } = setup();
    await shares.set(1, ID, "grace", "edit", "ada");
    expect(await saveMemberDraft(deps, { accountId: "grace", docId: ID, body: "\n# Q4 plan\n\nThe plan.\n" })).toMatchObject({ ok: true });
    expect(await drafts.get(1, PATH)).toBeUndefined();
    const gone = setup({ [PATH]: null });
    expect(await saveMemberDraft(gone.deps, { accountId: "grace", docId: ID, body: "x" })).toEqual({ ok: false, reason: "hidden" });
  });

  it("is slowed when it comes faster than anyone types, per account and document", async () => {
    const { deps } = setup();
    const limited: MemberDeps = { ...deps, limiter: new RateLimiter(database, () => clock) };
    await shares.set(1, ID, "grace", "edit", "ada");
    const limit = GUEST_EDIT_RATES[0]!.limit;
    for (let n = 0; n < limit; n++) expect(await saveMemberDraft(limited, { accountId: "grace", docId: ID, body: `\n${n}\n` })).toMatchObject({ ok: true });
    expect(await saveMemberDraft(limited, { accountId: "grace", docId: ID, body: "\nmore\n" })).toMatchObject({ ok: false, reason: "rate_limited" });
  }, 60_000);
});

describe.skipIf(!available)(`what an account is shown of what was shared with it (${leg})`, () => {
  it("shows an account that may edit the working copy, so that what it types adds up; the others see the file as it is in the repository", async () => {
    const { deps, open } = setup();
    await shares.set(1, ID, "grace", "edit", "ada");
    await shares.set(1, ID, "carol", "comment", "ada");
    await saveMemberDraft(deps, { accountId: "grace", docId: ID, body: "\n# Q4 plan\n\nGrace's line.\n" });
    const editor = await openShared(open, "grace", ID);
    expect(editor).toMatchObject({ title: "Q4 plan", role: "edit", editable: true, sharedBy: "Ada Lovelace" });
    expect(editor?.body).toContain("Grace's line.");
    const reader = await openShared(open, "carol", ID);
    expect(reader).toMatchObject({ role: "comment", editable: false });
    expect(reader?.body).not.toContain("Grace's line.");
    expect(JSON.stringify(editor)).not.toMatch(/x-secret|not for the editor|Plan\.fj\.md/);
  });

  it("lists what was shared, newest first, with who shared it and at what role, and leaves out and counts what cannot be read", async () => {
    const { open, host } = setup({ [PATH]: DOC, "Notes/Other.fj.md": `---\nid: ${OTHER_ID}\ntitle: Other\n---\n\n# Other\n` });
    await shares.set(1, ID, "grace", "view", "ada");
    clock += 1000;
    await shares.set(1, OTHER_ID, "grace", "edit", "ada");
    clock += 1000;
    await shares.set(1, "01jagc4k7pt8y3wqnmzv5xrbzz", "grace", "view", "ada"); // a document that is gone
    await shares.set(2, ID, "grace", "view", "ada"); // a repository that cannot be read
    const listed = await listShared(open, "grace");
    expect(listed.documents.map((d) => [d.title, d.role, d.sharedBy])).toEqual([["Other", "edit", "Ada Lovelace"], ["Q4 plan", "view", "Ada Lovelace"]]);
    expect(listed.unreadable).toBe(2);
    expect((await listShared(open, "nobody")).documents).toEqual([]);
    expect(await shares.countFor("grace")).toBe(4);
    expect(await shares.countFor("nobody")).toBe(0);
    void host;
  });
});
