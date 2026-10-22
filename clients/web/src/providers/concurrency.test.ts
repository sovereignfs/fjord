import { describe, expect, it } from "vitest";
import { mapLimit } from "./concurrency";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapLimit", () => {
  it("never has more than the limit in flight, and does run that many at once", async () => {
    let inFlight = 0;
    let most = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      most = Math.max(most, ++inFlight);
      await sleep(5);
      inFlight--;
    });
    expect(most).toBe(4);
  });

  it("returns results in the order of the items, however long each took", async () => {
    const results = await mapLimit([30, 5, 15, 1], 4, async (ms) => {
      await sleep(ms);
      return ms;
    });
    expect(results).toEqual([30, 5, 15, 1]);
  });

  it("handles no items, and a limit larger than the items, and a nonsense limit", async () => {
    expect(await mapLimit([], 4, async (x) => x)).toEqual([]);
    expect(await mapLimit([1, 2], 100, async (x) => x * 2)).toEqual([2, 4]);
    expect(await mapLimit([1, 2, 3], 0, async (x) => x)).toEqual([1, 2, 3]);
  });

  it("rejects with the first failure, and starts nothing after it", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 2, async (x) => {
        started.push(x);
        await sleep(2);
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
    expect(started.length).toBeLessThan(8);
  });
});
