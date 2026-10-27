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
import { WorkingCopyService } from "../working/service";
import { type GuestDeps, saveGuestDraft } from "./guest";
import { LinkService } from "./links";
import { hashPassword, unlockProof } from "./password";

/**
 * Editing through a link (ROADMAP 1c.6): the real format module and databases, an in-memory host for the owner's repository. What matters is
 * who is let to edit (a live link of this document whose role may), what they cannot touch (the header), where it goes (the working copy,
 * under their name) and what a wrong cookie learns (nothing).
 */
const { leg } = testTarget();
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const REF: RepositoryRef = { owner: "acme", name: "notes" };
const VAULT = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });
const ID = "01jagc4k7pt8y3wqnmzv5xrb8j";
const HEADER = `---\nid: ${ID}\ntitle: Q4 plan\nx-secret: not for the guest\n---\n`;
const DOC = `${HEADER}\n# Q4 plan\n\nThe plan.\n`;
const SECRET = "s".repeat(40);
const PATH = "Notes/Plan.fj.md";

let database: Database;
let links: LinkService;
let drafts: WorkingCopyService;
let clock = 1_800_000_000_000;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  links = new LinkService(database, { now: () => clock });
  drafts = new WorkingCopyService(database, { now: () => clock });
});
afterAll(async () => database?.close());
beforeEach(async () => {
  clock = 1_800_000_000_000;
  const schema = database.dialect === "postgres" ? postgresSchema : sqliteSchema;
  for (const table of [schema.shareLink, schema.workingCopy, schema.docIndex, schema.treeCache]) await dbRun(database, sql`DELETE FROM ${table}`);
});

function setup(files: Record<string, string | null> = { [PATH]: DOC }) {
  const host = new MemoryProvider();
  host.createRepository(REF);
  host.seed(REF, { "Notes/fjord.vault.json": VAULT, ...files });
  const deps: GuestDeps = {
    links,
    secret: SECRET,
    sourceOf: async (connectionId): Promise<Source | undefined> => {
      const read = await readRepository({ provider: host, cache: new TreeCache(database), format: fjord() }, { id: connectionId, ref: REF, branch: "main" });
      return { connectionId, ref: REF, read, provider: host };
    },
    index: new DocIndex(database),
    format: fjord(),
    drafts,
    now: () => clock,
  };
  return { host, deps };
}

const link = async (role: "view" | "comment" | "edit", over: { expiresAt?: number | null; password?: string } = {}) => {
  const hash = over.password === undefined ? null : await hashPassword(over.password);
  const made = await links.create(1, ID, role, over.expiresAt ?? null, "alice", hash);
  if (!made.ok) throw new Error("not made");
  const record = (await links.byToken(made.token))!;
  return { ...made, cookie: hash === null ? made.token : `${made.token}.${unlockProof(SECRET, record.id, hash)}`, linkId: record.id };
};
const edit = (cookie: string | undefined, body: string, name: unknown = "Grace Hopper", docId = ID) => ({ cookie, docId, name, body });

