import { describe, expect, it } from "vitest";
import { idleVersionMs, workerEnabled } from "./config";

const MINUTE = 60 * 1000;

describe("the quiet period before an idle version", () => {
  it("is five minutes unless the instance says otherwise", () => {
    expect(idleVersionMs({})).toBe(5 * MINUTE);
    expect(idleVersionMs({ FJORD_IDLE_VERSION_MINUTES: "" })).toBe(5 * MINUTE);
  });

  it("is what the instance says, as whole minutes from 1 to 1440", () => {
    expect(idleVersionMs({ FJORD_IDLE_VERSION_MINUTES: "1" })).toBe(MINUTE);
    expect(idleVersionMs({ FJORD_IDLE_VERSION_MINUTES: " 30 " })).toBe(30 * MINUTE);
    expect(idleVersionMs({ FJORD_IDLE_VERSION_MINUTES: "1440" })).toBe(1440 * MINUTE);
  });

  it("is off at 0", () => {
    expect(idleVersionMs({ FJORD_IDLE_VERSION_MINUTES: "0" })).toBeUndefined();
  });

  it.each(["-5", "1.5", "abc", "5 min", "1441", "99999", "1e3", "0x10", "00"])("is not %j: the default is used", (value) => {
    expect(idleVersionMs({ FJORD_IDLE_VERSION_MINUTES: value })).toBe(5 * MINUTE);
  });
});

describe("whether this process runs the worker", () => {
  it("does, unless it is told `off`", () => {
    expect(workerEnabled({})).toBe(true);
    expect(workerEnabled({ FJORD_WORKER: "on" })).toBe(true);
    expect(workerEnabled({ FJORD_WORKER: "off" })).toBe(false);
    expect(workerEnabled({ FJORD_WORKER: " OFF " })).toBe(false);
  });
});
