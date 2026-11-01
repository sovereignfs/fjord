import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import type { Provider } from "../providers/types";
import type { FakeGitHub } from "../providers/testing/fake-github";
import { githubHarness } from "../providers/testing/harnesses";
import { OURS_LABEL, THEIRS_LABEL, previewCombine, resolveUpstream } from "./resolve";
import { type Editor, WorkingCopyService } from "./service";
import { encryptedDraft } from "./test-ciphertext";
import { saveVersion } from "./version";

/**
 * Going on after the file changed in the repository (ROADMAP 1b.10), against a GitHub whose storage is a real git
 * repository, with the real merge (`fjord-core`'s, as WebAssembly). What matters: nothing is ever written over what someone
 * else committed, a choice is made only about the version the person saw, and both sides survive every outcome.
 *
 * It needs the format module built (`pnpm build:wasm`); where it is not, these are skipped, except in CI.
 */
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const { leg } = testTarget();
let database: Database;
let drafts: WorkingCopyService;
let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;
let clock = 1_800_000_000_000;

const ADA: Editor = { type: "account", id: "ada" };
const table = () => (database.dialect === "postgres" ? postgresSchema.workingCopy : sqliteSchema.workingCopy);
const FIVE = "one\ntwo\nthree\nfour\nfive\n";

beforeAll(async () => {
  if (!available) return;
  ({ database } = await freshDatabase());
  await runMigrations(database);
  drafts = new WorkingCopyService(database, { now: () => clock });
});
afterAll(async () => database?.close());
beforeEach(async () => {
  if (!available) return;
  h = await githubHarness();
  fake = h.fake;
  await dbRun(database, sql`DELETE FROM ${table()}`);
});
afterEach(async () => h?.close());

const blobOf = async (path: string) => {
  const head = await h.provider.getHead(h.repo, "main");
  if (!head.changed) throw new Error("no head");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (await h.provider.listDirectory(h.repo, head.head.commit, dir)).find((entry) => entry.path === path)!.id;
};
const deps = (provider: Provider = h.provider) => ({ drafts, provider, ref: h.repo, branch: "main", format: fjord() });
const resolve = async (choice: "mine" | "combine", over: { upstreamBlob?: string; path?: string; provider?: Provider } = {}) =>
  resolveUpstream(deps(over.provider), { connectionId: 1, path: over.path ?? "n.md", choice, upstreamBlob: over.upstreamBlob ?? (await blobOf(over.path ?? "n.md")), editor: ADA });

/** A file in the repository, a draft of it, and then someone else's commit of it: the three texts. */
async function diverge(base: string, mine: string, theirs: string) {
  await h.seed({ "n.md": base, "other.md": "o" });
  const baseBlob = await blobOf("n.md");
  await drafts.save(1, "n.md", { baseBlob, content: mine }, ADA);
  const commit = await fake.commitFiles({ "n.md": theirs });
  return { baseBlob, commit, theirsBlob: await blobOf("n.md") };
}

