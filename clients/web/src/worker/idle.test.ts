import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import type { FakeGitHub } from "../providers/testing/fake-github";
import { githubHarness } from "../providers/testing/harnesses";
import type { Identity } from "../providers/types";
import { type Editor, WorkingCopyService } from "../working/service";
import { guestIdentity } from "../working/version";
import { type IdleDeps, createIdleVersions } from "./idle";

/**
 * Idle versions (ROADMAP 1b.13), against a GitHub whose storage is a real git repository, so that what git says about the commit
 * is what is asserted; drafts are on the real databases. The clock is ours: a draft is edited at one time and looked at later.
 */
const { leg } = testTarget();
let database: Database;
let drafts: WorkingCopyService;
let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;

const MINUTE = 60 * 1000;
const IDLE = 5 * MINUTE;
const T0 = 1_800_000_000_000;
let clock = T0;

const PEOPLE: Record<string, Identity> = {
  ada: { name: "Ada Lovelace", email: "ada@example.com" },
  grace: { name: "Grace Hopper", email: "grace@example.com" },
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
  clock = T0;
  h = await githubHarness();
  fake = h.fake;
  await dbRun(database, sql`DELETE FROM ${table()}`);
});
afterEach(async () => h.close());

const blobOf = async (path: string) => {
  const head = await h.provider.getHead(h.repo, "main");
  if (!head.changed) throw new Error("no head");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (await h.provider.listDirectory(h.repo, head.head.commit, dir)).find((entry) => entry.path === path)!.id;
};
/** A draft of `path` as the file is now, typed at the clock's time by these people in turn. */
async function draftOf(path: string, content: string, ...by: Editor[]) {
  const baseBlob = await blobOf(path);
  for (const who of by.length ? by : [ed("ada")]) await drafts.save(1, path, { baseBlob, content }, who);
}
/** The branch's head commit; there is always one, the seed's at least. */
async function head(): Promise<string> {
  const commit = await fake.branchHead();
  if (!commit) throw new Error("the branch has no head");
  return commit;
}
function worker(over: Partial<IdleDeps> = {}) {
  return createIdleVersions({
    drafts,
    target: async () => ({ provider: h.provider, ref: h.repo, branch: "main", ownerId: "ada" }),
    identityOf: async (editor) => (editor.type === "account" ? PEOPLE[editor.id] : guestIdentity(editor)),
    now: () => clock,
    idleMs: IDLE,
    ...over,
  });
}

