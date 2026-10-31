import { describe, expect, it, vi } from "vitest";
import { type Grant, ROLES, type Role } from "../access/policy";
import type { Limiter, Rule } from "../limits/rate";
import { type AccessDeps, CLIENT_ID, type Operation, type Viewer, commentsAccess, commentsWatch } from "./access";

/**
 * Who may do what to a document's comments (ROADMAP 1d.1): the policy's decision for each operation, by role and by way in, the author a
 * comment is written as, and what a refusal says. The service is a stand-in; what it keeps is `service.test.ts`'s.
 */
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const NOW = 1_800_000_000_000;
const ANCHOR = { type: "text-quote" as const, quote: "world", prefix: "Hello ", suffix: "", position: 6 };
const BROWSER = "browser-0001";

function setup(viewer: Viewer | undefined) {
  const comments = {
    list: vi.fn(async (..._args: unknown[]) => ({ threads: [], closed: false, version: 0 })),
    createThread: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, id: 11 })),
    reply: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, id: 12 })),
    setResolved: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
    edit: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
    remove: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
    setClosed: vi.fn(async (..._args: unknown[]) => undefined),
    reanchor: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
  };
  const deps: AccessDeps = { viewer: async () => viewer, comments, now: () => NOW };
  return { run: commentsAccess(deps), comments };
}
const ALICE = { id: "alice", name: "Alice" };
const owner: Viewer = { connectionId: 1, grants: [{ kind: "owner" }], account: ALICE };
const named = (role: Role): Viewer => ({ connectionId: 1, grants: [{ kind: "user", role }], account: { id: "bob", name: "Bob" } });
const link = (role: Role, over: Partial<Extract<Grant, { kind: "link" }>> = {}): Viewer => ({ connectionId: 1, grants: [{ kind: "link", role, ...over }], linkId: 3 });
const as = { name: "Grace Hopper", clientId: BROWSER };

const OPERATIONS: Record<string, Operation> = {
  list: { op: "list" },
  thread: { op: "thread", anchor: ANCHOR, body: "a thought" },
  reply: { op: "reply", thread: 5, body: "a reply" },
  resolve: { op: "resolve", thread: 5, resolved: true },
  edit: { op: "edit", target: { kind: "thread", id: 5 }, body: "better" },
  delete: { op: "delete", target: { kind: "thread", id: 5 } },
  reanchor: { op: "reanchor", thread: 5, from: ANCHOR, to: { ...ANCHOR, quote: "an edited quote" } },
  close: { op: "close", closed: true },
};
const call = (viewer: Viewer | undefined, operation: Operation, claimed: object = as, account = viewer?.account) => {
  const { run, comments } = setup(viewer);
  return run({ docId: DOC, account, cookie: undefined, claimed, operation }).then((outcome) => ({ outcome, comments }));
};

/** Written out from §12 and §13, by role: which operations each way in allows. */
const ALLOWED: Record<string, string[]> = {
  view: ["list"],
  comment: ["list", "thread", "reply", "resolve", "edit", "delete", "reanchor"],
  edit: ["list", "thread", "reply", "resolve", "edit", "delete", "reanchor"],
  owner: ["list", "thread", "reply", "resolve", "edit", "delete", "reanchor", "close"],
};

describe.each([
  ["a named account", (role: Role) => named(role)],
  ["a link", (role: Role) => link(role)],
] as const)("%s", (_name, viewerOf) => {
  for (const role of ROLES) {
    it(`with the ${role} role may ${ALLOWED[role]!.join(", ")} and is told it may not do the rest`, async () => {
      for (const [name, operation] of Object.entries(OPERATIONS)) {
        const { outcome } = await call(viewerOf(role), operation, as, _name === "a link" ? undefined : viewerOf(role).account);
        if (ALLOWED[role]!.includes(name)) expect(outcome.ok, `${role} ${name}`).toBe(true);
        else expect(outcome, `${role} ${name}`).toEqual({ ok: false, reason: "forbidden" });
      }
    });
  }
});

describe("the owner", () => {
  it("may do everything, and delete anyone's comment, which no share may", async () => {
    for (const [name, operation] of Object.entries(OPERATIONS)) expect((await call(owner, operation)).outcome.ok, name).toBe(true);
    const { comments } = await call(owner, OPERATIONS.delete!);
    expect(comments.remove).toHaveBeenCalledWith(1, DOC, { kind: "thread", id: 5 }, { kind: "account", id: "alice", name: "Alice" }, true);
    for (const viewer of [named("edit"), link("edit")]) {
      const { comments: other } = await call(viewer, OPERATIONS.delete!);
      expect(other.remove.mock.calls[0]![4], "a share does not moderate").toBe(false);
    }
  });

  it("alone closes and opens a document's comments", async () => {
    const { comments } = await call(owner, { op: "close", closed: false });
    expect(comments.setClosed).toHaveBeenCalledWith(1, DOC, false, { kind: "account", id: "alice", name: "Alice" });
    for (const viewer of [named("edit"), link("edit")]) expect((await call(viewer, OPERATIONS.close!)).outcome).toEqual({ ok: false, reason: "forbidden" });
  });
});

