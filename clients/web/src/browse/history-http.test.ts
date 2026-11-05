import { describe, expect, it, vi } from "vitest";
import { type HistoryDeps, handleHistory, handleHistoryFile } from "./history-http";
import { MemoryProvider } from "../providers/memory";
import { HISTORY_LIMIT, versionBytes, versionsOf } from "./history";

const ORIGIN = "https://fjord.example";
const ALICE = { accountId: "alice" };
const COMMIT = "a".repeat(40);
const list = (query: string, method = "GET") => new Request(`${ORIGIN}/api/connections/1/history${query}`, { method });
const file = (query: string, method = "GET") => new Request(`${ORIGIN}/api/connections/1/history/file${query}`, { method });

function stub(over: Partial<HistoryDeps> = {}) {
  const versions = vi.fn<HistoryDeps["versions"]>(async () => ({ found: true, versions: [{ commit: COMMIT, message: "Edit", author: "Ada", date: "2026-11-04T10:00:00Z" }], more: false, supported: true }));
  const read = vi.fn<HistoryDeps["file"]>(async () => ({ found: true, result: { ok: true, bytes: new TextEncoder().encode("# Old\n") } }));
  return { deps: { versions, file: read, ...over } as HistoryDeps, versions, read };
}

describe("a file's history, over HTTP", () => {
  it("is for someone signed in, and only by GET", async () => {
    const { deps, versions, read } = stub();
    expect((await handleHistory(list("?path=Public/a.md"), null, deps, "1")).status).toBe(401);
    expect((await handleHistoryFile(file(`?path=Public/a.md&commit=${COMMIT}`), null, deps, "1")).status).toBe(401);
    expect((await handleHistory(list("?path=Public/a.md", "POST"), ALICE, deps, "1")).status).toBe(405);
    expect(versions).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("is a 404 that says nothing for someone else's connection", async () => {
    const { deps } = stub({ versions: async () => ({ found: false }), file: async () => ({ found: false }) });
    expect((await handleHistory(list("?path=Public/a.md"), ALICE, deps, "1")).status).toBe(404);
    expect((await handleHistoryFile(file(`?path=Public/a.md&commit=${COMMIT}`), ALICE, deps, "1")).status).toBe(404);
    expect((await handleHistory(list("?path=Public/a.md"), ALICE, deps, "not-a-number")).status).toBe(404);
  });

  it("wants a path that is one, and a whole commit id", async () => {
    const { deps, read } = stub();
    for (const query of ["", "?path=", "?path=../etc/passwd"]) expect((await handleHistory(list(query), ALICE, deps, "1")).status, query).toBe(400);
    for (const commit of ["", "abc", "main", "A".repeat(40), `${"a".repeat(39)}/`]) expect((await handleHistoryFile(file(`?path=Public/a.md&commit=${encodeURIComponent(commit)}`), ALICE, deps, "1")).status, commit).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("lists the versions the caller's own connection has", async () => {
    const { deps, versions } = stub();
    const response = await handleHistory(list("?path=Public/a.md"), ALICE, deps, "1");
    expect(await response.json()).toMatchObject({ versions: [{ commit: COMMIT, author: "Ada" }], more: false, supported: true });
    expect(versions).toHaveBeenCalledWith("alice", 1, "Public/a.md");
  });

  it("gives a version as bytes that no browser would take for a page", async () => {
    const { deps } = stub();
    const response = await handleHistoryFile(file(`?path=Public/a.md&commit=${COMMIT}`), ALICE, deps, "1");
    expect(await response.text()).toBe("# Old\n");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("says when a version is not there, or too large", async () => {
    const missing = stub({ file: async () => ({ found: true, result: { ok: false, reason: "missing" } }) });
    expect((await handleHistoryFile(file(`?path=Public/a.md&commit=${COMMIT}`), ALICE, missing.deps, "1")).status).toBe(404);
    const large = stub({ file: async () => ({ found: true, result: { ok: false, reason: "too_large" } }) });
    expect((await handleHistoryFile(file(`?path=Public/a.md&commit=${COMMIT}`), ALICE, large.deps, "1")).status).toBe(413);
  });
});

describe("reading a file's history from a host", () => {
  const ref = { owner: "acme", name: "notes" };
  const encoder = new TextEncoder();

  async function repository() {
    const host = new MemoryProvider();
    host.createRepository(ref);
    host.seed(ref, { "Public/a.md": "one", "Public/b.md": "b" });
    const head = (await host.getHead(ref, "main")) as { changed: true; head: { commit: string } };
    return { host, first: head.head.commit };
  }

  it("reads a version as it was at that commit, and nothing for a commit without the file", async () => {
    const { host, first } = await repository();
    const second = (await host.commit(ref, { branch: "main", expectedHead: first, message: "Two", changes: [{ path: "Public/a.md", content: encoder.encode("two") }, { path: "Public/c.md", content: encoder.encode("c") }] })).commit;
    expect(await versionBytes(host, ref, first, "Public/a.md")).toEqual({ ok: true, bytes: encoder.encode("one") });
    expect(await versionBytes(host, ref, second, "Public/a.md")).toEqual({ ok: true, bytes: encoder.encode("two") });
    expect(await versionBytes(host, ref, first, "Public/c.md")).toEqual({ ok: false, reason: "missing" });
    expect(await versionBytes(host, ref, "f".repeat(40), "Public/a.md")).toEqual({ ok: false, reason: "missing" });
  });

  it("says when there are more than it lists", async () => {
    const { host, first } = await repository();
    let head = first;
    for (let n = 0; n <= HISTORY_LIMIT; n++) head = (await host.commit(ref, { branch: "main", expectedHead: head, message: `Edit ${n}`, changes: [{ path: "Public/a.md", content: encoder.encode(`text ${n}`) }] })).commit;
    const asked = (await versionsOf(host, ref, head, "Public/a.md"))!;
    expect(asked.versions).toHaveLength(HISTORY_LIMIT);
    expect(asked.more).toBe(true);
    expect(asked.versions[0]?.message).toBe(`Edit ${HISTORY_LIMIT}`);
  });

  it("is nothing to say for a host that keeps none", async () => {
    const { host, first } = await repository();
    Object.defineProperty(host, "fileHistory", { value: undefined });
    expect(await versionsOf(host, ref, first, "Public/a.md")).toBeUndefined();
  });
});