describe.skipIf(!available)(`going on after the file changed (${leg})`, () => {
  describe("keep mine", () => {
    it("moves the draft onto the file as it is, with the text unchanged, and writes nothing to the repository", async () => {
      const { commit, theirsBlob } = await diverge("base\n", "mine\n", "theirs\n");
      expect(await resolve("mine")).toEqual({ ok: true, conflicts: 0 });
      expect(await drafts.get(1, "n.md")).toMatchObject({ baseBlob: theirsBlob, content: "mine\n" });
      expect(await fake.branchHead()).toBe(commit);
      await fake.fsck();
    });

    it("is then a version on top of theirs, which stays in the history: neither side is lost", async () => {
      const { commit } = await diverge("base\n", "mine\n", "theirs\n");
      await resolve("mine");
      const made = await saveVersion(
        { drafts, provider: h.provider, ref: h.repo, branch: "main", identityOf: async () => undefined },
        { connectionId: 1, path: "n.md", author: { name: "Ada", email: "ada@example.com" }, authorId: "ada" },
      );
      expect(made.ok).toBe(true);
      const version = (made as { commit: string }).commit;
      expect(await fake.show(version, "%P")).toBe(commit);
      expect(await fake.filesAt(version)).toMatchObject({ "n.md": "mine\n" });
      expect(await fake.filesAt(commit)).toMatchObject({ "n.md": "theirs\n" });
    });
  });

  describe("combine", () => {
    it("merges edits in different places into the draft, on the file as it is", async () => {
      const { commit, theirsBlob } = await diverge(FIVE, FIVE.replace("one", "ONE"), FIVE.replace("five", "FIVE"));
      expect(await resolve("combine")).toEqual({ ok: true, conflicts: 0 });
      expect(await drafts.get(1, "n.md")).toMatchObject({ baseBlob: theirsBlob, content: "ONE\ntwo\nthree\nfour\nFIVE\n" });
      expect(await fake.branchHead()).toBe(commit);
    });

    it("puts edits in the same place between markers, both sides in the text, and says how many", async () => {
      await diverge("a\nsame\nz\n", "a\nmine\nz\n", "a\ntheirs\nz\n");
      expect(await resolve("combine")).toEqual({ ok: true, conflicts: 1 });
      expect((await drafts.get(1, "n.md"))?.content).toBe(`a\n<<<<<<< ${OURS_LABEL}\nmine\n=======\ntheirs\n>>>>>>> ${THEIRS_LABEL}\nz\n`);
    });

    it("keeps line endings, a byte order mark and what is not ASCII", async () => {
      const base = "﻿# 日本\r\n\r\nline  \r\nlast";
      await diverge(base, base.replace("line  ", "LINE  "), base.replace("日本", "日本語"));
      expect(await resolve("combine")).toEqual({ ok: true, conflicts: 0 });
      expect((await drafts.get(1, "n.md"))?.content).toBe("﻿# 日本語\r\n\r\nLINE  \r\nlast");
    });

    it("takes what the file now has when the draft changed nothing, and what the draft has when the file did not", async () => {
      await diverge("base\n", "base\n", "theirs\n");
      await resolve("combine");
      expect((await drafts.get(1, "n.md"))?.content).toBe("theirs\n");
    });
  });

  describe("only about what the person saw, and only if it is still so", () => {
    it("does nothing when the file changed again since: the page looks again", async () => {
      const { theirsBlob } = await diverge("base\n", "mine\n", "theirs\n");
      const newer = await fake.commitFiles({ "n.md": "theirs, again\n" });
      for (const choice of ["mine", "combine"] as const) expect(await resolve(choice, { upstreamBlob: theirsBlob })).toEqual({ ok: false, reason: "upstream_moved" });
      expect(await drafts.get(1, "n.md")).toMatchObject({ content: "mine\n", baseBlob: expect.not.stringMatching(theirsBlob) });
      expect(await fake.branchHead()).toBe(newer);
    });

    it("does nothing when the file is the one the draft is of", async () => {
      await h.seed({ "n.md": "base\n" });
      await drafts.save(1, "n.md", { baseBlob: await blobOf("n.md"), content: "mine\n" }, ADA);
      expect(await resolve("mine")).toEqual({ ok: false, reason: "up_to_date" });
      expect(await resolve("combine")).toEqual({ ok: false, reason: "up_to_date" });
    });

    it("does nothing when the file was deleted: there is nothing to go on from", async () => {
      await h.seed({ "n.md": "base\n", "keep.md": "k" });
      await drafts.save(1, "n.md", { baseBlob: await blobOf("n.md"), content: "mine\n" }, ADA);
      await fake.commitFiles({ "n.md": null });
      expect(await resolveUpstream(deps(), { connectionId: 1, path: "n.md", choice: "mine", upstreamBlob: "a".repeat(40), editor: ADA })).toEqual({ ok: false, reason: "gone" });
      expect(await drafts.get(1, "n.md")).toMatchObject({ content: "mine\n" });
    });

    it("has nothing to do without a draft", async () => {
      await h.seed({ "n.md": "base\n" });
      expect(await resolve("mine")).toEqual({ ok: false, reason: "no_draft" });
    });

    it("keeps what was typed while it was being decided, and moves nothing", async () => {
      await diverge(FIVE, FIVE.replace("one", "ONE"), FIVE.replace("five", "FIVE"));
      const before = (await drafts.get(1, "n.md"))!;
      fake.before(/\/git\/blobs\//, async () => {
        clock += 10;
        await drafts.save(1, "n.md", { baseBlob: before.baseBlob, content: "typed meanwhile" }, ADA);
      });
      expect(await resolve("combine")).toEqual({ ok: false, reason: "draft_changed" });
      expect(await drafts.get(1, "n.md")).toMatchObject({ baseBlob: before.baseBlob, content: "typed meanwhile" });
    });
  });

  describe("what cannot be combined", () => {
    it("says so for a file that is not text now, and still lets the person keep theirs", async () => {
      await h.seed({ "n.md": "base\n" });
      await drafts.save(1, "n.md", { baseBlob: await blobOf("n.md"), content: "mine\n" }, ADA);
      await fake.commitFiles({ "n.md": Uint8Array.from([0x68, 0xff, 0xfe, 0x0a]) });
      expect(await resolve("combine")).toEqual({ ok: false, reason: "unreadable" });
      expect(await resolve("mine")).toEqual({ ok: true, conflicts: 0 });
    });

    it("refuses a merge that cannot be kept as a draft (a NUL that came from the repository), and leaves the draft alone", async () => {
      await h.seed({ "n.md": "base\n" });
      const baseBlob = await blobOf("n.md");
      await drafts.save(1, "n.md", { baseBlob, content: "mine\n" }, ADA);
      await fake.commitFiles({ "n.md": "base\nwith\u0000nul\n" });
      expect(await resolve("combine")).toEqual({ ok: false, reason: "unstorable" });
      expect(await drafts.get(1, "n.md")).toMatchObject({ baseBlob, content: "mine\n" });
    });

    it("says so, and moves nothing, when the token was revoked or the host is down", async () => {
      const { theirsBlob } = await diverge("base\n", "mine\n", "theirs\n");
      expect(await resolve("mine", { provider: h.revoked!(), upstreamBlob: theirsBlob })).toEqual({ ok: false, reason: "bad_token" });
      fake.fail(/.*/, { status: 503, body: { message: "down" }, times: 20 });
      expect(await resolve("mine", { upstreamBlob: theirsBlob })).toEqual({ ok: false, reason: "unavailable" });
      expect((await drafts.get(1, "n.md"))?.content).toBe("mine\n");
    });
  });

  describe("what the page can say first", () => {
    it("whether the two combine, and over how many places they do not", async () => {
      const p = (await diverge(FIVE, FIVE.replace("one", "ONE"), FIVE.replace("five", "FIVE")), (await drafts.get(1, "n.md"))!);
      const upstream = FIVE.replace("five", "FIVE");
      expect(await previewCombine(h.provider, h.repo, fjord(), p, upstream)).toEqual({ state: "clean" });
      expect(await previewCombine(h.provider, h.repo, fjord(), { ...p, content: FIVE.replace("five", "mine") }, upstream)).toEqual({ state: "conflicts", conflicts: 1 });
    });

    it("that it cannot tell, when the version the draft started from cannot be read", async () => {
      await diverge("base\n", "mine\n", "theirs\n");
      const draft = (await drafts.get(1, "n.md"))!;
      expect(await previewCombine(h.provider, h.repo, fjord(), { ...draft, baseBlob: "e".repeat(40) }, "theirs\n")).toEqual({ state: "unavailable" });
    });
  });
});