describe("being let in at all", () => {
  it("is nothing for someone who is let in nowhere: not found, and nothing is touched", async () => {
    for (const operation of Object.values(OPERATIONS)) {
      const { outcome, comments } = await call(undefined, operation);
      expect(outcome).toEqual({ ok: false, reason: "hidden" });
      for (const mock of Object.values(comments)) expect(mock).not.toHaveBeenCalled();
    }
  });

  it("is nothing for a link that has expired or been revoked, even with the right role", async () => {
    for (const dead of [link("edit", { expiresAt: NOW }), link("edit", { expiresAt: NOW - 1 }), link("edit", { revoked: true })]) {
      expect((await call(dead, OPERATIONS.list!)).outcome).toEqual({ ok: false, reason: "hidden" });
      expect((await call(dead, OPERATIONS.thread!)).outcome).toEqual({ ok: false, reason: "hidden" });
    }
  });
});

describe("who a comment is written as", () => {
  it("is the signed-in account, itself, even where it came in by a link, whatever name it sends", async () => {
    const viaLink: Viewer = { ...link("comment"), account: ALICE };
    const { comments } = await call(viaLink, OPERATIONS.thread!, { name: "Someone Else", clientId: BROWSER });
    expect(comments.createThread).toHaveBeenCalledWith(1, DOC, ANCHOR, "a thought", { kind: "account", id: "alice", name: "Alice" });
  });

  it("is, for someone with a link only, a guest by the link and the browser's id, with the name they gave tidied up", async () => {
    const { comments } = await call(link("comment"), OPERATIONS.reply!, { name: "  Grace   Hopper ", clientId: BROWSER }, undefined);
    expect(comments.reply).toHaveBeenCalledWith(1, DOC, 5, "a reply", { kind: "guest", id: `3:${BROWSER}`, name: "Grace Hopper" });
  });

  it("makes a guest's id from the link as well as the browser, so two links' guests are never the same", async () => {
    const one = await call({ ...link("comment"), linkId: 3 }, OPERATIONS.thread!, as, undefined);
    const two = await call({ ...link("comment"), linkId: 4 }, OPERATIONS.thread!, as, undefined);
    expect((one.comments.createThread.mock.calls[0]![4] as { id: string }).id).not.toBe((two.comments.createThread.mock.calls[0]![4] as { id: string }).id);
  });

  it("needs a guest to give a name and an id before writing, and then touches nothing", async () => {
    for (const claimed of [{}, { name: "Grace" }, { clientId: BROWSER }, { name: "", clientId: BROWSER }, { name: "<b>", clientId: BROWSER }, { name: "Grace", clientId: "short" }, { name: "Grace", clientId: "has spaces in it!" }, { name: 7, clientId: BROWSER }]) {
      const { outcome, comments } = await call(link("comment"), OPERATIONS.thread!, claimed, undefined);
      expect(outcome, JSON.stringify(claimed)).toEqual({ ok: false, reason: "need_name" });
      expect(comments.createThread).not.toHaveBeenCalled();
    }
  });

  it("needs no name to move a thread onto the words its text was edited into: that is the page keeping up, not something written", async () => {
    const { outcome, comments } = await call(link("comment"), OPERATIONS.reanchor!, {}, undefined);
    expect(outcome).toEqual({ ok: true });
    expect(comments.reanchor).toHaveBeenCalledWith(1, DOC, 5, ANCHOR, { ...ANCHOR, quote: "an edited quote" });
  });

  it("needs no name to read", async () => {
    expect((await call(link("view"), OPERATIONS.list!, {}, undefined)).outcome.ok).toBe(true);
  });

  it("has a browser's id of 8 to 64 safe characters", () => {
    for (const ok of ["abcdefgh", "a".repeat(64), "A1_-b2C3d4"]) expect(CLIENT_ID.test(ok), ok).toBe(true);
    for (const bad of ["short", "a".repeat(65), "has space 12", "semi;colon1", ""]) expect(CLIENT_ID.test(bad), bad).toBe(false);
  });
});

