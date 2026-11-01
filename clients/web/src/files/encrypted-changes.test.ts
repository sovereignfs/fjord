import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import type { FakeGitHub } from "../providers/testing/fake-github";
import { githubHarness } from "../providers/testing/harnesses";
import type { Identity } from "../providers/types";
import { WorkingCopyService } from "../working/service";
import { encryptedDraft } from "../working/test-ciphertext";
import { type DeleteTarget, deletedName, deletePath } from "./delete";
import { DeletionService } from "./deletions";
import { type MoveResult, movePath, moveMessage } from "./move";
import { restoreDeleted, suffix } from "./restore";

/**
 * Renaming, moving, deleting and putting back in an encrypted vault (ROADMAP 2b.5), against a GitHub whose storage is a real git repository. The server has no key
 * and moves the bytes it is given as they are: what is asserted is that the same ciphertext blob is at the new place, that a rename never changes what a file
 * is, that a file of an id-named vault keeps the identifier it is called by, and that no plaintext appears anywhere.
 */
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const { leg } = testTarget();
let database: Database;
let deletions: DeletionService;
let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;

const ADA: Identity = { name: "Ada Lovelace", email: "ada@example.com" };
const manifest = (naming: "plain" | "id") =>
  JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Secret", createdAt: "2026-10-16T09:34:00Z", encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container: naming === "id" ? "tar" : "none", armor: false }, fileNaming: naming });
const ID = "01jagc4k7pr9tbm3ykwx6zq2hz";
const deletionTable = () => (database.dialect === "postgres" ? postgresSchema.deletion : sqliteSchema.deletion);

beforeAll(async () => {
  if (!available) return;
  ({ database } = await freshDatabase());
  await runMigrations(database);
  deletions = new DeletionService(database);
});
afterAll(async () => database?.close());
beforeEach(async () => {
  if (!available) return;
  h = await githubHarness();
  fake = h.fake;
  await dbRun(database, sql`DELETE FROM ${deletionTable()}`);
});
afterEach(async () => h?.close());

const blobOf = async (path: string) => {
  const head = await h.provider.getHead(h.repo, "main");
  if (!head.changed) throw new Error("no head");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (await h.provider.listDirectory(h.repo, head.head.commit, dir)).find((entry) => entry.path === path)!.id;
};
const seedPlain = async () => {
  const note = encryptedDraft("SECRET PLAINTEXT note");
  const doc = encryptedDraft("SECRET PLAINTEXT document");
  const before = await h.seed({ "Secret/fjord.vault.json": manifest("plain"), "Secret/recipients.txt": "age1x\n", "Secret/Plan.md.age": Buffer.from(note.bytes), "Secret/Plan.fj.md.age": Buffer.from(doc.bytes), "Secret/Sub/x.md.age": "x" });
  return { before, note, doc };
};
const seedById = async () => {
  const note = encryptedDraft("SECRET PLAINTEXT by id");
  const before = await h.seed({ "Secret/fjord.vault.json": manifest("id"), "Secret/recipients.txt": "age1x\n", [`Secret/${ID}.age`]: Buffer.from(note.bytes), "Secret/Sub/01jagc4k7pr9tbm3ykwx6zq2h0.age": "x" });
  return { before, note };
};
const move = (target: DeleteTarget, destination: string, idNamed: boolean) =>
  movePath(
    { provider: h.provider, ref: h.repo, branch: "main", format: fjord(), drafts: { paths: async () => [] as string[] }, saveDraft: async () => ({ ok: false, reason: "unavailable" }) },
    { connectionId: 1, vault: "Secret", target, destination, author: ADA, encrypted: { idNamed } },
  );
const reason = (result: MoveResult) => (result.ok ? "ok" : result.reason);
const fileTarget = async (path: string): Promise<DeleteTarget> => ({ type: "file", path, blob: await blobOf(path) });
const noPlaintext = async (commit: string) => {
  for (const [name, text] of Object.entries(await fake.filesAt(commit))) expect(text, name).not.toContain("SECRET PLAINTEXT");
};

