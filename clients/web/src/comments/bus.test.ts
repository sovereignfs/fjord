import { describe, expect, it, vi } from "vitest";
import { CommentBus, commentBus } from "./bus";

/** Telling the streams of this process that a document's comments changed (ROADMAP 1d.3). */
describe("the bus", () => {
  it("tells those watching a document, and only those, and no longer those who stopped", () => {
    const bus = new CommentBus();
    const mine = vi.fn();
    const other = vi.fn();
    const elsewhere = vi.fn();
    const stop = bus.subscribe(1, "doc-a", mine);
    bus.subscribe(1, "doc-b", other);
    bus.subscribe(2, "doc-a", elsewhere);
    bus.publish(1, "doc-a");
    expect([mine.mock.calls.length, other.mock.calls.length, elsewhere.mock.calls.length]).toEqual([1, 0, 0]);
    stop();
    bus.publish(1, "doc-a");
    expect(mine).toHaveBeenCalledTimes(1);
    expect(bus.size).toBe(2);
  });

  it("tells every watcher though one of them fails, and forgets a document nobody watches", () => {
    const bus = new CommentBus();
    const after = vi.fn();
    bus.subscribe(1, "d", () => {
      throw new Error("broken");
    });
    const stop = bus.subscribe(1, "d", after);
    bus.publish(1, "d");
    expect(after).toHaveBeenCalledTimes(1);
    stop();
  });

  it("is one per process, however many copies of the module are loaded", () => {
    expect(commentBus()).toBe(commentBus());
  });
});
