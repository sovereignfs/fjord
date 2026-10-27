import { describe, expect, it } from "vitest";
import { rememberUndo, takeUndo } from "./undo";

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("the offer to undo", () => {
  it("is read once", () => {
    const storage = memory();
    rememberUndo(storage, 1, { ids: [4, 5], label: "Weekly review" });
    expect(takeUndo(storage, 1)).toEqual({ ids: [4, 5], label: "Weekly review" });
    expect(takeUndo(storage, 1)).toBeUndefined();
  });

  it("is of one repository and not another", () => {
    const storage = memory();
    rememberUndo(storage, 1, { ids: [4], label: "A" });
    expect(takeUndo(storage, 2)).toBeUndefined();
    expect(takeUndo(storage, 1)).toBeDefined();
  });

  it.each([
    ["not JSON", "{nope"],
    ["null", "null"],
    ["no ids", '{"label":"x"}'],
    ["no label", '{"ids":[1]}'],
    ["ids that are not numbers", '{"ids":["1"],"label":"x"}'],
    ["ids that are not positive", '{"ids":[0],"label":"x"}'],
    ["none", '{"ids":[],"label":"x"}'],
    ["too many", JSON.stringify({ ids: Array.from({ length: 1001 }, (_, i) => i + 1), label: "x" })],
  ])("is not made of %s, which is thrown away", (_name, raw) => {
    const storage = memory();
    storage.setItem("fjord:undo:1", raw);
    expect(takeUndo(storage, 1)).toBeUndefined();
    expect(storage.getItem("fjord:undo:1")).toBeNull();
  });

  it("keeps a label to a sensible length", () => {
    const storage = memory();
    rememberUndo(storage, 1, { ids: [1], label: "x".repeat(500) });
    expect(takeUndo(storage, 1)?.label).toHaveLength(200);
  });

  it("does nothing, and does not fail, when storage refuses or is not there", () => {
    const refusing = { setItem: () => { throw new Error("quota"); }, getItem: () => { throw new Error("denied"); }, removeItem: () => undefined };
    expect(() => rememberUndo(refusing, 1, { ids: [1], label: "x" })).not.toThrow();
    expect(takeUndo(refusing, 1)).toBeUndefined();
  });
});
