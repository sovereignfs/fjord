import { describe, expect, it } from "vitest";
import { attemptFrom, resolveFrom, versionFrom } from "./client";

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

describe("versionFrom", () => {
  it("is made, with the commit", () => {
    expect(versionFrom(201, { commit: "abc123" })).toEqual({ ok: true, commit: "abc123" });
  });

  it("is not made for a success that does not name a commit", () => {
    expect(versionFrom(201, {})).toMatchObject({ ok: false });
    expect(versionFrom(200, { commit: "abc123" })).toMatchObject({ ok: false });
  });

  it("says what the server said, which is in words a person can act on", () => {
    expect(versionFrom(409, { error: { message: "This note changed in the repository." } })).toEqual({ ok: false, message: "This note changed in the repository." });
  });

  it("says nothing was saved and the changes are kept, when signed out or when the server said nothing", () => {
    for (const result of [versionFrom(401, undefined), versionFrom(502, undefined), versionFrom(500, {})]) {
      expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/your changes are kept/i) });
    }
  });
});

describe("versionFrom's code", () => {
  it("carries the server's code, so the page can tell a note that changed from one that could not be reached", () => {
    expect(versionFrom(409, { error: { code: "upstream_changed", message: "This note changed." } })).toEqual({ ok: false, message: "This note changed.", code: "upstream_changed" });
    expect(versionFrom(502, undefined)).not.toHaveProperty("code");
  });
});

describe("resolveFrom", () => {
  it("is done, with how many conflicts are left to settle", () => {
    expect(resolveFrom(200, { conflicts: 0 })).toEqual({ ok: true, conflicts: 0 });
    expect(resolveFrom(200, { conflicts: 3 })).toEqual({ ok: true, conflicts: 3 });
  });

  it("is not done for a success that does not say how many", () => {
    expect(resolveFrom(200, {})).toMatchObject({ ok: false });
  });

  it.each(["no_draft", "up_to_date", "gone", "upstream_moved", "draft_changed"])("%s means the page is out of date: look again", (code) => {
    expect(resolveFrom(409, { error: { code, message: "words" } })).toEqual({ ok: false, lookAgain: true, message: "words" });
  });

  it.each(["unreadable", "unstorable", "bad_token", "unavailable"])("%s is not a reason to reload: the person chooses again", (code) => {
    expect(resolveFrom(422, { error: { code, message: "words" } })).toEqual({ ok: false, lookAgain: false, message: "words" });
  });

  it("says nothing was changed and the changes are kept, when signed out or when the server said nothing", () => {
    for (const result of [resolveFrom(401, undefined), resolveFrom(500, undefined)]) {
      expect(result).toMatchObject({ ok: false, lookAgain: false, message: expect.stringMatching(/your changes are kept/i) });
    }
  });
});
