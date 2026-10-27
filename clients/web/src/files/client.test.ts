import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrom, deleteFrom, restoreFrom, sendCreate, sendDelete, sendRestore } from "./client";

describe("createFrom", () => {
  it("is made, with where", () => {
    expect(createFrom(201, { path: "Notes/Plan.md" })).toEqual({ ok: true, path: "Notes/Plan.md" });
  });

  it("is not made for a success that does not say where", () => {
    expect(createFrom(201, {})).toMatchObject({ ok: false });
    expect(createFrom(200, { path: "Notes/Plan.md" })).toMatchObject({ ok: false });
  });

  it("says what the server said, which is in words a person can act on", () => {
    expect(createFrom(409, { error: { message: "That folder is no longer in the repository." } })).toEqual({ ok: false, message: "That folder is no longer in the repository." });
  });

  it("says nothing was made when signed out or when the server said nothing", () => {
    for (const result of [createFrom(401, undefined), createFrom(502, undefined), createFrom(500, {})]) {
      expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/nothing was made/i) });
    }
  });
});

describe("sendCreate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the place, the title and the writer's own date and time, and nothing that names or contains the file", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ path: "Notes/Plan.md" }), { status: 201 }));
    vi.stubGlobal("fetch", fetched);
    const when = new Date(2026, 9, 22, 14, 30, 45); // local time: 22 October 2026, 14:30
    expect(await sendCreate(7, { vault: "Notes", folder: "Projects", kind: "note", title: "Plan" }, when)).toEqual({ ok: true, path: "Notes/Plan.md" });
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/connections/7/files");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      vault: "Notes",
      folder: "Projects",
      kind: "note",
      title: "Plan",
      localMinute: { year: 2026, month: 10, day: 22, hour: 14, minute: 30 },
    });
  });

  it("says nothing was made when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await sendCreate(7, { vault: "Notes", folder: "", kind: "note", title: "" })).toMatchObject({ ok: false, message: expect.stringMatching(/nothing was made/i) });
  });
});

describe("deleteFrom", () => {
  it("is done, with the numbers to put it back by", () => {
    expect(deleteFrom(200, { commit: "c", files: 3, deletions: [4, 5, 6] })).toEqual({ ok: true, deletions: [4, 5, 6], files: 3 });
  });

  it("is not done for a success that does not say what was recorded", () => {
    expect(deleteFrom(200, {})).toMatchObject({ ok: false });
    expect(deleteFrom(200, { deletions: [1] })).toMatchObject({ ok: false });
  });

  it.each(["gone", "upstream_changed", "folder_changed"])("%s means the page is out of date: look again", (code) => {
    expect(deleteFrom(409, { error: { code, message: "words" } })).toEqual({ ok: false, lookAgain: true, message: "words" });
  });

  it.each(["has_drafts", "draft_not_saved", "too_many", "protected", "read_only", "head_moved", "unavailable"])("%s is not a reason to reload", (code) => {
    expect(deleteFrom(409, { error: { code, message: "words" } })).toEqual({ ok: false, lookAgain: false, message: "words" });
  });

  it("says nothing was deleted when signed out or when the server said nothing", () => {
    for (const result of [deleteFrom(401, undefined), deleteFrom(502, undefined), deleteFrom(500, {})]) {
      expect(result).toMatchObject({ ok: false, lookAgain: false, message: expect.stringMatching(/nothing was deleted/i) });
    }
  });
});

describe("restoreFrom", () => {
  it("is put back, with where", () => {
    expect(restoreFrom(200, { commit: "c", paths: ["Notes/a.md"] })).toEqual({ ok: true, commit: "c", paths: ["Notes/a.md"] });
  });

  it("is not put back for a success that does not say where", () => {
    expect(restoreFrom(200, {})).toMatchObject({ ok: false });
  });

  it("says what the server said, and which paths are taken", () => {
    expect(restoreFrom(409, { error: { message: "Something is already there.", taken: ["Notes/a.md"] } })).toEqual({ ok: false, message: "Something is already there.", taken: ["Notes/a.md"] });
  });

  it("says nothing was put back when signed out or when the server said nothing", () => {
    for (const result of [restoreFrom(401, undefined), restoreFrom(502, undefined)]) {
      expect(result).toMatchObject({ ok: false, taken: [], message: expect.stringMatching(/nothing (was )?(put back|changed)/i) });
    }
  });
});

describe("sendDelete and sendRestore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("send a place and what the person was shown, and nothing that names a commit or a text", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ commit: "c", files: 1, deletions: [9] }), { status: 200 }));
    vi.stubGlobal("fetch", fetched);
    expect(await sendDelete(7, "Notes", { type: "file", path: "Notes/Plan.md", blob: "a".repeat(40) })).toEqual({ ok: true, deletions: [9], files: 1 });
    expect(await sendDelete(7, "Notes", { type: "folder", path: "Notes/Projects", files: 3 })).toMatchObject({ ok: true });
    const calls = fetched.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("/api/connections/7/files/delete");
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ vault: "Notes", type: "file", path: "Notes/Plan.md", blob: "a".repeat(40) });
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ vault: "Notes", type: "folder", path: "Notes/Projects", files: 3 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ commit: "c", paths: ["Notes/Plan.md"] }), { status: 200 })));
    expect(await sendRestore(7, [9])).toEqual({ ok: true, commit: "c", paths: ["Notes/Plan.md"] });
  });

  it("send a chosen place only when there is one", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ commit: "c", paths: ["x"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetched);
    await sendRestore(7, [9]);
    await sendRestore(7, [9], "Notes/Elsewhere.md");
    const calls = fetched.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ ids: [9] });
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ ids: [9], path: "Notes/Elsewhere.md" });
    expect(calls[0]![0]).toBe("/api/connections/7/files/restore");
  });

  it("say nothing was changed when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await sendDelete(7, "Notes", { type: "folder", path: "Notes/P", files: 1 })).toMatchObject({ ok: false, message: expect.stringMatching(/nothing was deleted/i) });
    expect(await sendRestore(7, [1])).toMatchObject({ ok: false, message: expect.stringMatching(/nothing was put back/i) });
  });
});
