import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isProviderError } from "../errors";
import { gitBlobId } from "../git-id";
import { FakeGitHub } from "../testing/fake-github";
import { GitHubProvider } from "./provider";

/**
 * The provider against GitHub's real answers, recorded from a public repository
 * (`scripts/record-github-fixtures.mjs`) and replayed byte for byte. This is what ties the fake
 * the contract tests use to the real service: if GitHub's shapes differ from what the provider
 * reads, or from what the fake emits, it shows here.
 */
interface Recorded {
  method: string;
  path: string;
  accept: string;
  status: number;
  headers: Record<string, string>;
  body?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- GitHub's JSON, as recorded
  bodyBase64?: string;
}
const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/sovereignfs-fjord.json"), "utf8")) as { commit: string; record: Recorded[] };
const REAL = { owner: "sovereignfs", name: "fjord" };
const COMMIT = fixture.commit;
const find = (suffix: string) => fixture.record.find((r) => r.path.endsWith(suffix))!;

let server: Server;
let provider: GitHubProvider;
beforeAll(async () => {
  server = createServer((req, res) => {
    const recorded = fixture.record.find((r) => r.method === req.method && r.path === req.url);
    if (!recorded) {
      res.writeHead(404, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ message: "Not Found: not recorded", url: req.url }));
    }
    // A conditional request for an etag it has is a 304, as GitHub does.
    if (recorded.headers.etag && req.headers["if-none-match"] === recorded.headers.etag) {
      res.writeHead(304, { etag: recorded.headers.etag });
      return void res.end();
    }
    res.writeHead(recorded.status, { ...recorded.headers, "content-type": recorded.headers["content-type"] ?? "application/json" });
    res.end(recorded.bodyBase64 !== undefined ? Buffer.from(recorded.bodyBase64, "base64") : JSON.stringify(recorded.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  provider = new GitHubProvider({ apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: async () => "not-used", scope: "user", sleep: async () => undefined });
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("against GitHub's real answers", () => {
  it("describes the repository", async () => {
    expect(await provider.getRepository(REAL)).toMatchObject({ ref: REAL, defaultBranch: "main", private: false });
  });

  it("reads the head, and recognises its etag as 'unchanged'", async () => {
    const result = await provider.getHead(REAL, "main");
    expect(result).toMatchObject({ changed: true, head: { branch: "main", commit: COMMIT } });
    if (!result.changed) return;
    expect(result.head.etag).toMatch(/^W\//);
    expect(await provider.getHead(REAL, "main", { etag: result.head.etag })).toEqual({ changed: false });
  });

  describe("the whole tree", () => {
    it("is read from the one recursive listing, complete, with every entry typed and sized", async () => {
      const tree = await provider.getTree(REAL, COMMIT);
      const raw = find("?recursive=1").body.tree as { path: string; type: string }[];
      expect(tree.complete).toBe(true);
      expect(tree.entries).toHaveLength(raw.length);
      expect(new Set(tree.entries.map((e) => e.path)).size).toBe(raw.length);
      expect(tree.entries.map((e) => e.path)).toContain("spec/SPEC.md");
      expect(tree.entries.find((e) => e.path === "crates")).toMatchObject({ kind: "directory" });
      for (const entry of tree.entries) {
        expect(entry.id).toMatch(/^[0-9a-f]{40}$/);
        if (entry.kind === "file") expect(typeof entry.size).toBe("number");
      }
      expect(tree.entries.filter((e) => e.kind === "file").length).toBeGreaterThan(100);
    });

    it("agrees with the directory listings GitHub gave separately: the root, and one subdirectory", async () => {
      const tree = await provider.getTree(REAL, COMMIT);
      const topLevel = tree.entries.filter((e) => !e.path.includes("/")).map((e) => `${e.path}:${e.id}`).sort();
      const root = await provider.listDirectory(REAL, COMMIT, "");
      expect(root.map((e) => `${e.path}:${e.id}`).sort()).toEqual(topLevel);

      // `crates` is listed by its own tree id, which the walk finds from the root: the recorded answer for it is what is served.
      const crates = await provider.listDirectory(REAL, COMMIT, "crates");
      const children = tree.entries.filter((e) => e.path.startsWith("crates/") && !e.path.slice("crates/".length).includes("/"));
      expect(crates.map((e) => e.path).sort()).toEqual(children.map((e) => e.path).sort());
      expect(crates.map((e) => e.id).sort()).toEqual(children.map((e) => e.id).sort());
    });
  });

  it("returns a file whose bytes are the ones the id names: a real blob, checked by git's own hash", async () => {
    const tree = await provider.getTree(REAL, COMMIT);
    const readme = tree.entries.find((e) => e.path === "README.md")!;
    const bytes = await provider.readBlob(REAL, readme.id);
    expect(gitBlobId(bytes)).toBe(readme.id);
    expect(bytes.byteLength).toBe(readme.size);
    expect(new TextDecoder().decode(bytes)).toContain("Fjord");
  });

  it("maps GitHub's real 404s: no such branch, no such repository", async () => {
    await expect(provider.getHead(REAL, "there-is-no-such-branch")).rejects.toSatisfy((e) => isProviderError(e, "not_found"));
    await expect(provider.getRepository({ owner: "sovereignfs", name: "there-is-no-such-repository" })).rejects.toSatisfy((e) => isProviderError(e, "not_found"));
  });
});

describe("the fake the contract tests use, against the real thing", () => {
  it("has the fields the provider reads on a tree entry, with the types GitHub gives them", async () => {
    const real = find("?recursive=1").body.tree as Record<string, unknown>[];
    const realFile = real.find((e) => e.type === "blob")!;
    const realDir = real.find((e) => e.type === "tree")!;

    const fake = new FakeGitHub();
    await fake.start();
    try {
      const commit = await fake.commitFiles({ "Folder/file.md": "content" });
      const response = await fetch(`${fake.url}/repos/acme/notes/git/trees/${commit}?recursive=1`, { headers: { authorization: "Bearer test-token" } });
      const body = (await response.json()) as { tree: Record<string, unknown>[]; truncated: boolean };
      const fakeFile = body.tree.find((e) => e.type === "blob")!;
      const fakeDir = body.tree.find((e) => e.type === "tree")!;

      // Every field the provider reads, present and of the same type, on both kinds of entry.
      for (const key of ["path", "mode", "type", "sha"]) {
        expect(typeof fakeFile[key], `file ${key}`).toBe(typeof realFile[key]);
        expect(typeof fakeDir[key], `directory ${key}`).toBe(typeof realDir[key]);
      }
      expect(typeof fakeFile.size).toBe(typeof realFile.size);
      expect("size" in realDir).toBe(false);
      expect("size" in fakeDir).toBe(false);
      expect(typeof body.truncated).toBe(typeof find("?recursive=1").body.truncated);
      expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(["sha", "tree", "truncated"]));
      expect(fakeDir.mode).toBe(realDir.mode);
      expect(fakeFile.mode).toBe(realFile.mode);
    } finally {
      await fake.stop();
    }
  });

  it("answers the ref and the errors in the shape GitHub does", async () => {
    const realRef = find("/git/ref/heads/main").body;
    const real404 = find("there-is-no-such-branch").body;
    const fake = new FakeGitHub();
    await fake.start();
    try {
      await fake.commitFiles({ "a.md": "a" });
      const auth = { headers: { authorization: "Bearer test-token" } };
      const ref = (await (await fetch(`${fake.url}/repos/acme/notes/git/ref/heads/main`, auth)).json()) as typeof realRef;
      expect(ref.object.type).toBe(realRef.object.type);
      expect(typeof ref.object.sha).toBe("string");
      expect(ref.ref).toBe(realRef.ref);

      const missing = await fetch(`${fake.url}/repos/acme/notes/git/ref/heads/nope`, auth);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { message: string }).message).toBe(real404.message);
    } finally {
      await fake.stop();
    }
  });
});