describe("what listing says", () => {
  it("gives the threads, whether comments are closed, what the viewer may do, and the name they write as", async () => {
    const { run, comments } = setup(owner);
    comments.list.mockResolvedValue({ threads: [{ id: 1 } as never], closed: true, version: 7 });
    expect(await run({ docId: DOC, account: ALICE, cookie: undefined, claimed: {}, operation: { op: "list" } })).toEqual({ ok: true, threads: [{ id: 1 }], closed: true, version: 7, viewer: { role: "owner", canComment: true, canModerate: true, name: "Alice" } });
    expect(comments.list).toHaveBeenCalledWith(1, DOC, { kind: "account", id: "alice", name: "Alice" });
  });

  it("says a view link may not comment or moderate, and asks for the threads as nobody in particular when no name was given", async () => {
    const { run, comments } = setup(link("view"));
    const outcome = await run({ docId: DOC, account: undefined, cookie: undefined, claimed: {}, operation: { op: "list" } });
    expect(outcome).toMatchObject({ ok: true, viewer: { role: "view", canComment: false, canModerate: false, name: null } });
    expect(comments.list).toHaveBeenCalledWith(1, DOC, undefined);
  });

  it("says a comment link may comment, and an edit link too, and neither may moderate", async () => {
    for (const role of ["comment", "edit"] as const) {
      const { run } = setup(link(role));
      expect(await run({ docId: DOC, account: undefined, cookie: undefined, claimed: as, operation: { op: "list" } })).toMatchObject({ viewer: { role, canComment: true, canModerate: false, name: "Grace Hopper" } });
    }
  });
});

describe("what the service says", () => {
  it("is handed on: closed, not found, too many, a comment that is not one", async () => {
    for (const reason of ["closed", "not_found", "too_many", "bad_comment", "forbidden", "bad_anchor", "stale"] as const) {
      const { run, comments } = setup(owner);
      comments.reply.mockResolvedValue({ ok: false, reason } as never);
      expect(await run({ docId: DOC, account: ALICE, cookie: undefined, claimed: {}, operation: OPERATIONS.reply! })).toEqual({ ok: false, reason });
    }
  });

  it("hands the new comment's number back", async () => {
    expect(await call(owner, OPERATIONS.thread!).then((r) => r.outcome)).toEqual({ ok: true, id: 11 });
    expect(await call(owner, OPERATIONS.reply!).then((r) => r.outcome)).toEqual({ ok: true, id: 12 });
  });
});

