import { describe, expect, it } from "vitest";
import { attemptFrom } from "./client";

/** What each answer from the server means for the saver: a text is only ever given up on for a reason that retrying cannot fix. */
const error = (code: string, message = "words") => ({ error: { code, message } });

describe("attemptFrom", () => {
  it("is kept for a success", () => {
    expect(attemptFrom(200, { })).toEqual({ kind: "kept" });
  });

  it.each([
    ["base_mismatch", 409],
    ["not_editable", 422],
  ])("stops for %s: nothing the person types can fix it", (code, status) => {
    expect(attemptFrom(status, error(code))).toMatchObject({ kind: "refused", stop: true });
  });

  it.each([
    ["unstorable", 422],
    ["too_large", 413],
    ["too_many_drafts", 422],
  ])("waits for another change for %s: the next text may be fine", (code, status) => {
    expect(attemptFrom(status, error(code, "NUL"))).toEqual({ kind: "refused", stop: false, message: "NUL" });
  });

  it("stops when signed out, and when the repository is not theirs any more, and says what to do", () => {
    expect(attemptFrom(401, undefined)).toMatchObject({ kind: "refused", stop: true, message: expect.stringContaining("signed out") });
    expect(attemptFrom(403, error("forbidden"))).toMatchObject({ kind: "refused", stop: true });
    expect(attemptFrom(404, error("not_found"))).toMatchObject({ kind: "refused", stop: true });
  });

  it.each([429, 500, 502, 503, 504, 0])("tries again later for %i, and also for an answer that is not ours", (status) => {
    expect(attemptFrom(status, undefined)).toEqual({ kind: "failed" });
    expect(attemptFrom(status, error("rate_limited"))).toEqual({ kind: "failed" });
  });
});
