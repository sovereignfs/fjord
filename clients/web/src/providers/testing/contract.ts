import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProviderError } from "../errors";
import { gitBlobId } from "../git-id";
import type { Provider, RepositoryRef, TreeEntry } from "../types";

/**
 * What every `Provider` must do, as tests. A provider is put through them by describing it as a
 * `ProviderHarness`: a way to make a repository hold files, to have someone else push, and, where
 * the provider has them, to break its credential or its tree listing. The same cases then run
 * against GitHub (through a fake whose storage is a real git repository) and against the
 * in-memory provider, so the interface means one thing, and the rest of the app can be tested
 * against the one that is quick.
 */
export interface ProviderHarness {
  provider: Provider;
  repo: RepositoryRef;
  /** Make the default branch hold exactly these files, as one commit on top of what is there. Returns it. */
  seed(files: Record<string, string | Uint8Array>): Promise<string>;
  /** Someone else commits to the branch, outside the provider; `null` deletes. Returns the commit. */
  pushElsewhere(files: Record<string, string | null>): Promise<string>;
  limitTree?(entries: number | undefined): void;
  /** The next request is refused for rate limits. */
  rateLimitNext?(resetAt: Date): void;
  /** The same repository through a credential that may read but not write. */
  readOnly?(): Provider;
  /** The same repository through a credential the host rejects. */
  revoked?(): Provider;
  close(): Promise<void>;
}

