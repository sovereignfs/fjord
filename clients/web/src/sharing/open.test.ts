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
import { LinkService } from "./links";
import { type OpenDeps, asksForPassword, openByLink, openShared } from "./open";
import { hashPassword, unlockProof } from "./password";
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
let links: LinkService;
let clock = 1_800_000_000_000;
const sharesTable = () => (database.dialect === "postgres" ? postgresSchema.shareUser : sqliteSchema.shareUser);
const indexTable = () => (database.dialect === "postgres" ? postgresSchema.docIndex : sqliteSchema.docIndex);
const linksTable = () => (database.dialect === "postgres" ? postgresSchema.shareLink : sqliteSchema.shareLink);
const treeTable = () => (database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  shares = new ShareService(database);
  links = new LinkService(database, { now: () => clock });
});
afterAll(async () => database?.close());
beforeEach(async () => {
  clock = 1_800_000_000_000;
  for (const table of [sharesTable(), linksTable(), indexTable(), treeTable()]) await dbRun(database, sql`DELETE FROM ${table}`);
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
    expect(opened).toEqual({ title: "Q4 plan", body: "\n# Q4 plan\n\nThe plan.\n", role: "comment", sharedBy: "Alice", editable: false });
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

describe.skipIf(!available)(`opening by a link (${leg})`, () => {
  const SECRET = "s".repeat(40);
  const linkDeps = (deps: OpenDeps, now = () => clock) => ({ links, sourceOf: deps.sourceOf, index: deps.index, format: deps.format, secret: SECRET, now });
  const make = async (role: "view" | "comment" | "edit" = "view", expiresAt: number | null = null, docId = ID) => {
    const made = await links.create(1, docId, role, expiresAt, "alice");
    if (!made.ok) throw new Error("not made");
    return made;
  };

  it("shows the document to whoever has the token, at the link's role, and not the header, the path or who made it", async () => {
    const { deps } = setup({ "Notes/Plans/Plan.fj.md": doc(ID, "Q4 plan") });
    const { token } = await make("comment");
    const opened = await openByLink(linkDeps(deps), token, ID);
    expect(opened).toEqual({ title: "Q4 plan", body: "\n# Q4 plan\n\nThe plan.\n", role: "comment", sharedBy: undefined, editable: false });
    expect(JSON.stringify(opened)).not.toMatch(/x-secret|Plans|Plan\.fj\.md|alice/);
  });

  it("opens nothing for a token that was never made, or for one of another document", async () => {
    const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan"), "Notes/Other.fj.md": doc("01jagc4k7pt8y3wqnmzv5xrbzz", "Other") });
    const { token } = await make();
    expect(await openByLink(linkDeps(deps), "A".repeat(43), ID)).toBeUndefined();
    expect(await openByLink(linkDeps(deps), token, "01jagc4k7pt8y3wqnmzv5xrbzz")).toBeUndefined();
    expect(await openByLink(linkDeps(deps), "not a token", ID)).toBeUndefined();
  });

  it("stops at the moment it expires, and not before", async () => {
    const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
    const { token } = await make("view", clock + 1000);
    expect(await openByLink(linkDeps(deps, () => clock + 999), token, ID)).toBeDefined();
    expect(await openByLink(linkDeps(deps, () => clock + 1000), token, ID)).toBeUndefined();
    expect(await openByLink(linkDeps(deps, () => clock + 10_000), token, ID)).toBeUndefined();
  });

  it("stops when it is revoked, and only that link: another to the same document goes on", async () => {
    const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
    const first = await make();
    const second = await make("edit");
    expect(await openByLink(linkDeps(deps), first.token, ID)).toBeDefined();
    await links.revoke(1, ID, first.id);
    expect(await openByLink(linkDeps(deps), first.token, ID)).toBeUndefined();
    expect((await openByLink(linkDeps(deps), second.token, ID))?.role).toBe("edit");
  });

  it("follows the document when it is moved, and is gone with it when it is deleted", async () => {
    const { deps, host } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
    const { token } = await make();
    host.seed(REF, { "Notes/Plan.fj.md": null, "Notes/Archive/Plan.fj.md": doc(ID, "Q4 plan, moved") });
    expect((await openByLink(linkDeps(deps), token, ID))?.title).toBe("Q4 plan, moved");
    host.seed(REF, { "Notes/Archive/Plan.fj.md": null });
    expect(await openByLink(linkDeps(deps), token, ID)).toBeUndefined();
  });

  it("opens no note, nothing in an encrypted vault, and nothing when the repository cannot be read", async () => {
    const encrypted = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hw", name: "Secret", createdAt: "2026-10-16T09:34:00Z", encryption: { mode: "none" }, fileNaming: "plain" });
    const a = setup({ "Notes/idea.md": doc(NOTE_ID, "An idea") });
    expect(await openByLink(linkDeps(a.deps), (await make("view", null, NOTE_ID)).token, NOTE_ID)).toBeUndefined();
    const b = setup({ "Secret/fjord.vault.json": encrypted, "Secret/Plan.fj.md": doc(ID, "Hidden") });
    expect(await openByLink(linkDeps(b.deps), (await make()).token, ID)).toBeUndefined();
    const c = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") }, { unreadable: true });
    expect(await openByLink(linkDeps(c.deps), (await make()).token, ID)).toBeUndefined();
  });

  describe("that may edit", () => {
    const editDeps = (deps: OpenDeps, drafts: { get: (connectionId: number, path: string) => Promise<{ content: string } | undefined> }) => ({ ...linkDeps(deps), drafts });

    it("is editable, from the file when there is no working copy, and from the working copy when there is, so that edits add up", async () => {
      const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
      const { token } = await make("edit");
      const none = await openByLink(editDeps(deps, { get: async () => undefined }), token, ID);
      expect(none).toMatchObject({ role: "edit", editable: true, body: "\n# Q4 plan\n\nThe plan.\n" });
      const draft = `---\nid: ${ID}\ntitle: Q4 plan\n---\n\nWhat a guest typed.\n`;
      const kept = await openByLink(editDeps(deps, { get: async () => ({ content: draft }) }), token, ID);
      expect(kept).toMatchObject({ editable: true, body: "\nWhat a guest typed.\n" });
      expect(JSON.stringify(kept)).not.toContain("x-secret");
    });

    it("is not editable for a view or comment link, which are shown the file even if there is a working copy", async () => {
      const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
      for (const role of ["view", "comment"] as const) {
        const { token } = await make(role);
        const opened = await openByLink(editDeps(deps, { get: async () => ({ content: "---\nid: x\n---\nDRAFT" }) }), token, ID);
        expect(opened).toMatchObject({ role, editable: false });
        expect(opened?.body).not.toContain("DRAFT");
      }
    });

    it("is not editable when the header cannot be kept apart: a working copy whose header is broken is shown whole, to read", async () => {
      const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
      const { token } = await make("edit");
      const opened = await openByLink(editDeps(deps, { get: async () => ({ content: "---\nid: [\n---\nbody\n" }) }), token, ID);
      expect(opened).toMatchObject({ editable: false });
    });
  });

  describe("with a password", () => {
    const protect = async () => {
      const hash = await hashPassword("correct horse battery staple");
      const made = await links.create(1, ID, "view", null, "alice", hash);
      if (!made.ok) throw new Error("not made");
      const record = (await links.byToken(made.token))!;
      return { token: made.token, proof: unlockProof(SECRET, record.id, hash), id: record.id };
    };

    it("is not opened by its token, which anyone with the link has: the proof that the password was given is what opens it", async () => {
      const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
      const { token, proof } = await protect();
      expect(await openByLink(linkDeps(deps), token, ID)).toBeUndefined();
      expect(await openByLink(linkDeps(deps), token, ID, undefined)).toBeUndefined();
      for (const wrong of ["", "x", proof.slice(1), `${proof}x`, unlockProof("t".repeat(40), 1, "$other"), token]) expect(await openByLink(linkDeps(deps), token, ID, wrong), wrong).toBeUndefined();
      expect((await openByLink(linkDeps(deps), token, ID, proof))?.title).toBe("Q4 plan");
    });

    it("is not opened by the proof of another link, even a link with the same password", async () => {
      const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
      const one = await protect();
      const two = await protect();
      expect(await openByLink(linkDeps(deps), one.token, ID, two.proof)).toBeUndefined();
      expect(await openByLink(linkDeps(deps), two.token, ID, two.proof)).toBeDefined();
    });

    it("still ends when it expires or is revoked, proof or not", async () => {
      const { deps } = setup({ "Notes/Plan.fj.md": doc(ID, "Q4 plan") });
      const { token, proof, id } = await protect();
      expect(await openByLink(linkDeps(deps), token, ID, proof)).toBeDefined();
      await links.revoke(1, ID, id);
      expect(await openByLink(linkDeps(deps), token, ID, proof)).toBeUndefined();
    });

    it("is one the page asks a password for, while it is live and of that document, and not otherwise", async () => {
      const { token, id } = await protect();
      const plain = await make();
      const deps = { links, now: () => clock };
      expect(await asksForPassword(deps, token, ID)).toBe(true);
      expect(await asksForPassword(deps, token, NOTE_ID)).toBe(false); // another document
      expect(await asksForPassword(deps, plain.token, ID)).toBe(false); // no password to ask
      expect(await asksForPassword(deps, "A".repeat(43), ID)).toBe(false);
      expect(await asksForPassword({ links, now: () => clock + 10 }, token, ID)).toBe(true);
      await links.revoke(1, ID, id);
      expect(await asksForPassword(deps, token, ID)).toBe(false);
    });
  });
});
