import { afterEach, describe, expect, it, vi } from "vitest";
import { everyUnlessRunning } from "./loop";

afterEach(() => vi.useRealTimers());

describe("a task run every so often", () => {
  it("runs again when the interval has passed", async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => {});
    const loop = everyUnlessRunning(task, 1000, "test");
    await vi.advanceTimersByTimeAsync(3000);
    expect(task).toHaveBeenCalledTimes(3);
    loop.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("never overlaps a run that is still going", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const task = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const loop = everyUnlessRunning(task, 1000, "test");
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("goes on after a run that throws, and logs only its name", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const task = vi.fn(async () => {
      throw new TypeError("secret detail");
    });
    const loop = everyUnlessRunning(task, 1000, "test");
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("[fjord] test: unexpected TypeError");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    loop.stop();
    log.mockRestore();
  });
});
