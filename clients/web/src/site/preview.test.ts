import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { fjord, wasmAvailable } from "../format/wasm";
import { MemoryProvider } from "../providers/memory";
import type { BuildStatus, RepositoryRef } from "../providers/types";
import { WorkingCopyService } from "../working/service";
import { MAX_PREVIEWS, PREVIEW_PREFIX, WAIT_MS, branchName, isPreviewOf, outcomeOf, personTag, previewsOf, startPreview, startedAt, stopPreview } from "./preview";

/**
 * Previewing a site's unsaved changes (ROADMAP 3d.1): a branch of its own, one commit of the person's drafts, the host's report of that commit, and
 * never a write to the default branch. The host is the in-memory provider, the drafts are the real store, on whichever database the leg runs on.
 */
const { leg } = testTarget();
const available = wasmAvailable();
const REF: RepositoryRef = { owner: "acme", name: "site" };
const ALICE = { name: "Alice", email: "alice@example.com" };
const T0 = Date.UTC(2026, 10, 2, 22, 0, 0);

let database: Database;
let drafts: WorkingCopyService;
const table = () => (database.dialect === "postgres" ? postgresSchema.workingCopy : sqliteSchema.workingCopy);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  drafts = new WorkingCopyService(database);
});
afterAll(async () => database.close());
beforeEach(async () => dbRun(database, sql`DELETE FROM ${table()}`));

function site() {
  const host = new MemoryProvider();
  host.createRepository(REF, { canPush: true });
  const plan = fjord().planSetupKind({ repositoryName: "Notes", generator: "fjord-web test", kind: "ssg", engine: "astro" }, { paths: [], gitattributes: null }, 1_793_000_000_000, new Uint8Array(80).fill(3));
  if (!plan.ok) throw new Error("no plan");
  host.seed(REF, Object.fromEntries(plan.files.map((file) => [file.path, file.contents])));
  return host;
}

const deps = (host: MemoryProvider, now = T0) => ({ provider: host, ref: REF, defaultBranch: "main", drafts, connectionId: 1, vault: "content", now: () => now });
const headOf = async (host: MemoryProvider) => {
  const head = await host.getHead(REF, "main");
  if (!head.changed) throw new Error("no head");
  return head.head.commit;
};
async function blobOf(host: MemoryProvider, path: string) {
  const tree = await host.getTree(REF, await headOf(host));
  return tree.entries.find((entry) => entry.path === path)!.id;
}
async function draft(host: MemoryProvider, path: string, content: string, who = "alice") {
  await drafts.save(1, path, { baseBlob: await blobOf(host, path), content }, { type: "account", id: who });
}
const WELCOME = "content/posts/welcome.md";
const text = async (host: MemoryProvider, branch: string, path: string) => {
  const head = (await host.listBranches(REF, branch))[0]!.commit;
  const tree = await host.getTree(REF, head);
  return new TextDecoder().decode(await host.readBlob(REF, tree.entries.find((entry) => entry.path === path)!.id));
};

describe("where a preview stands", () => {
  const status = (state: BuildStatus["state"], more: Partial<BuildStatus> = {}): BuildStatus => ({ commit: "a".repeat(40), state, checks: [], ...more });
  it("is read from what the host reports of the preview's commit", () => {
    expect(outcomeOf(status("none"), T0, T0 + 1000)).toEqual({ kind: "waiting" });
    expect(outcomeOf(status("pending"), T0, T0 + 1000)).toEqual({ kind: "building" });
    expect(outcomeOf(status("success", { siteUrl: "https://p.example" }), T0, T0)).toEqual({ kind: "ready", url: "https://p.example" });
    expect(outcomeOf(status("success"), T0, T0)).toEqual({ kind: "built" });
    expect(outcomeOf(status("failure", { checks: [{ name: "build", state: "failure", url: "https://ci.example/9" }] }), T0, T0)).toEqual({ kind: "failed", url: "https://ci.example/9" });
  });

  it("says a host that has reported nothing for the wait is not building branches, rather than waiting for ever", () => {
    expect(outcomeOf(status("none"), T0, T0 + WAIT_MS)).toEqual({ kind: "waiting" });
    expect(outcomeOf(status("none"), T0, T0 + WAIT_MS + 1)).toEqual({ kind: "unsupported" });
    // Something reported, even late, is not that.
    expect(outcomeOf(status("pending"), T0, T0 + 10 * WAIT_MS)).toEqual({ kind: "building" });
  });
});