describe.skipIf(!available)(`going on after an encrypted file changed (${leg})`, () => {
  async function divergeEncrypted() {
    await h.seed({ "Secret/n.age": "old ciphertext" });
    const baseBlob = await blobOf("Secret/n.age");
    const mine = encryptedDraft("SECRET PLAINTEXT mine");
    await drafts.save(1, "Secret/n.age", { baseBlob, content: mine.content, encrypted: true }, ADA);
    const commit = await fake.commitFiles({ "Secret/n.age": "theirs ciphertext" });
    return { baseBlob, commit, mine, theirsBlob: await blobOf("Secret/n.age") };
  }

  it("keeps mine by moving the ciphertext onto the file as it is, still encrypted, and writes nothing", async () => {
    const { commit, mine, theirsBlob } = await divergeEncrypted();
    expect(await resolve("mine", { path: "Secret/n.age" })).toEqual({ ok: true, conflicts: 0 });
    expect(await drafts.get(1, "Secret/n.age")).toMatchObject({ baseBlob: theirsBlob, content: mine.content, encrypted: true });
    expect(await fake.branchHead()).toBe(commit);
  });

  it("does not combine, as the server has no key to read either side, and changes nothing", async () => {
    const { baseBlob, mine } = await divergeEncrypted();
    expect(await resolve("combine", { path: "Secret/n.age" })).toEqual({ ok: false, reason: "encrypted" });
    expect(await drafts.get(1, "Secret/n.age")).toMatchObject({ baseBlob, content: mine.content });
  });

  it("offers no preview of a combination", async () => {
    await divergeEncrypted();
    const draft = (await drafts.get(1, "Secret/n.age"))!;
    expect(await previewCombine(h.provider, h.repo, fjord(), draft, "anything")).toEqual({ state: "unavailable" });
  });
});
