import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialError } from "../crypto/errors";
import { type EventDeps, MAX_STREAMS, type Watch, handleEvents, streamsOpen } from "./events";

/**
 * The live stream of a document's comments (ROADMAP 1d.3): who may open it, what it says (that comments changed, never what they are), and that it ends
 * when it should. Who may read the comments is the policy's and `access.test.ts`'s; the whole of it in two browsers is `e2e/`.
 */
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const ORIGIN = "https://fjord.example.com";
const COOKIE = `fjord_share=${"T".repeat(43)}`;
const ALICE = { accountId: "alice", name: "Alice" };

function controllable(initial = 5) {
  let version = initial;
  let allowed = true;
  const listeners = new Set<() => void>();
  const watch: Watch = {
    version: vi.fn(async () => version),
    allowed: vi.fn(async () => allowed),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    watch,
    listeners,
    bump: (to = version + 1) => {
      version = to;
      for (const listener of [...listeners]) listener();
    },
    quietly: (to: number) => void (version = to),
    revoke: () => void (allowed = false),
  };
}
const depsFor = (watch: Watch, extra: Partial<EventDeps> = {}): EventDeps => ({ open: async () => ({ ok: true, watch }), pollMs: 20, recheckMs: 40, ...extra });
const get = (signal?: AbortSignal) => new Request(`${ORIGIN}/doc/${DOC}/comments/events`, { headers: { cookie: COOKIE }, ...(signal ? { signal } : {}) });

/** The messages of a stream so far, read until `until` holds or the stream ends. */
async function messages(response: Response, until: (text: string) => boolean, timeoutMs = 2000): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now())))]);
      if (chunk.value) text += decoder.decode(chunk.value);
      if (until(text) || chunk.done) break;
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

afterEach(async () => {
  await vi.waitFor(() => expect(streamsOpen()).toBe(0), { timeout: 2000 });
});

describe("opening the stream", () => {
  it("is a stream of events that nothing in between may keep or change", async () => {
    const { watch } = controllable();
    const controller = new AbortController();
    const response = await handleEvents(get(controller.signal), ALICE, depsFor(watch), DOC);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    controller.abort();
  });

  it("is only for GET, and only for a document's id, before anything is asked", async () => {
    const open = vi.fn();
    const deps: EventDeps = { open };
    expect((await handleEvents(new Request(`${ORIGIN}/x`, { method: "POST" }), ALICE, deps, DOC)).status).toBe(405);
    for (const id of ["nope", "../x", DOC.toUpperCase()]) expect((await handleEvents(get(), ALICE, deps, id)).status, id).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  it("hands on who is asking: the account and the link's cookie", async () => {
    const { watch } = controllable();
    const open = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, watch }));
    const controller = new AbortController();
    await handleEvents(get(controller.signal), ALICE, { open: (input) => open(input), pollMs: 20 }, DOC);
    expect(open).toHaveBeenCalledWith({ docId: DOC, account: { id: "alice", name: "Alice" }, cookie: "T".repeat(43) });
    controller.abort();
  });

  it("is refused to someone who may not read the comments: not found if they are let in nowhere, forbidden if let in but not to this", async () => {
    for (const [reason, status] of [["hidden", 404], ["forbidden", 403]] as const) {
      const response = await handleEvents(get(), null, { open: async () => ({ ok: false, reason }) }, DOC);
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toBe("application/json");
    }
  });

  it("says nothing different for a document that is not there and one the person may not see", async () => {
    const a = await (await handleEvents(get(), null, { open: async () => ({ ok: false, reason: "hidden" }) }, DOC)).text();
    const b = await (await handleEvents(get(), ALICE, { open: async () => ({ ok: false, reason: "hidden" }) }, DOC)).text();
    expect(b).toBe(a);
  });

  it("says when the instance cannot read repositories, and answers the unexpected plainly", async () => {
    expect((await handleEvents(get(), ALICE, { open: async () => Promise.reject(new CredentialError("no_key", "no key")) }, DOC)).status).toBe(503);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleEvents(get(), ALICE, { open: async () => Promise.reject(new Error(`cookie ${"T".repeat(43)} at postgres://u:hunter2@db`)) }, DOC);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/hunter2|TTTT/);
    expect(logged.mock.calls.flat().join(" ")).not.toMatch(/hunter2|TTTT/);
    logged.mockRestore();
  });

  it("holds only so many streams, then says to try later, and takes one back when a stream ends", async () => {
    const { watch } = controllable();
    const controllers: AbortController[] = [];
    for (let i = 0; i < MAX_STREAMS; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      expect((await handleEvents(get(controller.signal), ALICE, depsFor(watch, { pollMs: 60_000 }), DOC)).status).toBe(200);
    }
    expect(streamsOpen()).toBe(MAX_STREAMS);
    const refused = await handleEvents(get(), ALICE, depsFor(watch), DOC);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBeTruthy();
    for (const controller of controllers) controller.abort();
    await vi.waitFor(() => expect(streamsOpen()).toBe(0));
    const again = new AbortController();
    expect((await handleEvents(get(again.signal), ALICE, depsFor(watch), DOC)).status).toBe(200);
    again.abort();
  });
});