describe("what an encrypted file is called", () => {
  it("keeps its real kind before .age, so a rename cannot make a note a document or a file something else", () => {
    expect(suffix("Secret/Plan.md.age")).toBe(".md.age");
    expect(suffix("Secret/Plan.fj.md.age")).toBe(".fj.md.age");
    expect(suffix("Secret/Plan.FJ.MD.AGE")).toBe(".fj.md.age");
    expect(suffix("Secret/report.xlsx.age")).toBe(".xlsx.age");
    expect(suffix("Secret/01jagc4k7pr9tbm3ykwx6zq2hz.age")).toBe(".age");
    expect(suffix("Notes/Plan.md")).toBe(".md");
    expect(suffix("Notes/Plan.fj.md")).toBe(".fj.md");
  });

  it("is named in a message without .age", () => {
    expect(deletedName("Secret/Plan.md.age")).toBe("Plan");
    expect(deletedName("Secret/Plan.fj.md.age")).toBe("Plan");
    expect(moveMessage("Secret/Plan.md.age", "Secret/Plan 2.md.age", 1, false)).toBe("Rename Plan to Plan 2");
  });
});

describe.skipIf(!available)(`renaming and moving in a plain-named encrypted vault (${leg})`, () => {
  it("puts the same ciphertext blob at the new name, keeping .md.age, and nothing else changes", async () => {
    const { before, note } = await seedPlain();
    const blob = await blobOf("Secret/Plan.md.age");
    const result = await move({ type: "file", path: "Secret/Plan.md.age", blob }, "Secret/Plan v2.md.age", false);
    expect(result).toMatchObject({ ok: true, moved: [{ from: "Secret/Plan.md.age", to: "Secret/Plan v2.md.age" }] });
    const commit = (result as { commit: string }).commit;
    expect(await fake.show(commit, "%P")).toBe(before);
    expect(await fake.show(commit, "%B")).toBe("Rename Plan to Plan v2");
    expect(await blobOf("Secret/Plan v2.md.age")).toBe(blob);
    expect([...(await fake.fileBytesAt(commit, "Secret/Plan v2.md.age"))]).toEqual([...note.bytes]);
    await noPlaintext(commit);
    await fake.fsck();
  });

  it("moves into a folder of the vault, and a folder to another name, with its files' blobs unchanged", async () => {
    await seedPlain();
    expect(await move(await fileTarget("Secret/Plan.fj.md.age"), "Secret/Sub/Plan.fj.md.age", false)).toMatchObject({ ok: true });
    expect(await move({ type: "folder", path: "Secret/Sub", files: 2 }, "Secret/Archive", false)).toMatchObject({ ok: true });
    const tree = Object.keys(await fake.filesAt((await fake.branchHead())!)).sort();
    expect(tree).toEqual(["Secret/Archive/Plan.fj.md.age", "Secret/Archive/x.md.age", "Secret/Plan.md.age", "Secret/fjord.vault.json", "Secret/recipients.txt"]);
  });

  it("never changes what a file is: not its kind, nor its .age", async () => {
    await seedPlain();
    expect(reason(await move(await fileTarget("Secret/Plan.md.age"), "Secret/Plan.fj.md.age", false))).toBe("extension_changed");
    expect(reason(await move(await fileTarget("Secret/Plan.md.age"), "Secret/Plan.txt.age", false))).toBe("extension_changed");
    expect(reason(await move(await fileTarget("Secret/Plan.md.age"), "Secret/Plan.md", false))).toBe("extension_changed");
    expect(reason(await move(await fileTarget("Secret/Plan.md.age"), "Secret/Plan.fj.md.age", false))).toBe("extension_changed");
  });

  it("never goes over a file or a name like it, nor out of its vault", async () => {
    await seedPlain();
    await h.provider.getHead(h.repo, "main");
    await fake.commitFiles({ "Secret/Other.md.age": "x" });
    const before = await fake.branchHead();
    expect(reason(await move(await fileTarget("Secret/Plan.md.age"), "Secret/Other.md.age", false))).toBe("path_taken");
    expect(reason(await move(await fileTarget("Secret/Plan.md.age"), "Secret/OTHER.md.age", false))).toBe("path_taken");
    expect(reason(await move(await fileTarget("Secret/Plan.md.age"), "Other/Plan.md.age", false))).toBe("other_vault");
    expect(await fake.branchHead()).toBe(before);
  });
});