describe(`idle versions (${leg})`, () => {
  it("makes one version of a draft nobody has edited for the quiet period, and removes the draft", async () => {
    const before = await h.seed({ "n.md": "old\n", "other.md": "keep" });
    await draftOf("n.md", "new\n");
    clock = T0 + IDLE;

    const report = await worker().pass();
    expect(report.made).toBe(1);
    const commit = await head();
    expect(await fake.show(commit, "%P")).toBe(before);
    expect(await fake.filesAt(commit)).toEqual({ "n.md": "new\n", "other.md": "keep" });
    expect(await fake.show(commit, "%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
    expect(await fake.show(commit, "%B")).toBe("Edit n");
    expect(await drafts.get(1, "n.md")).toBeUndefined();
    await fake.fsck();
  });

  it("makes a draft one version only, however many passes look at it", async () => {
    await h.seed({ "n.md": "old" });
    await draftOf("n.md", "new");
    clock = T0 + IDLE;
    const idle = worker();
    await idle.pass();
    const first = await head();
    clock += 10 * MINUTE;
    expect((await idle.pass()).results).toEqual([]);
    expect(await head()).toBe(first);
  });

  it("does not touch a draft edited within the quiet period", async () => {
    const before = await h.seed({ "n.md": "old" });
    await draftOf("n.md", "new");
    clock = T0 + IDLE - 1;
    expect((await worker().pass()).results).toEqual([]);
    expect(await head()).toBe(before);
    expect(await drafts.get(1, "n.md")).toBeDefined();
  });

  it("starts the quiet period again at each edit", async () => {
    await h.seed({ "n.md": "old" });
    await draftOf("n.md", "one");
    clock = T0 + IDLE - MINUTE;
    await draftOf("n.md", "two");
    clock = T0 + IDLE + 1;
    expect((await worker().pass()).made).toBe(0);
    clock = T0 + 2 * IDLE;
    expect((await worker().pass()).made).toBe(1);
    expect(await fake.filesAt(await head())).toEqual({ "n.md": "two" });
  });

  describe("who is credited", () => {
    it("is the owner of the connection as the author when they edited, and the others as co-authors", async () => {
      await h.seed({ "n.md": "old" });
      await draftOf("n.md", "new", ed("grace"), ed("ada"));
      clock = T0 + IDLE + 10;
      await worker().pass();
      const commit = await head();
      expect(await fake.show(commit, "%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
      expect(await fake.show(commit, "%B")).toBe("Edit n\n\nCo-authored-by: Grace Hopper <grace@example.com>");
    });

    it("is the first editor who can be found when the owner did not edit", async () => {
      await h.seed({ "n.md": "old" });
      await draftOf("n.md", "new", ed("gone"), ed("grace"));
      clock = T0 + IDLE + 10;
      await worker({ target: async () => ({ provider: h.provider, ref: h.repo, branch: "main", ownerId: "someone-else" }) }).pass();
      const commit = await head();
      expect(await fake.show(commit, "%an <%ae>")).toBe("Grace Hopper <grace@example.com>");
      expect(await fake.show(commit, "%B")).toBe("Edit n");
    });

    it("is a person without an account, by the name they gave, when that is all there is", async () => {
      await h.seed({ "n.md": "old" });
      const guest: Editor = { type: "guest", link: 7, name: "Visiting Vera" };
      await draftOf("n.md", "new", guest);
      clock = T0 + IDLE;
      await worker().pass();
      const commit = await head();
      expect(await fake.show(commit, "%an <%ae>")).toBe(`Visiting Vera <${guestIdentity({ link: 7, name: "Visiting Vera" }).email}>`);
      expect(await fake.show(commit, "%B")).toBe("Edit n");
    });

    it("leaves a draft alone when none of its editors can be found", async () => {
      const before = await h.seed({ "n.md": "old" });
      await draftOf("n.md", "new", ed("gone"));
      clock = T0 + IDLE;
      const report = await worker().pass();
      expect(report.results[0]?.outcome).toEqual({ ok: false, reason: "skipped_no_author" });
      expect(await head()).toBe(before);
      expect(await drafts.get(1, "n.md")).toBeDefined();
    });
  });

  describe("what is left for a person", () => {
    it("is a draft with a combine's conflict markers in it", async () => {
      const before = await h.seed({ "n.md": "old" });
      await draftOf("n.md", "<<<<<<< Your changes\na\n=======\nb\n>>>>>>> In the repository\n");
      clock = T0 + IDLE;
      const report = await worker().pass();
      expect(report.results[0]?.outcome).toEqual({ ok: false, reason: "skipped_conflict" });
      expect(await head()).toBe(before);
      expect(await drafts.get(1, "n.md")).toBeDefined();
    });

    it("is a draft whose file changed in the repository since: nothing is written, the draft is kept", async () => {
      await h.seed({ "n.md": "old" });
      await draftOf("n.md", "mine");
      const theirs = await h.seed({ "n.md": "theirs" });
      clock = T0 + IDLE;
      const report = await worker().pass();
      expect(report.made).toBe(0);
      expect(report.results[0]?.outcome).toEqual({ ok: false, reason: "upstream_changed" });
      expect(await head()).toBe(theirs);
      expect((await drafts.get(1, "n.md"))?.content).toBe("mine");
    });

    it("is a draft of a connection that is gone", async () => {
      await h.seed({ "n.md": "old" });
      await draftOf("n.md", "new");
      clock = T0 + IDLE;
      const report = await worker({ target: async () => undefined }).pass();
      expect(report.results[0]?.outcome).toEqual({ ok: false, reason: "skipped_no_connection" });
      expect(await drafts.get(1, "n.md")).toBeDefined();
    });
  });

  describe("a draft that could not be made a version", () => {
    it("is not tried again before the delay, and is then", async () => {
      await h.seed({ "n.md": "old" });
      await draftOf("n.md", "mine");
      await h.seed({ "n.md": "theirs" });
      clock = T0 + IDLE;
      const asked = vi.fn(async () => ({ provider: h.provider, ref: h.repo, branch: "main", ownerId: "ada" }));
      const idle = worker({ target: asked, retryMs: 15 * MINUTE });

      expect((await idle.pass()).results).toHaveLength(1);
      clock += 14 * MINUTE;
      expect((await idle.pass()).results).toHaveLength(0);
      expect(asked).toHaveBeenCalledTimes(1);
      clock += 2 * MINUTE;
      expect((await idle.pass()).results).toHaveLength(1);
      expect(asked).toHaveBeenCalledTimes(2);
    });

    it("is tried again at once, once idle, when it is edited", async () => {
      const base = await h.seed({ "n.md": "old" });
      await draftOf("n.md", "mine");
      clock = T0 + IDLE;
      const asked = vi.fn(async () => undefined);
      const idle = worker({ target: asked });
      await idle.pass();
      expect(asked).toHaveBeenCalledTimes(1);

      clock += MINUTE;
      await drafts.save(1, "n.md", { baseBlob: await blobOf("n.md"), content: "mine, more" }, ed("ada"));
      clock += IDLE;
      await idle.pass();
      expect(asked).toHaveBeenCalledTimes(2);
      expect(await head()).toBe(base);
    });

    it("is logged by the name of what went wrong, never its message, and the other drafts go on", async () => {
      await h.seed({ "a.md": "a", "b.md": "b" });
      await draftOf("a.md", "A");
      await draftOf("b.md", "B");
      clock = T0 + IDLE;
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      let calls = 0;
      const report = await worker({
        target: async () => {
          if (calls++ === 0) throw new RangeError("token ghp_secret");
          return { provider: h.provider, ref: h.repo, branch: "main", ownerId: "ada" };
        },
      }).pass();
      expect(report.results.map((r) => ("reason" in r.outcome ? r.outcome.reason : "ok"))).toEqual(["failed", "ok"]);
      expect(log).toHaveBeenCalledWith("[fjord] idle versions: unexpected RangeError");
      expect(JSON.stringify(log.mock.calls)).not.toContain("ghp_secret");
      log.mockRestore();
    });
  });

  it("makes at most so many versions in one pass, the longest idle first, and the rest in the next", async () => {
    await h.seed({ "a.md": "a", "b.md": "b", "c.md": "c" });
    await draftOf("b.md", "B");
    clock += 1;
    await draftOf("a.md", "A");
    clock += 1;
    await draftOf("c.md", "C");
    clock = T0 + IDLE + 10;
    const idle = worker({ perPass: 2 });
    expect((await idle.pass()).results.map((r) => r.path)).toEqual(["b.md", "a.md"]);
    expect((await idle.pass()).results.map((r) => r.path)).toEqual(["c.md"]);
    expect(await fake.filesAt(await head())).toEqual({ "a.md": "A", "b.md": "B", "c.md": "C" });
  });
});
