import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import type { Identity, Provider } from "../providers/types";
import type { FakeGitHub } from "../providers/testing/fake-github";
import { githubHarness } from "../providers/testing/harnesses";
import { wasmAvailable } from "../format/wasm";
import { type Editor, WorkingCopyService } from "./service";
import { encryptedDraft } from "./test-ciphertext";
import { composeMessage, defaultMessage, formatIdentity, guestIdentity, saveVersion } from "./version";

/**
 * Making a version from a draft (ROADMAP 1b.9), against a GitHub whose storage is a real git repository, so that what
 * git itself says about the commit is what is asserted: its parent, its author, its trailers, its bytes. Drafts are on
 * the real databases.
 */
const { leg } = testTarget();
let database: Database;
let drafts: WorkingCopyService;
let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;
let clock = 1_800_000_000_000;

const ADA: Identity = { name: "Ada Lovelace", email: "ada@example.com" };
const PEOPLE: Record<string, Identity> = {
  ada: ADA,
  grace: { name: "Grace Hopper", email: "grace@example.com" },
  soren: { name: "Søren", email: "soren@example.com" },
};
const ed = (id: string): Editor => ({ type: "account", id });
const table = () => (database.dialect === "postgres" ? postgresSchema.workingCopy : sqliteSchema.workingCopy);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  drafts = new WorkingCopyService(database, { now: () => clock });
});
afterAll(async () => database.close());
beforeEach(async () => {
  h = await githubHarness();
  fake = h.fake;
  await dbRun(database, sql`DELETE FROM ${table()}`);
});
afterEach(async () => h.close());

const deps = (provider: Provider = h.provider) => ({ drafts, provider, ref: h.repo, branch: "main", identityOf: async (editor: Editor) => (editor.type === "account" ? PEOPLE[editor.id] : undefined) });
const encode = (text: string) => new TextEncoder().encode(text);
const blobOf = async (path: string) => {
  const head = await h.provider.getHead(h.repo, "main");
  if (!head.changed) throw new Error("no head");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (await h.provider.listDirectory(h.repo, head.head.commit, dir)).find((entry) => entry.path === path)!.id;
};
/** A draft of `path`, started from the file as it is now, as typed by these people. */
async function draftOf(path: string, content: string, ...by: string[]) {
  const baseBlob = await blobOf(path);
  for (const id of by.length ? by : ["ada"]) await drafts.save(1, path, { baseBlob, content }, ed(id));
  return baseBlob;
}
const version = (path: string, over: { message?: string; author?: Identity; authorId?: string; provider?: Provider } = {}) =>
  saveVersion(deps(over.provider), { connectionId: 1, path, message: over.message, author: over.author ?? ADA, authorId: over.authorId ?? "ada" });