describe("what it says", () => {
  it("starts with the version the comments are at, and says nothing of their content", async () => {
    const { watch } = controllable(5);
    const controller = new AbortController();
    const response = await handleEvents(get(controller.signal), ALICE, depsFor(watch), DOC);
    const text = await messages(response, (seen) => seen.includes("event: version"));
    expect(text).toContain("retry: 5000");
    expect(text).toContain('event: version\ndata: {"version":5}');
    controller.abort();
  });

  it("says at once when a change is made in this process, and once for each version", async () => {
    const control = controllable(5);
    const controller = new AbortController();
    const response = await handleEvents(get(controller.signal), ALICE, depsFor(control.watch, { pollMs: 60_000 }), DOC);
    const reading = messages(response, (seen) => seen.includes('"version":6'));
    await vi.waitFor(() => expect(control.listeners.size).toBe(1));
    control.bump(6);
    const text = await reading;
    expect(text).toContain('event: changed\ndata: {"version":6}');
    expect(text.match(/event: changed/g)).toHaveLength(1);
    controller.abort();
  });

  it("finds a change made by another process, from the database, without being told", async () => {
    const control = controllable(5);
    const controller = new AbortController();
    const response = await handleEvents(get(controller.signal), ALICE, depsFor(control.watch, { pollMs: 15 }), DOC);
    const reading = messages(response, (seen) => seen.includes('"version":9'));
    await vi.waitFor(() => expect(control.listeners.size).toBe(1));
    control.quietly(9);
    expect(await reading).toContain('event: changed\ndata: {"version":9}');
    controller.abort();
  });

  it("says a version that went down too (the comments were forgotten and started again)", async () => {
    const control = controllable(5);
    const controller = new AbortController();
    const response = await handleEvents(get(controller.signal), ALICE, depsFor(control.watch, { pollMs: 15 }), DOC);
    const reading = messages(response, (seen) => seen.includes('"version":0'));
    await vi.waitFor(() => expect(control.listeners.size).toBe(1));
    control.quietly(0);
    expect(await reading).toContain('event: changed\ndata: {"version":0}');
    controller.abort();
  });

  it("is not silent for long, so that nothing in between closes it", async () => {
    const control = controllable();
    const controller = new AbortController();
    const response = await handleEvents(get(controller.signal), ALICE, depsFor(control.watch, { pollMs: 10, quietMs: 25 }), DOC);
    expect(await messages(response, (seen) => seen.includes(": still here"))).toContain(": still here");
    controller.abort();
  });
});

describe("when it ends", () => {
  it("says gone, once, and ends, when the watcher may no longer read the comments", async () => {
    const control = controllable();
    const response = await handleEvents(get(), ALICE, depsFor(control.watch, { pollMs: 10, recheckMs: 10 }), DOC);
    const reading = messages(response, () => false, 1000);
    await vi.waitFor(() => expect(control.listeners.size).toBe(1));
    control.revoke();
    const text = await reading;
    expect(text.match(/event: gone/g)).toHaveLength(1);
    expect(control.listeners.size).toBe(0);
    expect(streamsOpen()).toBe(0);
  });

  it("asks again who may watch only every so often, not at every look", async () => {
    const control = controllable();
    const controller = new AbortController();
    await handleEvents(get(controller.signal), ALICE, depsFor(control.watch, { pollMs: 5, recheckMs: 60_000 }), DOC);
    await vi.waitFor(() => expect(vi.mocked(control.watch.version).mock.calls.length).toBeGreaterThan(4));
    expect(vi.mocked(control.watch.allowed).mock.calls.length).toBeLessThanOrEqual(1);
    controller.abort();
  });

  it("ends by itself after its lifetime, for the browser to open a new one", async () => {
    const control = controllable();
    const response = await handleEvents(get(), ALICE, depsFor(control.watch, { pollMs: 10, lifetimeMs: 30 }), DOC);
    await messages(response, () => false, 1000);
    expect(streamsOpen()).toBe(0);
    expect(control.listeners.size).toBe(0);
  });

  it("stops listening and gives its place back when the browser goes away", async () => {
    const control = controllable();
    const controller = new AbortController();
    await handleEvents(get(controller.signal), ALICE, depsFor(control.watch), DOC);
    await vi.waitFor(() => expect(control.listeners.size).toBe(1));
    expect(streamsOpen()).toBe(1);
    controller.abort();
    await vi.waitFor(() => expect(control.listeners.size).toBe(0));
    expect(streamsOpen()).toBe(0);
  });

  it("ends when it cannot look (the database is down), for the browser to try again", async () => {
    const control = controllable();
    vi.mocked(control.watch.version).mockRejectedValue(new Error("down"));
    const response = await handleEvents(get(), ALICE, depsFor(control.watch), DOC);
    await messages(response, () => false, 1000);
    expect(streamsOpen()).toBe(0);
  });
});