describe("who may watch a document's comments (ROADMAP 1d.3)", () => {
  const watching = (viewer: Viewer | undefined) => {
    const version = vi.fn(async (..._args: unknown[]) => 12);
    const subscribe = vi.fn((..._args: unknown[]) => () => undefined);
    const current = { viewer };
    const open = commentsWatch({ viewer: async () => current.viewer, comments: { version } as never, subscribe: (c: number, d: string, l: () => void) => subscribe(c, d, l) as () => void, now: () => NOW } as never);
    return { open, version, subscribe, current };
  };
  const ask = { docId: DOC, account: undefined, cookie: undefined };

  it("is whoever may read the comments, by every way in and every role: view too", async () => {
    for (const viewer of [owner, named("view"), named("comment"), named("edit"), link("view"), link("comment"), link("edit")]) {
      const { open } = watching(viewer);
      expect((await open(ask)).ok, JSON.stringify(viewer.grants)).toBe(true);
    }
  });

  it("is nothing for someone let in nowhere, nor for a link that has expired or been revoked, and nothing is listened to", async () => {
    const { open, subscribe } = watching(undefined);
    expect(await open(ask)).toEqual({ ok: false, reason: "hidden" });
    for (const dead of [link("edit", { expiresAt: NOW }), link("edit", { revoked: true })]) expect(await watching(dead).open(ask)).toEqual({ ok: false, reason: "hidden" });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("watches the document's own comments, under the connection it found them in", async () => {
    const { open, version, subscribe } = watching(owner);
    const opened = await open(ask);
    if (!opened.ok) throw new Error("not opened");
    expect(opened.watch.holder).toBe("account:alice");
    expect(await opened.watch.version()).toBe(12);
    expect(version).toHaveBeenCalledWith(1, DOC);
    const listener = () => undefined;
    opened.watch.subscribe(listener);
    expect(subscribe).toHaveBeenCalledWith(1, DOC, listener);
  });

  it("is held to its account's streams, or its link's", async () => {
    const holders = await Promise.all([owner, link("view")].map(async (viewer) => (await watching(viewer).open(ask)) as { ok: true; watch: { holder: string } }));
    expect(holders.map((opened) => opened.watch.holder)).toEqual(["account:alice", "link:3"]);
  });

  it("asks again, each time it is asked whether the watcher may still: a link revoked since is no longer let in", async () => {
    const { open, current } = watching(link("comment"));
    const opened = await open(ask);
    if (!opened.ok) throw new Error("not opened");
    expect(await opened.watch.allowed()).toBe(true);
    current.viewer = link("comment", { revoked: true });
    expect(await opened.watch.allowed()).toBe(false);
    current.viewer = undefined;
    expect(await opened.watch.allowed()).toBe(false);
  });
});

describe("how fast comments are written (ROADMAP 1d.4)", () => {
  /** A limiter that counts what it is asked, and refuses the keys it is told to. */
  function limited(viewer: Viewer, refuse: (key: string) => boolean = () => false) {
    const asked: { key: string; rule: Rule }[] = [];
    const limiter: Limiter = {
      take: async (key, rule) => {
        asked.push({ key, rule });
        return refuse(key) ? { ok: false, retryAfterMs: 12_500 } : { ok: true };
      },
    };
    const { comments } = setup(viewer);
    const run = commentsAccess({ viewer: async () => viewer, comments, limiter, now: () => NOW });
    return { run, comments, asked };
  }
  const go = (run: ReturnType<typeof limited>["run"], operation: Operation, viewer: Viewer, claimed: object = as) => run({ docId: DOC, account: viewer.account, cookie: undefined, claimed, operation });

  it("counts a thread, a reply, an edit and a resolving, against the person and the link", async () => {
    for (const name of ["thread", "reply", "edit", "resolve"]) {
      const viewer = link("comment");
      const { run, asked } = limited(viewer);
      expect((await go(run, OPERATIONS[name]!, viewer)).ok, name).toBe(true);
      expect(asked.map((entry) => entry.key), name).toEqual([`comment:guest:3:${BROWSER}:60000`, `comment:guest:3:${BROWSER}:3600000`, "comment:link:3:60000", "comment:link:3:3600000"]);
    }
    const viewer = named("comment");
    const { run, asked } = limited(viewer);
    await go(run, OPERATIONS.thread!, viewer);
    expect(asked.map((entry) => entry.key)).toEqual(["comment:account:bob:60000", "comment:account:bob:3600000"]);
  });

  it("counts neither reading, nor deleting, nor closing", async () => {
    for (const name of ["list", "delete", "close"]) {
      const { run, asked } = limited(owner);
      await go(run, OPERATIONS[name]!, owner);
      expect(asked, name).toEqual([]);
    }
  });

  it("refuses with how long to wait when any one of them says no, and the service is not touched", async () => {
    for (const refuse of [(key: string) => key === "comment:link:3:60000", (key: string) => key.startsWith("comment:guest:"), (key: string) => key.endsWith(":3600000")]) {
      const viewer = link("comment");
      const { run, comments, asked } = limited(viewer, refuse);
      expect(await go(run, OPERATIONS.reply!, viewer)).toEqual({ ok: false, reason: "rate_limited", retryAfterMs: 12_500 });
      expect(comments.reply).not.toHaveBeenCalled();
      expect(asked.length).toBeGreaterThan(0);
    }
  });

  it("counts a request that turns out to be nothing, too: a flood of bad ones is a flood", async () => {
    const viewer = link("comment");
    const { run, comments, asked } = limited(viewer, () => true);
    expect((await go(run, { op: "thread", anchor: ANCHOR, body: "" }, viewer)).ok).toBe(false);
    expect(asked.length).toBeGreaterThan(0);
    expect(comments.createThread).not.toHaveBeenCalled();
  });

  it("does not count what the policy refuses, or a guest who has not given a name", async () => {
    const viewing = link("view");
    const first = limited(viewing);
    expect(await go(first.run, OPERATIONS.thread!, viewing)).toEqual({ ok: false, reason: "forbidden" });
    expect(first.asked).toEqual([]);
    const commenting = link("comment");
    const second = limited(commenting);
    expect(await go(second.run, OPERATIONS.thread!, commenting, {})).toEqual({ ok: false, reason: "need_name" });
    expect(second.asked).toEqual([]);
  });

  it("counts moving a thread onto edited words, by its own rule, with no name needed", async () => {
    const viewer = link("comment");
    const { run, asked, comments } = limited(viewer);
    expect(await go(run, OPERATIONS.reanchor!, viewer, {})).toEqual({ ok: true });
    expect(asked).toEqual([{ key: "comment:reanchor:link:3", rule: { limit: 120, windowMs: 60_000 } }]);
    const slow = limited(viewer, () => true);
    expect(await go(slow.run, OPERATIONS.reanchor!, viewer, {})).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(slow.comments.reanchor).not.toHaveBeenCalled();
    expect(comments.reanchor).toHaveBeenCalledTimes(1);
  });

  it("is no limit where there is no limiter", async () => {
    const { run } = setup(link("comment"));
    for (let i = 0; i < 100; i++) expect((await run({ docId: DOC, account: undefined, cookie: undefined, claimed: as, operation: OPERATIONS.thread! })).ok).toBe(true);
  });
});