describe("a preview's branch name", () => {
  it("is the person's hash and the start time, which is read back, and says nothing of who they are", () => {
    const name = branchName("account-123", T0);
    expect(name).toBe(`${PREVIEW_PREFIX}${personTag("account-123")}-20261102t220000z`);
    expect(name).not.toContain("account-123");
    expect(startedAt(name)).toBe(T0);
    expect(startedAt(branchName("account-123", T0, 2))).toBe(T0);
    expect(isPreviewOf("account-123", name)).toBe(true);
    expect(isPreviewOf("someone-else", name)).toBe(false);
    for (const other of ["main", "fjord/preview/", `${PREVIEW_PREFIX}${personTag("account-123")}-nope`, "feature/x"]) expect(isPreviewOf("account-123", other), other).toBe(false);
  });
});

describe.skipIf(!available)(`a site's preview (${leg})`, () => {
  it("is a branch of its own with one commit of the drafts, and the default branch is never written", async () => {
    const host = site();
    await draft(host, WELCOME, "---\ntitle: Welcome\ndate: 2026-11-02\n---\n\nEdited, not saved.\n");
    const before = await headOf(host);
    const original = new TextDecoder().decode(await host.readBlob(REF, await blobOf(host, WELCOME)));

    const made = await startPreview(deps(host), { accountId: "alice", author: ALICE });
    expect(made).toMatchObject({ ok: true, branch: branchName("alice", T0), files: [WELCOME], skipped: [] });
    if (!made.ok) return;

    expect(await headOf(host), "the default branch has not moved").toBe(before);
    expect(new TextDecoder().decode(await host.readBlob(REF, await blobOf(host, WELCOME)))).toBe(original);
    expect(await text(host, made.branch, WELCOME)).toContain("Edited, not saved.");
    expect((await host.listBranches(REF, PREVIEW_PREFIX)).map((b) => b.branch)).toEqual([made.branch]);
    // The person's draft is still theirs: previewing is not saving a version.
    expect(await drafts.get(1, WELCOME)).toBeDefined();
  });

  it("shows the address the host gave for the preview's commit, and never the default branch's", async () => {
    const host = site();
    await draft(host, WELCOME, "---\ntitle: Welcome\ndate: 2026-11-02\n---\n\nEdited.\n");
    // The default branch's site is built and has an address: the preview must not borrow it.
    host.reportBuild(REF, await headOf(host), { checks: [{ name: "build", state: "success" }], siteUrl: "https://main.example" });
    const made = await startPreview(deps(host), { accountId: "alice", author: ALICE });
    if (!made.ok) throw new Error("no preview");

    expect((await previewsOf(deps(host, T0 + 1000), "alice"))[0]?.outcome).toEqual({ kind: "waiting" });
    host.reportBuild(REF, made.commit, { checks: [{ name: "build", state: "pending" }] });
    expect((await previewsOf(deps(host, T0 + 1000), "alice"))[0]?.outcome).toEqual({ kind: "building" });
    host.reportBuild(REF, made.commit, { checks: [{ name: "build", state: "success" }], siteUrl: "https://preview-abc.example" });
    expect((await previewsOf(deps(host, T0 + 1000), "alice"))[0]?.outcome).toEqual({ kind: "ready", url: "https://preview-abc.example" });
  });

  it("tells a host that builds no branches so, after the wait, with the preview still there to stop", async () => {
    const host = site();
    await draft(host, WELCOME, "---\ntitle: Welcome\ndate: 2026-11-02\n---\n\nEdited.\n");
    await startPreview(deps(host), { accountId: "alice", author: ALICE });
    expect((await previewsOf(deps(host, T0 + WAIT_MS + 1), "alice"))[0]?.outcome).toEqual({ kind: "unsupported" });
  });

  it("leaves out a draft of a file that changed upstream, and says so, and previews nothing if that is all there is", async () => {
    const host = site();
    await draft(host, WELCOME, "---\ntitle: Welcome\n---\n\nMine.\n");
    host.seed(REF, { [WELCOME]: "---\ntitle: Welcome\n---\n\nSomeone else's change.\n" });
    const before = await headOf(host);
    expect(await startPreview(deps(host), { accountId: "alice", author: ALICE })).toEqual({ ok: false, reason: "nothing_to_preview", skipped: [{ path: WELCOME, reason: "changed_upstream" }] });
    expect(await headOf(host)).toBe(before);
    expect(await host.listBranches(REF, PREVIEW_PREFIX), "a refused preview leaves no branch").toEqual([]);
  });

  it("previews only the person's own drafts, in the site's vault, and never an encrypted one", async () => {
    const host = site();
    await draft(host, WELCOME, "---\ntitle: Welcome\n---\n\nBob's.\n", "bob");
    expect(await startPreview(deps(host), { accountId: "alice", author: ALICE })).toMatchObject({ ok: false, reason: "nothing_to_preview" });
    const ciphertext = Buffer.from("age-encryption.org/v1\n-> X25519 abc\n--- def\n", "utf8").toString("base64");
    expect((await drafts.save(1, "content/posts/enc.md", { baseBlob: "b".repeat(40), content: ciphertext, encrypted: true }, { type: "account", id: "alice" })).ok).toBe(true);
    await drafts.save(1, "README.md", { baseBlob: await blobOf(host, "README.md"), content: "# Changed\n" }, { type: "account", id: "alice" });
    const result = await startPreview(deps(host), { accountId: "alice", author: ALICE });
    expect(result).toMatchObject({ ok: false, reason: "nothing_to_preview", skipped: [{ path: "content/posts/enc.md", reason: "not_text" }] });
    expect(await host.listBranches(REF, PREVIEW_PREFIX)).toEqual([]);
  });

  it("makes nothing of a draft that changes nothing, and removes the branch it had made", async () => {
    const host = site();
    const same = new TextDecoder().decode(await host.readBlob(REF, await blobOf(host, WELCOME)));
    await draft(host, WELCOME, same);
    expect(await startPreview(deps(host), { accountId: "alice", author: ALICE })).toMatchObject({ ok: false, reason: "nothing_to_preview" });
    expect(await host.listBranches(REF, PREVIEW_PREFIX)).toEqual([]);
  });

  it("is at most a few at once, and a second in the same second is a second preview", async () => {
    const host = site();
    await draft(host, WELCOME, "---\ntitle: Welcome\n---\n\nEdited.\n");
    const names: string[] = [];
    for (let i = 0; i < MAX_PREVIEWS; i++) {
      const made = await startPreview(deps(host), { accountId: "alice", author: ALICE });
      expect(made.ok, String(i)).toBe(true);
      if (made.ok) names.push(made.branch);
    }
    expect(new Set(names).size).toBe(MAX_PREVIEWS);
    expect(await startPreview(deps(host), { accountId: "alice", author: ALICE })).toMatchObject({ ok: false, reason: "too_many" });
    // Another person's previews are not Alice's to count or see.
    expect(await previewsOf(deps(host), "bob")).toEqual([]);
  });

  it("stops only a preview of the person's own: another's, the default branch and a stranger's branch are refused", async () => {
    const host = site();
    await draft(host, WELCOME, "---\ntitle: Welcome\n---\n\nEdited.\n");
    const mine = await startPreview(deps(host), { accountId: "alice", author: ALICE });
    if (!mine.ok) throw new Error("no preview");
    await host.createBranch(REF, "feature/work", await headOf(host));
    const before = await headOf(host);

    for (const branch of [mine.branch, "main", "feature/work", "fjord/preview/"]) {
      expect(await stopPreview(deps(host), { accountId: "bob", branch }), branch).toEqual({ ok: false, reason: "not_yours" });
    }
    expect(await stopPreview(deps(host), { accountId: "alice", branch: "main" })).toEqual({ ok: false, reason: "not_yours" });
    expect(await stopPreview(deps(host), { accountId: "alice", branch: "feature/work" })).toEqual({ ok: false, reason: "not_yours" });
    expect((await host.listBranches(REF, "")).map((b) => b.branch).sort()).toEqual(["feature/work", mine.branch, "main"].sort());

    expect(await stopPreview(deps(host), { accountId: "alice", branch: mine.branch })).toEqual({ ok: true });
    expect(await stopPreview(deps(host), { accountId: "alice", branch: mine.branch })).toEqual({ ok: false, reason: "gone" });
    expect(await headOf(host), "the default branch was never touched").toBe(before);
  });
});