describe(`a version from a draft (${leg})`, () => {
  it("is one commit on top of the head, with the draft's text as the file's bytes and nothing else changed", async () => {
    const before = await h.seed({ "Notes/n.md": "# Old\n", "Notes/other.md": "keep", "README.md": "r" });
    const text = "﻿# New\r\n\r\ntrailing  \t\r\nünï 💧\n\n";
    await draftOf("Notes/n.md", text);

    const result = await version("Notes/n.md");
    expect(result).toEqual({ ok: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const commit = (result as { commit: string }).commit;

    expect(await fake.branchHead()).toBe(commit);
    expect(await fake.show(commit, "%P")).toBe(before);
    expect(await fake.filesAt(commit)).toEqual({ "Notes/n.md": text, "Notes/other.md": "keep", "README.md": "r" });
    await fake.fsck();
  });

  it("is authored by the person who saved it, committed by the host, with the default message", async () => {
    await h.seed({ "Notes/Q4 plan.md": "x" });
    await draftOf("Notes/Q4 plan.md", "y");
    const { commit } = (await version("Notes/Q4 plan.md")) as { commit: string };
    expect(await fake.show(commit, "%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
    expect(await fake.show(commit, "%B")).toBe("Edit Q4 plan");
  });

  it("removes the draft, so the note is the repository's again", async () => {
    await h.seed({ "n.md": "x" });
    await draftOf("n.md", "y");
    await version("n.md");
    expect(await drafts.get(1, "n.md")).toBeUndefined();
    expect(await drafts.count(1)).toBe(0);
  });

  describe("the message", () => {
    it("is what the person wrote, exactly, trimmed", async () => {
      await h.seed({ "n.md": "x" });
      await draftOf("n.md", "y");
      const { commit } = (await version("n.md", { message: "  Reword the intro\n\nBecause it was unclear.  " })) as { commit: string };
      expect(await fake.show(commit, "%B")).toBe("Reword the intro\n\nBecause it was unclear.");
    });

    it("falls back to the default for a message that is only white space, and keeps line feeds only", async () => {
      expect(composeMessage("a/b.md", "  \n\t ", [])).toBe("Edit b");
      expect(composeMessage("a/b.md", undefined, [])).toBe("Edit b");
      expect(composeMessage("a/b.md", "one\r\ntwo\rthree", [])).toBe("one\ntwo\nthree");
      expect(defaultMessage("Notes/Meeting 2026.MD")).toBe("Edit Meeting 2026");
      expect(defaultMessage("Notes/Q4 plan.fj.md")).toBe("Edit Q4 plan");
      expect(defaultMessage("Notes/Q4 plan.FJ.MD")).toBe("Edit Q4 plan");
      expect(defaultMessage("plain.txt")).toBe("Edit plain.txt");
    });
  });

  describe("someone who edited through a link", () => {
    const guestDeps = () => ({ ...deps(), identityOf: async (editor: Editor) => (editor.type === "account" ? PEOPLE[editor.id] : guestIdentity(editor)) });
    const guestEditor = (name: string, link = 3): Editor => ({ type: "guest", link, name });

    it("is credited by the name they gave, in a trailer git recognises, with an address that is nobody's, and the owner stays the author", async () => {
      await h.seed({ "n.md": "x" });
      const baseBlob = await blobOf("n.md");
      await drafts.save(1, "n.md", { baseBlob, content: "y" }, guestEditor("Grace Hopper"));
      await drafts.save(1, "n.md", { baseBlob, content: "y, and more" }, ed("ada"));
      const { commit } = (await saveVersion(guestDeps(), { connectionId: 1, path: "n.md", message: "Reword", author: ADA, authorId: "ada" })) as { commit: string };
      expect(await fake.show(commit, "%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
      expect(await fake.show(commit, "%(trailers:key=Co-authored-by,valueonly)")).toMatch(/^Grace Hopper <link-3-[0-9a-f]{8}@users\.noreply\.fjord\.invalid>\n?$/);
      expect((await fake.filesAt(commit))["n.md"]).toBe("y, and more");
    });

    it("is one credit for a name on a link, two for two names, and two for one name on two links", async () => {
      await h.seed({ "n.md": "x" });
      const baseBlob = await blobOf("n.md");
      for (const editor of [guestEditor("Grace"), guestEditor("Grace"), guestEditor("Ada Lovelace"), guestEditor("Grace", 4)]) await drafts.save(1, "n.md", { baseBlob, content: "y" }, editor);
      const { commit } = (await saveVersion(guestDeps(), { connectionId: 1, path: "n.md", author: ADA, authorId: "ada" })) as { commit: string };
      const trailers = (await fake.show(commit, "%(trailers:key=Co-authored-by,valueonly,separator=%x7C)")).split("|");
      expect(trailers).toHaveLength(3);
      expect(new Set(trailers.map((line) => line.replace(/^.*</, "<"))).size).toBe(3);
    });

    it("cannot make a name into a second trailer or a header: it is kept to one line", async () => {
      await h.seed({ "n.md": "x" });
      const baseBlob = await blobOf("n.md");
      await drafts.save(1, "n.md", { baseBlob, content: "y" }, guestEditor("Grace\nCo-authored-by: Mallory <m@evil.example>"));
      const { commit } = (await saveVersion(guestDeps(), { connectionId: 1, path: "n.md", author: ADA, authorId: "ada" })) as { commit: string };
      const body = await fake.show(commit, "%B");
      expect(body.split("\n").filter((line) => line.startsWith("Co-authored-by:"))).toHaveLength(1);
      expect(body).not.toContain("<m@evil.example>");
    });

    it("has an address made from the link and the name, under a domain that is nobody's", () => {
      const a = guestIdentity({ link: 3, name: "Grace" });
      expect(a.email).toMatch(/^link-3-[0-9a-f]{8}@users\.noreply\.fjord\.invalid$/);
      expect(guestIdentity({ link: 3, name: "Grace" })).toEqual(a);
      expect(guestIdentity({ link: 3, name: "Ada" }).email).not.toBe(a.email);
      expect(guestIdentity({ link: 4, name: "Grace" }).email).not.toBe(a.email);
      expect(a.name).toBe("Grace");
    });
  });

  describe("co-authors", () => {
    it("credits everyone else who edited since the last version, in a trailer git itself recognises", async () => {
      await h.seed({ "n.md": "x" });
      await draftOf("n.md", "y", "grace", "ada", "soren");
      const { commit } = (await version("n.md", { message: "Reword" })) as { commit: string };
      expect(await fake.show(commit, "%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
      expect(await fake.show(commit, "%(trailers:key=Co-authored-by,valueonly,separator=%x2C )")).toBe("Grace Hopper <grace@example.com>, Søren <soren@example.com>");
      expect(await fake.show(commit, "%B")).toBe("Reword\n\nCo-authored-by: Grace Hopper <grace@example.com>\nCo-authored-by: Søren <soren@example.com>");
    });

    it("does not credit the author again, or an account that is gone, or the same address twice", async () => {
      await h.seed({ "n.md": "x" });
      await draftOf("n.md", "y", "ada", "ghost", "grace", "twin");
      const people = { ...PEOPLE, twin: { name: "Grace again", email: "grace@example.com" } };
      const result = await saveVersion({ ...deps(), identityOf: async (editor) => (editor.type === "account" ? people[editor.id as keyof typeof people] : undefined) }, { connectionId: 1, path: "n.md", author: ADA, authorId: "ada" });
      const { commit } = result as { commit: string };
      expect(await fake.show(commit, "%(trailers:key=Co-authored-by,valueonly,separator=%x2C )")).toBe("Grace Hopper <grace@example.com>");
    });

    it("does not credit the author under another address either: by account, whatever the address", async () => {
      await h.seed({ "n.md": "x" });
      await draftOf("n.md", "y", "ada", "grace");
      const result = await saveVersion({ ...deps(), identityOf: async (editor) => (editor.type !== "account" ? undefined : editor.id === "ada" ? { name: "Ada (old address)", email: "ada@old.example" } : PEOPLE[editor.id]) }, { connectionId: 1, path: "n.md", author: ADA, authorId: "ada" });
      const { commit } = result as { commit: string };
      expect(await fake.show(commit, "%(trailers:key=Co-authored-by,valueonly,separator=%x2C )")).toBe("Grace Hopper <grace@example.com>");
    });

    it("does not credit another account that has the author's address: by address, whatever the account", async () => {
      await h.seed({ "n.md": "x" });
      await draftOf("n.md", "y", "ada", "grace");
      const result = await saveVersion({ ...deps(), identityOf: async (editor) => (editor.type !== "account" ? undefined : editor.id === "grace" ? { name: "Ada's other account", email: "ada@example.com" } : PEOPLE[editor.id]) }, { connectionId: 1, path: "n.md", author: ADA, authorId: "ada" });
      const { commit } = result as { commit: string };
      expect(await fake.show(commit, "%B")).toBe("Edit n");
    });

    it("writes a name that cannot break the commit or the trailer", () => {
      expect(formatIdentity({ name: "Eve <evil@x>\nCo-authored-by: Mallory", email: " eve@example.com\n" })).toEqual({ name: "Eve evil@x Co-authored-by: Mallory", email: "eve@example.com" });
      expect(formatIdentity({ name: " <> ", email: "pat@example.com" })).toEqual({ name: "pat", email: "pat@example.com" });
      expect(composeMessage("n.md", "m", [{ name: "A", email: "a@x" }, { name: "B", email: "b@x" }])).toBe("m\n\nCo-authored-by: A <a@x>\nCo-authored-by: B <b@x>");
    });
  });

  describe("only on top of the draft's base", () => {
    it("writes nothing when the file changed in the repository, and keeps the draft", async () => {
      await h.seed({ "n.md": "base" });
      await draftOf("n.md", "mine");
      const theirs = await fake.commitFiles({ "n.md": "theirs" });
      expect(await version("n.md")).toEqual({ ok: false, reason: "upstream_changed" });
      expect(await fake.branchHead()).toBe(theirs);
      expect(await drafts.get(1, "n.md")).toMatchObject({ content: "mine" });
    });

    it("writes nothing when the file was deleted, and keeps the draft", async () => {
      await h.seed({ "n.md": "base", "keep.md": "k" });
      await draftOf("n.md", "mine");
      const theirs = await fake.commitFiles({ "n.md": null });
      expect(await version("n.md")).toEqual({ ok: false, reason: "gone" });
      expect(await fake.branchHead()).toBe(theirs);
      expect(await drafts.get(1, "n.md")).toBeDefined();
    });

    it("does not replace a folder, or a link, that is now at the path", async () => {
      await h.seed({ "n.md/inner.md": "x" });
      await drafts.save(1, "n.md", { baseBlob: "a".repeat(40), content: "mine" }, ed("ada"));
      expect(await version("n.md")).toEqual({ ok: false, reason: "gone" });
    });

    it("goes on top of a head that moved without touching the file", async () => {
      const before = await h.seed({ "n.md": "base", "other.md": "o" });
      await draftOf("n.md", "mine");
      const elsewhere = await fake.commitFiles({ "other.md": "changed elsewhere" });

      const result = await version("n.md");
      expect(result.ok).toBe(true);
      const commit = (result as { commit: string }).commit;
      expect(await fake.show(commit, "%P")).toBe(elsewhere);
      expect(elsewhere).not.toBe(before);
      expect(await fake.filesAt(commit)).toEqual({ "n.md": "mine", "other.md": "changed elsewhere" });
      await fake.fsck();
    });

    it("reads again when the head moves as the commit is made, once, and goes on top of what landed", async () => {
      await h.seed({ "n.md": "base", "other.md": "o" });
      await draftOf("n.md", "mine");
      let landed = "";
      fake.before(/\/git\/refs\/heads\/main$/, async () => void (landed = await fake.commitFiles({ "other.md": "raced" })), "PATCH");

      const result = await version("n.md");
      expect(result.ok).toBe(true);
      const commit = (result as { commit: string }).commit;
      expect(await fake.show(commit, "%P")).toBe(landed);
      expect(await fake.filesAt(commit)).toEqual({ "n.md": "mine", "other.md": "raced" });
      expect(await fake.show(landed, "%an")).toBe("Someone"); // theirs is still there
    });

    it("loses neither side when the file itself changes as the commit is made", async () => {
      await h.seed({ "n.md": "base" });
      await draftOf("n.md", "mine");
      const theirs = { commit: "" };
      fake.before(/\/git\/refs\/heads\/main$/, async () => void (theirs.commit = await fake.commitFiles({ "n.md": "theirs" })), "PATCH");

      expect(await version("n.md")).toEqual({ ok: false, reason: "upstream_changed" });
      expect(await fake.branchHead()).toBe(theirs.commit);
      expect(await fake.filesAt(theirs.commit)).toEqual({ "n.md": "theirs" });
      expect(await drafts.get(1, "n.md")).toMatchObject({ content: "mine" });
    });

    it("gives up, without forcing, when the head keeps moving", async () => {
      await h.seed({ "n.md": "base", "other.md": "o" });
      await draftOf("n.md", "mine");
      let n = 0;
      for (let i = 0; i < 2; i++) fake.before(/\/git\/refs\/heads\/main$/, async () => void (await fake.commitFiles({ "other.md": `race ${++n}` })), "PATCH");

      expect(await version("n.md")).toEqual({ ok: false, reason: "head_moved" });
      expect(await fake.filesAt((await fake.branchHead())!)).toEqual({ "n.md": "base", "other.md": "race 2" });
      expect(await drafts.get(1, "n.md")).toBeDefined();
      expect(fake.requests.filter((r) => r.method === "PATCH").every((r) => (r.body as { force?: boolean }).force === false)).toBe(true);
    });
  });

  describe("what goes wrong", () => {
    it("has nothing to save without a draft, and writes nothing", async () => {
      const head = await h.seed({ "n.md": "x" });
      expect(await version("n.md")).toEqual({ ok: false, reason: "no_draft" });
      expect(await fake.branchHead()).toBe(head);
    });

    it("drops a draft that is the file as it is, rather than make an empty commit", async () => {
      const head = await h.seed({ "n.md": "same" });
      await draftOf("n.md", "same");
      expect(await version("n.md")).toEqual({ ok: false, reason: "nothing_to_save" });
      expect(await fake.branchHead()).toBe(head);
      expect(await drafts.get(1, "n.md")).toBeUndefined();
    });

    it("says so, and keeps the draft, when the token cannot write", async () => {
      const head = await h.seed({ "n.md": "x" });
      await draftOf("n.md", "y");
      expect(await version("n.md", { provider: h.readOnly!() })).toEqual({ ok: false, reason: "read_only" });
      expect(await fake.branchHead()).toBe(head);
      expect(await drafts.get(1, "n.md")).toBeDefined();
    });

    it("says so, and keeps the draft, when the token was revoked", async () => {
      await h.seed({ "n.md": "x" });
      await draftOf("n.md", "y");
      expect(await version("n.md", { provider: h.revoked!() })).toEqual({ ok: false, reason: "bad_token" });
      expect(await drafts.get(1, "n.md")).toBeDefined();
    });

    it("says so, and keeps the draft, when the host is not answering", async () => {
      await h.seed({ "n.md": "x" });
      await draftOf("n.md", "y");
      fake.fail(/.*/, { status: 503, body: { message: "down" }, times: 20 });
      expect(await version("n.md")).toEqual({ ok: false, reason: "unavailable" });
      expect(await drafts.get(1, "n.md")).toBeDefined();
    });

    it("keeps what was typed while the version was being made, and the version does not have it", async () => {
      await h.seed({ "n.md": "base" });
      const base = await draftOf("n.md", "first");
      fake.before(/\/git\/refs\/heads\/main$/, async () => {
        clock += 10;
        await drafts.save(1, "n.md", { baseBlob: base, content: "first, then more" }, ed("ada"));
      }, "PATCH");

      const { commit } = (await version("n.md")) as { commit: string };
      expect(await fake.filesAt(commit)).toEqual({ "n.md": "first" });
      expect(await drafts.get(1, "n.md")).toMatchObject({ content: "first, then more", baseBlob: base });
    });

    it("is not an error that the draft could not be removed: the version exists", async () => {
      await h.seed({ "n.md": "x" });
      await draftOf("n.md", "y");
      const broken = { get: drafts.get.bind(drafts), discardUnchanged: async () => Promise.reject(new Error("db down")) };
      const result = await saveVersion({ ...deps(), drafts: broken }, { connectionId: 1, path: "n.md", author: ADA, authorId: "ada" });
      expect(result.ok).toBe(true);
    });
  });
});

describe(`a version from an encrypted draft (${leg})`, () => {
  const available = wasmAvailable();

  it.runIf(available)("commits the ciphertext's bytes as they are, with no key, and the repository holds no plaintext", async () => {
    await h.seed({ "Secret/n.age": "old ciphertext", "README.md": "r" });
    const { content, bytes } = encryptedDraft("SECRET PLAINTEXT of the note");
    await drafts.save(1, "Secret/n.age", { baseBlob: await blobOf("Secret/n.age"), content, encrypted: true }, ed("ada"));

    const result = await version("Secret/n.age");
    expect(result).toEqual({ ok: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const stored = await h.provider.readBlob(h.repo, await blobOf("Secret/n.age"));
    expect([...stored]).toEqual([...bytes]);
    expect(Buffer.from(stored).toString("latin1")).not.toContain("SECRET PLAINTEXT");
    expect(await drafts.get(1, "Secret/n.age")).toBeUndefined();
    await fake.fsck();
  });

  it("refuses a draft that is not ciphertext, whatever row it came from, and writes nothing", async () => {
    await h.seed({ "Secret/n.age": "old ciphertext" });
    const before = await fake.branchHead();
    await drafts.save(1, "Secret/n.age", { baseBlob: await blobOf("Secret/n.age"), content: "x" }, ed("ada"));
    // A row that says it is encrypted and holds plain text: not made by the service, which would not have kept it.
    await dbRun(database, sql`UPDATE ${table()} SET encrypted = 1, content = ${Buffer.from("# PLAIN").toString("base64")}`);

    expect(await version("Secret/n.age")).toEqual({ ok: false, reason: "not_ciphertext" });
    expect(await fake.branchHead()).toBe(before);
    expect(await drafts.get(1, "Secret/n.age")).toBeDefined();
  });
});
