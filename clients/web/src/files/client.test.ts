import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrom, sendCreate } from "./client";

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
