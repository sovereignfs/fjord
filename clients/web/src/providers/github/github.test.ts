import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProviderError } from "../errors";
import { type FakeGitHub } from "../testing/fake-github";
import { githubHarness } from "../testing/harnesses";
import { GitHubProvider } from "./provider";

/**
 * What is particular to GitHub, beyond the contract every provider meets: the requests it makes,
 * what a commit looks like to git itself, and how it behaves when GitHub does not.
 */
let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;
beforeEach(async () => {
  h = await githubHarness();
  fake = h.fake;
});
afterEach(async () => h.close());

const encode = (text: string) => new TextEncoder().encode(text);
const writes = () => fake.requests.filter((r) => r.method !== "GET");
const head = async () => {
  const result = await h.provider.getHead(h.repo, "main");
  if (!result.changed) throw new Error("no head");
  return result.head;
};

describe("reading", () => {
  it("lists a whole tree in one request, using the commit id where a tree id is expected", async () => {
    const commit = await h.seed({ "a.md": "a", "Folder/b.md": "b" });
    fake.requests.length = 0;
    await h.provider.getTree(h.repo, commit);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.path).toBe(`/repos/acme/notes/git/trees/${commit}?recursive=1`);
  });

  it("asks for a blob's raw bytes, not base64 inside JSON", async () => {
    const commit = await h.seed({ "a.md": "a" });
    const [entry] = (await h.provider.getTree(h.repo, commit)).entries;
    fake.requests.length = 0;
    await h.provider.readBlob(h.repo, entry!.id);
    expect(fake.requests[0]!.headers.accept).toBe("application/vnd.github.raw+json");
  });

  it("polls a head with its etag, and a 'not modified' costs one request and no body", async () => {
    await h.seed({ "a.md": "a" });
    const first = await head();
    fake.requests.length = 0;
    expect(await h.provider.getHead(h.repo, "main", { etag: first.etag })).toEqual({ changed: false });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.headers["if-none-match"]).toBe(first.etag);
  });

  it("walks to a nested directory with one request per level, and lists the root with one", async () => {
    const commit = await h.seed({ "A/B/C/d.md": "d" });
    fake.requests.length = 0;
    await h.provider.listDirectory(h.repo, commit, "");
    expect(fake.requests).toHaveLength(1);
    fake.requests.length = 0;
    await h.provider.listDirectory(h.repo, commit, "A/B/C");
    expect(fake.requests).toHaveLength(4);
  });

  it("lists the repositories an installation can reach from the installation endpoint, and a user's from the user endpoint", async () => {
    const installation = new GitHubProvider({ apiUrl: fake.url, token: async () => "test-token", scope: "installation" });
    expect((await installation.listRepositories()).map((r) => r.ref)).toEqual([h.repo]);
    expect(fake.requests.at(-1)!.path).toMatch(/^\/installation\/repositories/);
    await h.provider.listRepositories();
    expect(fake.requests.at(-1)!.path).toMatch(/^\/user\/repos/);
  });

  it("reports whether the credential can write, when GitHub says", async () => {
    expect((await h.provider.getRepository(h.repo)).canPush).toBe(true);
    expect((await h.readOnly!().getRepository(h.repo)).canPush).toBe(false);
  });
});