export interface ContractCapabilities {
  /** The host can be made to cut a tree listing short. */
  truncation: boolean;
  /** It has credentials, so they can be read-only, revoked, or rate limited. */
  credentials: boolean;
}

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const BINARY = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 10, 13]);

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected the error ${code}`).toBeDefined();
  expect(isProviderError(error, code as never), `expected ${code}, got ${String(error)}`).toBe(true);
  return error as import("../errors").ProviderError;
}

export function providerContract(label: string, make: () => Promise<ProviderHarness>, capabilities: ContractCapabilities): void {
  describe(`the provider contract: ${label}`, () => {
    let h: ProviderHarness;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => h.close());

    const head = async () => {
      const result = await h.provider.getHead(h.repo, "main");
      if (!result.changed) throw new Error("expected a head");
      return result.head;
    };
    const paths = async (commit?: string) => {
      const tree = await h.provider.getTree(h.repo, commit ?? (await head()).commit);
      return tree.entries.map((e) => e.path).sort();
    };
    const commitFiles = async (changes: import("../types").Change[], message = "A change") => h.provider.commit(h.repo, { branch: "main", expectedHead: (await head()).commit, message, changes });

    describe("repositories", () => {
      it("lists what the credential reaches, with each one's default branch", async () => {
        const repos = await h.provider.listRepositories();
        expect(repos.map((r) => r.ref)).toContainEqual(h.repo);
        expect(repos.find((r) => r.ref.name === h.repo.name)).toMatchObject({ defaultBranch: "main", private: true });
      });

      it("describes one, and says plainly when it is not there", async () => {
        expect((await h.provider.getRepository(h.repo)).defaultBranch).toBe("main");
        await expectCode(h.provider.getRepository({ owner: "nobody", name: "nothing" }), "not_found");
      });
    });

    describe("heads", () => {
      it("reads a branch's head, and says when there is no such branch", async () => {
        const seeded = await h.seed({ "README.md": "hello" });
        expect((await head()).commit).toBe(seeded);
        await expectCode(h.provider.getHead(h.repo, "no-such-branch"), "not_found");
      });

      it("answers 'unchanged' to a head's etag until the branch moves, then gives the new head", async () => {
        await h.seed({ "README.md": "hello" });
        const first = await head();
        expect(first.etag).toBeTruthy();
        expect(await h.provider.getHead(h.repo, "main", { etag: first.etag })).toEqual({ changed: false });

        const moved = await h.pushElsewhere({ "README.md": "hello again" });
        const again = await h.provider.getHead(h.repo, "main", { etag: first.etag });
        expect(again).toMatchObject({ changed: true, head: { commit: moved } });
      });
    });

    describe("trees", () => {
      const FILES = { "README.md": "hello", "Notes/a.md": "# A", "Notes/Deep/b.md": "# B", "data.bin": BINARY };

      it("lists every file and every directory, with sizes, and says the listing is complete", async () => {
        const commit = await h.seed(FILES);
        const tree = await h.provider.getTree(h.repo, commit);
        expect(tree.complete).toBe(true);
        expect(tree.commit).toBe(commit);
        expect(tree.entries.map((e) => e.path).sort()).toEqual(["Notes", "Notes/Deep", "Notes/Deep/b.md", "Notes/a.md", "README.md", "data.bin"]);

        const byPath = new Map(tree.entries.map((e) => [e.path, e]));
        expect(byPath.get("Notes")?.kind).toBe("directory");
        expect(byPath.get("Notes/Deep")?.kind).toBe("directory");
        expect(byPath.get("README.md")).toMatchObject({ kind: "file", size: 5, executable: false });
        expect(byPath.get("data.bin")?.size).toBe(BINARY.byteLength);
        for (const entry of tree.entries) expect(entry.id).toMatch(/^[0-9a-f]{40}$/);
      });

      it("is for ever what that commit held: a later commit does not change an earlier tree", async () => {
        const first = await h.seed({ "a.md": "one" });
        const second = await h.pushElsewhere({ "b.md": "two", "a.md": null });
        expect(await paths(first)).toEqual(["a.md"]);
        expect(await paths(second)).toEqual(["b.md"]);
      });

      it("says a commit that does not exist is not found", async () => {
        await h.seed({ "a.md": "one" });
        await expectCode(h.provider.getTree(h.repo, "0".repeat(40)), "not_found");
      });

      it("lists one directory's children, with full paths, and not its grandchildren", async () => {
        const commit = await h.seed(FILES);
        const root = await h.provider.listDirectory(h.repo, commit, "");
        expect(root.map((e) => e.path).sort()).toEqual(["Notes", "README.md", "data.bin"]);
        const notes = await h.provider.listDirectory(h.repo, commit, "Notes");
        expect(notes.map((e) => e.path).sort()).toEqual(["Notes/Deep", "Notes/a.md"]);
        const deep = await h.provider.listDirectory(h.repo, commit, "Notes/Deep");
        expect(deep.map((e) => e.path)).toEqual(["Notes/Deep/b.md"]);
        await expectCode(h.provider.listDirectory(h.repo, commit, "Nope"), "not_found");
        await expectCode(h.provider.listDirectory(h.repo, commit, "README.md"), "not_found");
      });

      it.runIf(capabilities.truncation)("says when the host cut the listing short, and a directory-by-directory walk finds the rest", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) files[`dir${i}/sub${j}/file.md`] = `${i}${j}`;
        const commit = await h.seed(files);
        const everything = (await paths(commit)).length;

        h.limitTree!(10);
        const cut = await h.provider.getTree(h.repo, commit);
        expect(cut.complete).toBe(false);
        expect(cut.entries.length).toBeLessThan(everything);

        // The fallback the file browser uses (DESIGN.md §8): read each directory itself.
        const found: TreeEntry[] = [];
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await h.provider.listDirectory(h.repo, commit, dir)) {
            found.push(entry);
            if (entry.kind === "directory") await walk(entry.path);
          }
        };
        await walk("");
        expect(found.map((e) => e.path).sort()).toEqual(await (async () => { h.limitTree!(undefined); return paths(commit); })());
      });
    });

    describe("blobs", () => {
      it("returns exactly the bytes in the repository: text, unicode, empty, and binary with every awkward byte", async () => {
        const commit = await h.seed({ "t.md": "plain", "u.md": "ünïcödé 日本語 🚀\r\nline", "empty.md": "", "b.bin": BINARY });
        const tree = await h.provider.getTree(h.repo, commit);
        const read = async (path: string) => h.provider.readBlob(h.repo, tree.entries.find((e) => e.path === path)!.id);
        expect(decode(await read("t.md"))).toBe("plain");
        expect(decode(await read("u.md"))).toBe("ünïcödé 日本語 🚀\r\nline");
        expect((await read("empty.md")).byteLength).toBe(0);
        expect([...(await read("b.bin"))]).toEqual([...BINARY]);
      });

      it("returns bytes whose git id is the id the tree reported", async () => {
        const commit = await h.seed({ "a.md": "some content\n" });
        const [entry] = (await h.provider.getTree(h.repo, commit)).entries;
        expect(gitBlobId(await h.provider.readBlob(h.repo, entry!.id))).toBe(entry!.id);
      });

      it("says a blob that is not there is not found, and a file past the limit is too large", async () => {
        const commit = await h.seed({ "big.md": "x".repeat(1000) });
        const [entry] = (await h.provider.getTree(h.repo, commit)).entries;
        await expectCode(h.provider.readBlob(h.repo, "1".repeat(40)), "not_found");
        await expectCode(h.provider.readBlob(h.repo, entry!.id, { maxBytes: 999 }), "too_large");
        expect((await h.provider.readBlob(h.repo, entry!.id, { maxBytes: 1000 })).byteLength).toBe(1000);
      });
    });

    describe("commits", () => {
      beforeEach(async () => {
        await h.seed({ "keep.md": "kept", "change.md": "before", "gone.md": "to delete", "Folder/old.md": "to move" });
      });

      it("makes several changes as one commit: create, replace, delete, and a file in a new directory", async () => {
        const before = await head();
        const result = await commitFiles([
          { path: "new.md", content: encode("created") },
          { path: "change.md", content: encode("after") },
          { path: "gone.md", delete: true },
          { path: "A/B/C/deep.md", content: encode("deep") },
        ]);

        expect(result).toMatchObject({ parent: before.commit, branch: "main" });
        expect((await head()).commit).toBe(result.commit);
        expect(await paths()).toEqual(["A", "A/B", "A/B/C", "A/B/C/deep.md", "Folder", "Folder/old.md", "change.md", "keep.md", "new.md"]);

        const tree = await h.provider.getTree(h.repo, result.commit);
        const read = async (path: string) => decode(await h.provider.readBlob(h.repo, tree.entries.find((e) => e.path === path)!.id));
        expect(await read("change.md")).toBe("after");
        expect(await read("keep.md")).toBe("kept");
        expect(await read("A/B/C/deep.md")).toBe("deep");
      });

      it("moves a file by putting its blob at a new path and deleting the old one, uploading nothing", async () => {
        const tree = await h.provider.getTree(h.repo, (await head()).commit);
        const old = tree.entries.find((e) => e.path === "Folder/old.md")!;
        const result = await commitFiles([{ path: "Folder/new-name.md", blob: old.id }, { path: "Folder/old.md", delete: true }]);
        const moved = (await h.provider.getTree(h.repo, result.commit)).entries.find((e) => e.path === "Folder/new-name.md")!;
        expect(moved.id).toBe(old.id);
        expect(await paths()).not.toContain("Folder/old.md");
      });

      it("keeps a file's executable bit", async () => {
        const result = await commitFiles([{ path: "run.sh", content: encode("#!/bin/sh\n"), executable: true }]);
        const entry = (await h.provider.getTree(h.repo, result.commit)).entries.find((e) => e.path === "run.sh")!;
        expect(entry.executable).toBe(true);
      });

      it("handles a commit of many files across many directories, all of them or none", async () => {
        const changes = Array.from({ length: 40 }, (_, i) => ({ path: `bulk/d${i % 5}/file${i}.md`, content: encode(`file ${i}`) }));
        const result = await commitFiles(changes);
        const names = (await paths(result.commit)).filter((p) => p.endsWith(".md") && p.startsWith("bulk/"));
        expect(names).toHaveLength(40);
      });

      it("never overwrites: if the branch has moved since the caller read it, it says so and writes nothing", async () => {
        const stale = (await head()).commit;
        const theirs = await h.pushElsewhere({ "their.md": "theirs" });

        const error = await expectCode(
          h.provider.commit(h.repo, { branch: "main", expectedHead: stale, message: "Mine", changes: [{ path: "mine.md", content: encode("mine") }] }),
          "head_moved",
        );
        expect(error.message).not.toMatch(/token|secret/i);
        expect((await head()).commit).toBe(theirs);
        expect(await paths()).toContain("their.md");
        expect(await paths()).not.toContain("mine.md");
      });

      it("treats a commit that only built on an older ancestor the same way: no force, ever", async () => {
        const first = (await head()).commit;
        await h.pushElsewhere({ "one.md": "1" });
        const third = await h.pushElsewhere({ "two.md": "2" });
        await expectCode(
          h.provider.commit(h.repo, { branch: "main", expectedHead: first, message: "Old", changes: [{ path: "stale.md", content: encode("x") }] }),
          "head_moved",
        );
        expect((await head()).commit).toBe(third);
      });

      it("lets exactly one of two commits that start from the same head win", async () => {
        const expectedHead = (await head()).commit;
        const attempt = (path: string) => h.provider.commit(h.repo, { branch: "main", expectedHead, message: path, changes: [{ path, content: encode(path) }] });
        const results = await Promise.allSettled([attempt("first.md"), attempt("second.md")]);

        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(isProviderError(loser.reason, "head_moved")).toBe(true);
        const names = await paths();
        expect(names.filter((p) => p === "first.md" || p === "second.md")).toHaveLength(1);
      });

      it("refuses a commit that would change nothing, so an idle save makes no empty commit", async () => {
        const before = (await head()).commit;
        await expectCode(commitFiles([{ path: "keep.md", content: encode("kept") }]), "no_changes");
        expect((await head()).commit).toBe(before);
      });

      it("refuses a request that makes no sense, before it reaches the host", async () => {
        const before = (await head()).commit;
        const request = (changes: import("../types").Change[], message = "m") => h.provider.commit(h.repo, { branch: "main", expectedHead: before, message, changes });
        await expectCode(request([]), "invalid_request");
        await expectCode(request([{ path: "a.md", content: encode("a") }], "   "), "invalid_request");
        await expectCode(request([{ path: ".git/config", content: encode("x") }]), "invalid_request");
        await expectCode(request([{ path: "a/.GIT/hooks", content: encode("x") }]), "invalid_request");
        await expectCode(request([{ path: "../escape.md", content: encode("x") }]), "invalid_request");
        await expectCode(request([{ path: "/absolute.md", content: encode("x") }]), "invalid_request");
        await expectCode(request([{ path: "a.md", content: encode("1") }, { path: "a.md", content: encode("2") }]), "invalid_request");
        expect((await head()).commit).toBe(before);
      });

      it("writes nothing when one change in it cannot be applied", async () => {
        const before = (await head()).commit;
        await expectCode(commitFiles([{ path: "ok.md", content: encode("fine") }, { path: "bad.md", blob: "2".repeat(40) }]), "invalid_request");
        expect((await head()).commit).toBe(before);
        expect(await paths()).not.toContain("ok.md");
      });

      it("says a branch that does not exist is not found", async () => {
        await expectCode(
          h.provider.commit(h.repo, { branch: "no-such-branch", expectedHead: (await head()).commit, message: "m", changes: [{ path: "a.md", content: encode("a") }] }),
          "not_found",
        );
      });
    });

    describe("whether it can write", () => {
      beforeEach(async () => {
        await h.seed({ "a.md": "a" });
      });

      it("says yes for a credential that can, and changes nothing to find out", async () => {
        const before = await head();
        expect(await h.provider.canWrite(h.repo, "main")).toBe(true);
        expect(await head()).toEqual(before);
        expect(await paths()).toEqual(["a.md"]);
      });

      it("says a branch that is not there is not found", async () => {
        await expectCode(h.provider.canWrite(h.repo, "no-such-branch"), "not_found");
      });
    });

    describe.runIf(capabilities.credentials)("credentials and limits", () => {
      beforeEach(async () => {
        await h.seed({ "a.md": "a" });
      });

      it("says no for a credential that can read and not write, and yes to a rejected one never: it throws", async () => {
        const before = await head();
        expect(await h.readOnly!().canWrite(h.repo, "main")).toBe(false);
        expect(await head()).toEqual(before);
        await expectCode(h.revoked!().canWrite(h.repo, "main"), "unauthorized");
      });

      it("lets a read-only credential read and refuses it a commit, as forbidden", async () => {
        const readOnly = h.readOnly!();
        expect((await readOnly.getHead(h.repo, "main")).changed).toBe(true);
        await expectCode(
          readOnly.commit(h.repo, { branch: "main", expectedHead: (await head()).commit, message: "m", changes: [{ path: "b.md", content: encode("b") }] }),
          "forbidden",
        );
        expect(await paths()).toEqual(["a.md"]);
      });

      it("says a rejected credential is unauthorized, for a read and for a write", async () => {
        const revoked = h.revoked!();
        await expectCode(revoked.getHead(h.repo, "main"), "unauthorized");
        await expectCode(revoked.listRepositories(), "unauthorized");
        await expectCode(revoked.commit(h.repo, { branch: "main", expectedHead: "a".repeat(40), message: "m", changes: [{ path: "b.md", content: encode("b") }] }), "unauthorized");
      });

      it("says when the host is limiting it, and when it may try again", async () => {
        const resetAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000);
        h.rateLimitNext!(resetAt);
        const error = await expectCode(h.provider.getHead(h.repo, "main"), "rate_limited");
        expect(error.details.resetAt?.getTime()).toBe(resetAt.getTime());
      });
    });
  });
}