describe.skipIf(!available)(`editing through a link (${leg})`, () => {
  it("keeps what is typed as the document's working copy, under the name given, with the header exactly as it was", async () => {
    const { deps, host } = setup();
    const { cookie, linkId } = await link("edit");
    const head = await host.getHead(REF, "main");
    const result = await saveGuestDraft(deps, edit(cookie, "\n# Q4 plan\n\nThe plan, and a guest's line.\n"));
    expect(result).toEqual({ ok: true, savedAt: expect.any(Number) });
    const draft = (await drafts.get(1, PATH))!;
    expect(draft.content).toBe(`${HEADER}\n# Q4 plan\n\nThe plan, and a guest's line.\n`);
    expect(draft.editors).toEqual([{ type: "guest", link: linkId, name: "Grace Hopper" }]);
    // The repository itself is untouched: a draft is not a version.
    expect(await host.getHead(REF, "main")).toEqual(head);
  });

  it("cannot change the header, whatever it sends: it is put in front of the body as it is, never taken from the guest", async () => {
    const { deps } = setup();
    const { cookie } = await link("edit");
    await saveGuestDraft(deps, edit(cookie, `---\nid: 01jagc4k7pt8y3wqnmzv5xrbzz\ntitle: Hacked\n---\n\nbody\n`));
    const draft = (await drafts.get(1, PATH))!;
    expect(draft.content.startsWith(HEADER)).toBe(true);
    expect(draft.content.slice(HEADER.length)).toContain("title: Hacked"); // it is body text now, below the real header
    expect(draft.content.match(/^id: /gm)).toHaveLength(2);
    expect(draft.content.indexOf(`id: ${ID}`)).toBeLessThan(draft.content.indexOf("id: 01jagc4k7pt8y3wqnmzv5xrbzz"));
  });

  it("goes on from the working copy, not the file, so that what two people type adds up, and both are in the list", async () => {
    const { deps } = setup();
    const { cookie, linkId } = await link("edit");
    await saveGuestDraft(deps, edit(cookie, "\nfirst\n", "Grace Hopper"));
    clock += 10;
    await saveGuestDraft(deps, edit(cookie, "\nsecond\n", "Ada Lovelace"));
    const draft = (await drafts.get(1, PATH))!;
    expect(draft.content).toBe(`${HEADER}\nsecond\n`);
    expect(draft.editors).toEqual([{ type: "guest", link: linkId, name: "Grace Hopper" }, { type: "guest", link: linkId, name: "Ada Lovelace" }]);
    // The same name twice is one editor.
    await saveGuestDraft(deps, edit(cookie, "\nthird\n", "Grace Hopper"));
    expect((await drafts.get(1, PATH))!.editors).toHaveLength(2);
  });

  it("keeps the base the draft was started from, whoever saves it", async () => {
    const { deps, host } = setup();
    const { cookie } = await link("edit");
    await saveGuestDraft(deps, edit(cookie, "\nfirst\n"));
    const base = (await drafts.get(1, PATH))!.baseBlob;
    host.seed(REF, { [PATH]: `${HEADER}\nchanged in the repository\n` });
    await saveGuestDraft(deps, edit(cookie, "\nsecond\n"));
    expect((await drafts.get(1, PATH))!.baseBlob).toBe(base);
  });

  it("starts no draft when nothing differs from the file", async () => {
    const { deps } = setup();
    const { cookie } = await link("edit");
    expect(await saveGuestDraft(deps, edit(cookie, "\n# Q4 plan\n\nThe plan.\n"))).toMatchObject({ ok: true });
    expect(await drafts.get(1, PATH)).toBeUndefined();
  });

  it("is refused for a view link and a comment link, which may read: forbidden, and nothing is kept", async () => {
    const { deps } = setup();
    for (const role of ["view", "comment"] as const) {
      const { cookie } = await link(role);
      expect(await saveGuestDraft(deps, edit(cookie, "\nx\n"))).toEqual({ ok: false, reason: "forbidden" });
    }
    expect(await drafts.get(1, PATH)).toBeUndefined();
  });

  it("is turned away as if there were nothing for a missing cookie, a wrong one, another document's link, and a link that has ended", async () => {
    const { deps } = setup();
    const good = await link("edit");
    const ended = await link("edit", { expiresAt: clock + 1000 });
    const revoked = await link("edit");
    await links.revoke(1, ID, revoked.id);
    clock += 1000;
    for (const cookie of [undefined, "", "A".repeat(43), "nonsense", ended.cookie, revoked.cookie]) {
      expect(await saveGuestDraft(deps, edit(cookie, "\nx\n")), String(cookie)).toEqual({ ok: false, reason: "hidden" });
    }
    expect(await saveGuestDraft(deps, edit(good.cookie, "\nx\n", "Grace", "01jagc4k7pt8y3wqnmzv5xrbzz"))).toEqual({ ok: false, reason: "hidden" });
    expect(await drafts.get(1, PATH)).toBeUndefined();
  });

  it("opens no other document than the link's, even one in the same repository", async () => {
    const OTHER = "01jagc4k7pt8y3wqnmzv5xrbzz";
    const { deps } = setup({ [PATH]: DOC, "Notes/Other.fj.md": `---\nid: ${OTHER}\ntitle: Private\n---\n\nprivate\n` });
    const { cookie } = await link("edit");
    expect(await saveGuestDraft(deps, edit(cookie, "\nvandalised\n", "Grace", OTHER))).toEqual({ ok: false, reason: "hidden" });
    expect(await drafts.get(1, "Notes/Other.fj.md")).toBeUndefined();
  });

  it("will not go on from a working copy whose header the owner has broken, which could not be kept apart", async () => {
    const { deps } = setup();
    const { cookie } = await link("edit");
    const base = (await deps.sourceOf(1))!.read.blobs.get(PATH)!;
    await drafts.save(1, PATH, { baseBlob: base, content: `---\nid: ${ID}\nbroken: [\n---\nbody\n` }, { type: "account", id: "alice" });
    expect(await saveGuestDraft(deps, edit(cookie, "\nx\n"))).toEqual({ ok: false, reason: "not_editable" });
  });

  it("needs the proof of the password for a link that has one, and the token alone is not enough", async () => {
    const { deps } = setup();
    const { token, cookie } = await link("edit", { password: "correct horse battery staple" });
    for (const bad of [token, `${token}.`, `${token}.${"A".repeat(43)}`]) expect(await saveGuestDraft(deps, edit(bad, "\nx\n")), bad).toEqual({ ok: false, reason: "hidden" });
    expect(await drafts.get(1, PATH)).toBeUndefined();
    expect(await saveGuestDraft(deps, edit(cookie, "\nx\n"))).toMatchObject({ ok: true });
  });

  it("needs a name, one line of up to 40 characters, and keeps nothing without one", async () => {
    const { deps } = setup();
    const { cookie } = await link("edit");
    for (const name of [null, "", "   ", 7, "a".repeat(41), "<b>", "Grace\u0000"]) expect(await saveGuestDraft(deps, edit(cookie, "\nx\n", name)), String(name)).toEqual({ ok: false, reason: "bad_name" });
    expect(await drafts.get(1, PATH)).toBeUndefined();
    await saveGuestDraft(deps, edit(cookie, "\nx\n", "  Grace   Hopper "));
    expect((await drafts.get(1, PATH))!.editors).toMatchObject([{ name: "Grace Hopper" }]);
  });

  it("does not edit a note, a document in an encrypted vault, or one whose header cannot be read", async () => {
    const encrypted = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hw", name: "Secret", createdAt: "2026-10-16T09:34:00Z", encryption: { mode: "none" }, fileNaming: "plain" });
    const a = setup({ "Notes/idea.md": DOC });
    expect(await saveGuestDraft(a.deps, edit((await link("edit")).cookie, "\nx\n"))).toEqual({ ok: false, reason: "hidden" });
    const b = setup({ "Secret/fjord.vault.json": encrypted, "Secret/Plan.fj.md": DOC });
    expect(await saveGuestDraft(b.deps, edit((await link("edit")).cookie, "\nx\n"))).toEqual({ ok: false, reason: "hidden" });
    // A header that cannot be read has no id, so it is not the document the link is of.
    const c = setup({ [PATH]: `---\nid: ${ID}\nbroken: [\n---\nbody\n` });
    expect(await saveGuestDraft(c.deps, edit((await link("edit")).cookie, "\nx\n"))).toEqual({ ok: false, reason: "hidden" });
  });

  it("keeps what is typed even if the document has since been moved, and finds nothing once it is gone", async () => {
    const { deps, host } = setup();
    const { cookie } = await link("edit");
    host.seed(REF, { [PATH]: null, "Notes/Archive/Plan.fj.md": DOC });
    expect(await saveGuestDraft(deps, edit(cookie, "\nmoved\n"))).toMatchObject({ ok: true });
    expect(await drafts.get(1, "Notes/Archive/Plan.fj.md")).toBeDefined();
    host.seed(REF, { "Notes/Archive/Plan.fj.md": null });
    expect(await saveGuestDraft(deps, edit(cookie, "\ngone\n"))).toEqual({ ok: false, reason: "hidden" });
  });

  it("refuses text that cannot be kept, and says unavailable when the repository cannot be read", async () => {
    const { deps } = setup();
    const { cookie } = await link("edit");
    expect(await saveGuestDraft(deps, edit(cookie, "\nNUL \u0000\n"))).toMatchObject({ ok: false, reason: "unstorable" });
    expect(await saveGuestDraft({ ...deps, sourceOf: async () => undefined }, edit(cookie, "\nx\n"))).toEqual({ ok: false, reason: "unavailable" });
  });

  it("stops taking new names once the draft has as many editors as it keeps, and still takes those it has", async () => {
    const { deps } = setup();
    const { cookie } = await link("edit");
    for (let i = 0; i < 50; i++) expect((await saveGuestDraft(deps, edit(cookie, `\nedit ${i}\n`, `Guest ${i}`))).ok).toBe(true);
    expect(await saveGuestDraft(deps, edit(cookie, "\nmore\n", "One too many"))).toEqual({ ok: false, reason: "too_many_editors" });
    expect((await saveGuestDraft(deps, edit(cookie, "\nmore\n", "Guest 3"))).ok).toBe(true);
  });
});