describe("a commit, as git sees it", () => {
  beforeEach(async () => {
    await h.seed({ "a.md": "a" });
  });

  it("is a real git commit on top of the head it was built on, in a repository that passes git's own consistency check", async () => {
    const before = await head();
    const result = await h.provider.commit(h.repo, { branch: "main", expectedHead: before.commit, message: "Edit a", changes: [{ path: "a.md", content: encode("changed") }] });

    expect(await fake.show(result.commit, "%P")).toBe(before.commit);
    expect(await fake.branchHead()).toBe(result.commit);
    expect(await fake.filesAt(result.commit)).toEqual({ "a.md": "changed" });
    await fake.fsck();
  });

  it("records the author and the message exactly, a multi-line one with trailers and unicode included", async () => {
    const message = "Edit Q4 plan\n\nMoved the editor to the top.\n\nCo-authored-by: Grace Hopper <grace@example.com>\nCo-authored-by: Søren <soren@example.com>";
    const result = await h.provider.commit(h.repo, {
      branch: "main",
      expectedHead: (await head()).commit,
      message,
      author: { name: "Ada Lovelace", email: "ada@example.com" },
      changes: [{ path: "a.md", content: encode("x") }],
    });
    expect(await fake.show(result.commit, "%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
    expect(await fake.show(result.commit, "%B")).toBe(message);
    // The host's own identity commits it; the person is the author.
    expect(await fake.show(result.commit, "%cn")).toBe("Fake GitHub");
  });

  it("uploads each new file once, and a move uploads nothing", async () => {
    const tree = await h.provider.getTree(h.repo, (await head()).commit);
    fake.requests.length = 0;
    await h.provider.commit(h.repo, {
      branch: "main",
      expectedHead: (await head()).commit,
      message: "m",
      changes: [
        { path: "one.md", content: encode("1") },
        { path: "two.md", content: encode("2") },
        { path: "three.md", content: encode("3") },
        { path: "moved.md", blob: tree.entries[0]!.id },
        { path: "a.md", delete: true },
      ],
    });
    expect(writes().filter((r) => r.path.endsWith("/git/blobs"))).toHaveLength(3);
    // blobs, one tree, one commit, one ref update
    expect(writes().map((r) => r.method + " " + r.path.replace("/repos/acme/notes", "").split("?")[0]).filter((x) => !x.endsWith("/git/blobs"))).toEqual(["POST /git/trees", "POST /git/commits", "PATCH /git/refs/heads/main"]);
  });

  it("sends binary files as base64 and the branch update without force", async () => {
    await h.provider.commit(h.repo, { branch: "main", expectedHead: (await head()).commit, message: "m", changes: [{ path: "b.bin", content: new Uint8Array([0, 255, 128]) }] });
    const blob = writes().find((r) => r.path.endsWith("/git/blobs"))!;
    expect(blob.body).toEqual({ content: Buffer.from([0, 255, 128]).toString("base64"), encoding: "base64" });
    expect(writes().find((r) => r.method === "PATCH")!.body).toMatchObject({ force: false });
  });

  it("looks before it uploads: a head that has moved costs one request and writes nothing", async () => {
    const stale = (await head()).commit;
    await h.pushElsewhere({ "theirs.md": "t" });
    fake.requests.length = 0;
    await expect(
      h.provider.commit(h.repo, { branch: "main", expectedHead: stale, message: "m", changes: [{ path: "mine.md", content: encode("m") }] }),
    ).rejects.toSatisfy((e) => isProviderError(e, "head_moved"));
    expect(fake.requests).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it("works on a branch whose name has slashes", async () => {
    await fake.commitFiles({ "a.md": "feature" }, { branch: "feature/one", replace: true });
    const feature = await h.provider.getHead(h.repo, "feature/one");
    if (!feature.changed) throw new Error("no head");
    const result = await h.provider.commit(h.repo, { branch: "feature/one", expectedHead: feature.head.commit, message: "m", changes: [{ path: "b.md", content: encode("b") }] });
    expect(await fake.branchHead("feature/one")).toBe(result.commit);
    expect(await fake.branchHead("main")).not.toBe(result.commit);
  });
});

describe("when GitHub misbehaves", () => {
  beforeEach(async () => {
    await h.seed({ "a.md": "a" });
  });

  it("gets through a gateway error on a read, by trying again", async () => {
    fake.fail(/git\/ref\/heads/, { status: 502, body: { message: "Bad Gateway" }, times: 1 });
    expect((await h.provider.getHead(h.repo, "main")).changed).toBe(true);
    expect(fake.requests.filter((r) => r.path.includes("/git/ref/"))).toHaveLength(2);
  });

  it("does not try a write again: a failed tree creation is reported once and the branch is untouched", async () => {
    const before = await head();
    fake.fail(/git\/trees/, { status: 502, method: "POST", body: { message: "Bad Gateway" }, times: 5 });
    await expect(
      h.provider.commit(h.repo, { branch: "main", expectedHead: before.commit, message: "m", changes: [{ path: "x.md", content: encode("x") }] }),
    ).rejects.toSatisfy((e) => isProviderError(e, "unavailable"));
    expect(fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/git/trees"))).toHaveLength(1);
    expect((await head()).commit).toBe(before.commit);
  });

  it("is told it is unavailable when it cannot connect at all, without the credential in the message", async () => {
    await h.close();
    const error = await h.provider.getHead(h.repo, "main").catch((e: unknown) => e);
    expect(isProviderError(error, "unavailable")).toBe(true);
    expect((error as Error).message).not.toContain("test-token");
    // `afterEach` closes it again: make that harmless.
    h = await githubHarness();
    fake = h.fake;
  });

  it("reports a lost race at the last step: someone pushes after the early look, and GitHub itself refuses the update", async () => {
    const before = await head();
    // The early look will see the head unmoved; the push lands as the commit object is being made.
    let theirs = "";
    fake.before(/git\/commits$/, async () => void (theirs = await h.pushElsewhere({ "late.md": "late" })), "POST");

    await expect(
      h.provider.commit(h.repo, { branch: "main", expectedHead: before.commit, message: "m", changes: [{ path: "x.md", content: encode("x") }] }),
    ).rejects.toSatisfy((e) => isProviderError(e, "head_moved"));

    // The ref update was attempted (the early look did not catch it), and refused: theirs is still the head.
    expect(writes().some((r) => r.method === "PATCH")).toBe(true);
    expect(await fake.branchHead()).toBe(theirs);
    expect(await fake.filesAt(theirs)).toEqual({ "a.md": "a", "late.md": "late" });
  });
});
