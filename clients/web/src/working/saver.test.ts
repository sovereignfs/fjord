import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Attempt, DraftSaver, type SaverStatus } from "./saver";

/**
 * When a draft is sent as someone types (ROADMAP 1b.8): with fake timers and a stand-in for the request, so the timing
 * is exact and each promise can be held until the test lets it go.
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const KEPT: Attempt = { kind: "kept" };

function setup(initial = "base", answers: Attempt[] = []) {
  const sent: string[] = [];
  const held: Array<(attempt: Attempt) => void> = [];
  const send = vi.fn(async (content: string): Promise<Attempt> => {
    sent.push(content);
    const next = answers.shift();
    if (next) return next;
    return new Promise((resolve) => held.push(resolve));
  });
  const saver = new DraftSaver({ initial, send, timers: { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (h) => clearTimeout(h as never), now: () => Date.now() } });
  const states: SaverStatus["state"][] = [];
  saver.subscribe((status) => states.push(status.state));
  return { saver, sent, held, send, states };
}

describe("when it sends", () => {
  it("sends nothing until something changes", async () => {
    const { send } = setup();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the text a second after the last change, once, however many changes there were", async () => {
    const { saver, sent } = setup("", [KEPT]);
    for (const text of ["h", "he", "hel", "hell", "hello"]) {
      saver.change(text);
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual(["hello"]);
    expect(saver.status).toEqual({ state: "kept" });
    expect(saver.unsaved).toBe(false);
  });

  it("sends at the latest five seconds after the first unsent change, even if typing never pauses", async () => {
    const { saver, sent } = setup("", [KEPT, KEPT]);
    let typed = "";
    for (let i = 0; i < 20; i++) {
      typed += "x";
      saver.change(typed);
      await vi.advanceTimersByTimeAsync(400);
    }
    // 8 s of typing with a pause of at most 400 ms: kept at about 5 s, not at 8 s + 1 s.
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]!.length).toBeLessThanOrEqual(13);
  });

  it("sends nothing for a change that puts the text back as the server has it", async () => {
    const { saver, send, states } = setup("original");
    saver.change("original!");
    saver.change("original");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(saver.status).toEqual({ state: "idle" });
    expect(states.at(-1)).toBe("idle");
    expect(saver.unsaved).toBe(false);
  });

  it("does send a text that is the note's own when the server holds a draft that differs", async () => {
    const { saver, sent } = setup("a draft", [KEPT]);
    saver.change("the note as it was");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["the note as it was"]);
  });

  it("does not send the same text twice", async () => {
    const { saver, send } = setup("", [KEPT]);
    saver.change("one");
    await vi.advanceTimersByTimeAsync(1000);
    saver.change("one");
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("one at a time, in order", () => {
  it("holds a change made while one is on its way, and then sends the latest text only", async () => {
    const { saver, sent, held } = setup();
    saver.change("one");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["one"]);
    expect(saver.status).toEqual({ state: "saving" });

    saver.change("two");
    saver.change("three");
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual(["one"]); // still waiting for the first to be answered

    held[0]!(KEPT);
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.status).toEqual({ state: "pending" });
    expect(saver.unsaved).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["one", "three"]);
    held[1]!(KEPT);
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.status).toEqual({ state: "kept" });
  });

  it("is not kept when the text on screen changed meanwhile and was changed back", async () => {
    const { saver, held } = setup();
    saver.change("one");
    await vi.advanceTimersByTimeAsync(1000);
    saver.change("two");
    saver.change("one");
    held[0]!(KEPT);
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.unsaved).toBe(false);
    expect(saver.status).toEqual({ state: "kept" });
  });
});

describe("when it goes wrong", () => {
  it("tries again after growing waits, with the latest text, and loses nothing", async () => {
    const { saver, sent } = setup("", [{ kind: "failed" }, { kind: "failed" }, { kind: "failed" }, KEPT]);
    saver.change("precious");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["precious"]);
    expect(saver.status).toEqual({ state: "retrying", attempt: 1 });

    await vi.advanceTimersByTimeAsync(1999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    expect(saver.status).toEqual({ state: "retrying", attempt: 2 });

    await vi.advanceTimersByTimeAsync(4999);
    expect(sent).toHaveLength(2);
    saver.change("precious!");
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["precious", "precious", "precious!"]);
    expect(saver.status).toEqual({ state: "retrying", attempt: 3 });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent).toHaveLength(4);
    expect(saver.status).toEqual({ state: "kept" });
    expect(saver.unsaved).toBe(false);
  });

  it("does not put a retry off for as long as someone keeps typing", async () => {
    const { saver, sent } = setup("", [{ kind: "failed" }]);
    saver.change("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.status).toEqual({ state: "retrying", attempt: 1 });
    let typed = "a";
    for (let i = 0; i < 6; i++) {
      typed += "b";
      saver.change(typed);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(sent.length).toBe(2); // retried at 2 s after the failure although there was never a pause
  });

  it("keeps the last wait when it keeps failing", async () => {
    const { saver, send } = setup("", Array.from({ length: 12 }, (): Attempt => ({ kind: "failed" })));
    saver.change("x");
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 5000 + 15_000 + 30_000 + 30_000 + 30_000);
    expect(send).toHaveBeenCalledTimes(7);
    expect(saver.status.state).toBe("retrying");
  });

  it("counts a request that threw as a failure", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(KEPT);
    const saver = new DraftSaver({ initial: "", send });
    saver.change("x");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.status).toEqual({ state: "retrying", attempt: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(saver.status).toEqual({ state: "kept" });
  });

  it("waits for the next change after a refusal about the text, and then tries that", async () => {
    const { saver, sent } = setup("", [{ kind: "refused", stop: false, message: "NUL" }, KEPT]);
    saver.change("bad\u0000");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.status).toEqual({ state: "refused", message: "NUL" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual(["bad\u0000"]);
    saver.change("good");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["bad\u0000", "good"]);
    expect(saver.status).toEqual({ state: "kept" });
  });

  it("stops for good after a refusal about the draft, and still knows what is not kept", async () => {
    const { saver, send } = setup("", [{ kind: "refused", stop: true, message: "another version" }]);
    saver.change("mine");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.status).toEqual({ state: "stopped", message: "another version" });
    saver.change("mine, more");
    await vi.advanceTimersByTimeAsync(60_000);
    await saver.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(saver.status.state).toBe("stopped");
    expect(saver.unsaved).toBe(true);
  });
});

describe("flush", () => {
  it("sends at once what is waiting, and resolves when it has been answered", async () => {
    const { saver, sent } = setup("", [KEPT]);
    saver.change("leaving");
    expect(sent).toEqual([]);
    await saver.flush();
    expect(sent).toEqual(["leaving"]);
    expect(saver.unsaved).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual(["leaving"]); // the timer it replaced did not send it again
  });

  it("does nothing when nothing is waiting", async () => {
    const { saver, send } = setup();
    await saver.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("tries a failed one now rather than at its turn", async () => {
    const { saver, sent } = setup("", [{ kind: "failed" }, KEPT]);
    saver.change("x");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(1);
    await saver.flush();
    expect(sent).toHaveLength(2);
    expect(saver.status).toEqual({ state: "kept" });
  });

  it("waits for the one on its way and then sends what came after it", async () => {
    const { saver, sent, held } = setup();
    saver.change("one");
    await vi.advanceTimersByTimeAsync(1000);
    saver.change("two");
    const flushed = saver.flush();
    held[0]!(KEPT);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["one"]);
    await vi.advanceTimersByTimeAsync(1000);
    held[1]?.(KEPT);
    await flushed;
    expect(sent).toEqual(["one", "two"]);
  });

  it("sends nothing after it is disposed", async () => {
    const { saver, send } = setup();
    saver.change("x");
    saver.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    await saver.flush();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("what it says", () => {
  it("goes from pending to saving to kept", async () => {
    const { saver, states, held } = setup();
    saver.change("x");
    await vi.advanceTimersByTimeAsync(1000);
    held[0]!(KEPT);
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(["pending", "saving", "kept"]);
  });
});