describe.skipIf(!available)(`renaming and moving in an id-named encrypted vault (${leg})`, () => {
  it("moves a file to another folder, called by the same identifier, with the same blob", async () => {
    const { note } = await seedById();
    const blob = await blobOf(`Secret/${ID}.age`);
    const result = await move({ type: "file", path: `Secret/${ID}.age`, blob }, `Secret/Sub/${ID}.age`, true);
    expect(result).toMatchObject({ ok: true });
    expect(await blobOf(`Secret/Sub/${ID}.age`)).toBe(blob);
    expect([...(await fake.fileBytesAt((result as { commit: string }).commit, `Secret/Sub/${ID}.age`))]).toEqual([...note.bytes]);
  });

  it("does not rename a file: its name is its identifier, which never changes", async () => {
    await seedById();
    const before = await fake.branchHead();
    expect(reason(await move(await fileTarget(`Secret/${ID}.age`), "Secret/My plan.age", true))).toBe("id_named");
    expect(reason(await move(await fileTarget(`Secret/${ID}.age`), `Secret/Sub/01jagc4k7pr9tbm3ykwx6zq2hy.age`, true))).toBe("id_named");
    expect(await fake.branchHead()).toBe(before);
  });

  it("renames a folder, whose files keep their identifiers", async () => {
    await seedById();
    expect(await move({ type: "folder", path: "Secret/Sub", files: 1 }, "Secret/Archive", true)).toMatchObject({ ok: true });
    expect(Object.keys(await fake.filesAt((await fake.branchHead())!))).toContain("Secret/Archive/01jagc4k7pr9tbm3ykwx6zq2h0.age");
  });
});

describe.skipIf(!available)(`deleting and putting back in an encrypted vault (${leg})`, () => {
  const remove = (target: DeleteTarget) =>
    deletePath(
      { provider: h.provider, ref: h.repo, branch: "main", format: fjord(), deletions, drafts: new WorkingCopyService(database), saveDraft: async () => ({ ok: false, reason: "unavailable" }) },
      { connectionId: 1, accountId: "ada", vault: "Secret", target, kindOf: () => "other", author: ADA },
    );
  const restore = (ids: number[], path?: string, idNamed = false) =>
    restoreDeleted(
      { provider: h.provider, ref: h.repo, branch: "main", format: fjord(), deletions, vaultOk: (vault) => vault === "Secret", idNamed: () => idNamed, windowMs: 30 * 24 * 60 * 60 * 1000 },
      { connectionId: 1, ids, path, author: ADA },
    );

  it("deletes a file with no reading of it, and puts the same ciphertext back", async () => {
    const { note } = await seedPlain();
    const reads: string[] = [];
    const watching = new Proxy(h.provider, { get: (target, key, receiver) => (key === "readBlob" ? (...args: unknown[]) => (reads.push(String(args[1])), (target.readBlob as (...a: unknown[]) => unknown)(...args)) : Reflect.get(target, key, receiver)) });
    const done = await deletePath(
      { provider: watching, ref: h.repo, branch: "main", format: fjord(), deletions, drafts: new WorkingCopyService(database), saveDraft: async () => ({ ok: false, reason: "unavailable" }) },
      { connectionId: 1, accountId: "ada", vault: "Secret", target: await fileTarget("Secret/Plan.md.age"), kindOf: () => "other", author: ADA },
    );
    expect(done).toMatchObject({ ok: true, files: 1 });
    expect(reads).toEqual([]); // the server has nothing to read of an encrypted file
    expect(await fake.show((done as { commit: string }).commit, "%B")).toBe("Delete Plan");

    const back = await restore((done as { deletions: number[] }).deletions);
    expect(back).toMatchObject({ ok: true, paths: ["Secret/Plan.md.age"] });
    expect([...(await fake.fileBytesAt((back as { commit: string }).commit, "Secret/Plan.md.age"))]).toEqual([...note.bytes]);
    expect(await fake.show((back as { commit: string }).commit, "%B")).toBe("Restore Plan");
    await fake.fsck();
  });

  it("deletes a folder of an id-named vault, and puts a file back only under its identifier", async () => {
    await seedById();
    const done = await remove({ type: "file", path: `Secret/${ID}.age`, blob: await blobOf(`Secret/${ID}.age`) });
    const ids = (done as { deletions: number[] }).deletions;
    expect(await restore(ids, "Secret/Sub/Renamed.age", true)).toMatchObject({ ok: false, reason: "bad_path" });
    expect(await restore(ids, `Secret/Sub/${ID}.age`, true)).toMatchObject({ ok: true, paths: [`Secret/Sub/${ID}.age`] });
  });

  it("puts a file back in a plain-named vault under a new name, keeping its kind", async () => {
    await seedPlain();
    const done = await remove(await fileTarget("Secret/Plan.md.age"));
    const ids = (done as { deletions: number[] }).deletions;
    expect(await restore(ids, "Secret/Plan.fj.md.age")).toMatchObject({ ok: false, reason: "bad_path" });
    expect(await restore(ids, "Secret/Restored.md.age")).toMatchObject({ ok: true, paths: ["Secret/Restored.md.age"] });
  });
});
