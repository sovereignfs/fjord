import { describe, expect, it } from "vitest";
import { restoreWindowMs } from "./config";

const DAY = 24 * 60 * 60 * 1000;

describe("the restore window", () => {
  it("is 30 days unless the instance says otherwise", () => {
    expect(restoreWindowMs({})).toBe(30 * DAY);
    expect(restoreWindowMs({ FJORD_RESTORE_WINDOW_DAYS: "" })).toBe(30 * DAY);
  });

  it("is what the instance says, as whole days from 1 to 3650", () => {
    expect(restoreWindowMs({ FJORD_RESTORE_WINDOW_DAYS: "7" })).toBe(7 * DAY);
    expect(restoreWindowMs({ FJORD_RESTORE_WINDOW_DAYS: " 90 " })).toBe(90 * DAY);
    expect(restoreWindowMs({ FJORD_RESTORE_WINDOW_DAYS: "3650" })).toBe(3650 * DAY);
  });

  it.each(["0", "-5", "1.5", "abc", "30 days", "3651", "99999", "1e3", "0x10"])("is not %j: the default is used", (value) => {
    expect(restoreWindowMs({ FJORD_RESTORE_WINDOW_DAYS: value })).toBe(30 * DAY);
  });
});
