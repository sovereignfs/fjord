import { describe, expect, it } from "vitest";
import { MemoryProvider } from "../providers/memory";
import { HeadCache } from "./head-cache";
import { headCommit } from "./repository";

const REF = { owner: "acme", name: "notes" };
const head = (n: number) => ({ etag: `"e${n}"`, commit: String(n).repeat(40) });

describe("the heads a process has seen", () => {
  it("keeps one per connection, repository and branch", () => {
    const heads = new HeadCache();
    heads.put(1, REF, "main", head(1));
    heads.put(1, REF, "dev", head(2));
    heads.put(2, REF, "main", head(3));
    expect(heads.get(1, REF, "main")).toEqual(head(1));
    expect(heads.get(1, REF, "dev")).toEqual(head(2));
    expect(heads.get(2, REF, "main")).toEqual(head(3));
    expect(heads.get(1, { owner: "acme", name: "other" }, "main")).toBeUndefined();
  });

  it("is replaced by a newer head", () => {
    const heads = new HeadCache();
    heads.put(1, REF, "main", head(1));
    heads.put(1, REF, "main", head(2));
    expect(heads.get(1, REF, "main")).toEqual(head(2));
  });

  it("holds no more than its bound, dropping the one used longest ago", () => {
    const heads = new HeadCache(2);
    heads.put(1, REF, "a", head(1));
    heads.put(1, REF, "b", head(2));
    heads.get(1, REF, "a");
    heads.put(1, REF, "c", head(3));
    expect(heads.get(1, REF, "b")).toBeUndefined();
    expect(heads.get(1, REF, "a")).toEqual(head(1));
    expect(heads.get(1, REF, "c")).toEqual(head(3));
  });
});

describe("the commit a branch is at, asked of the host", () => {
  const CONNECTION = { id: 7, ref: REF, branch: "main" };
  function host() {
    const memory = new MemoryProvider();
    memory.createRepository(REF);
    memory.seed(REF, { "a.md": "a" });
    return memory;
  }

  it("is asked for whole the first time, then with the ETag it was given, and a not-moved answer is the commit seen", async () => {
    const memory = host();
    const heads = new HeadCache();
    const asked: (string | undefined)[] = [];
    const real = memory.getHead.bind(memory);
    memory.getHead = async (ref, branch, options) => {
      asked.push(options?.etag);
      return real(ref, branch, options);
    };
    const first = await headCommit(memory, heads, CONNECTION);
    const again = await headCommit(memory, heads, CONNECTION);
    expect(again).toBe(first);
    expect(asked).toEqual([undefined, heads.get(7, REF, "main")?.etag]);
    expect(asked[1]).toBeDefined();
  });

  it("sees a push at the next look, with no webhook to say so", async () => {
    const memory = host();
    const heads = new HeadCache();
    const first = await headCommit(memory, heads, CONNECTION);
    memory.seed(REF, { "added.txt": "x" });
    const next = await headCommit(memory, heads, CONNECTION);
    expect(next).not.toBe(first);
    expect(heads.get(7, REF, "main")?.commit).toBe(next);
  });

  it("asks whole every time when there is no cache, as before", async () => {
    const memory = host();
    const asked: (string | undefined)[] = [];
    const real = memory.getHead.bind(memory);
    memory.getHead = async (ref, branch, options) => {
      asked.push(options?.etag);
      return real(ref, branch, options);
    };
    await headCommit(memory, undefined, CONNECTION);
    await headCommit(memory, undefined, CONNECTION);
    expect(asked).toEqual([undefined, undefined]);
  });

  it("does not take a not-moved answer for a branch it never saw", async () => {
    const memory = host();
    memory.getHead = async () => ({ changed: false });
    await expect(headCommit(memory, new HeadCache(), CONNECTION)).rejects.toThrow(/no etag/);
  });
});
