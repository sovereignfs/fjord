import { describe, expect, it, vi } from "vitest";
import type { Caller } from "../working/http";
import { type Deps, handlePublication, pageUrl } from "./http";

const ORIGIN = "https://fjord.example.com";
const ALICE: Caller = { accountId: "alice", name: "Alice", email: "alice@example.com" };
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const TOKEN = "T".repeat(43);

function stub() {
  const publish = vi.fn(async (..._args: unknown[]): Promise<Awaited<ReturnType<Deps["publish"]>>> => ({ found: true, result: { ok: true, token: TOKEN } }));
  const status = vi.fn(async (..._args: unknown[]): Promise<Awaited<ReturnType<Deps["status"]>>> => ({ found: true, publishedAt: null, passwordProtected: false, comments: "off" }));
  const update = vi.fn(async (..._args: unknown[]): Promise<Awaited<ReturnType<Deps["update"]>>> => ({ found: true, updated: true }));
  const unpublish = vi.fn(async (..._args: unknown[]): Promise<Awaited<ReturnType<Deps["unpublish"]>>> => ({ found: true, unpublished: true }));
  const deps: Deps = { origin: ORIGIN, publish: (a, i, d, x) => publish(a, i, d, x), status: (a, i, d) => status(a, i, d), update: (a, i, d, x) => update(a, i, d, x), unpublish: (a, i, d) => unpublish(a, i, d) };
  return { deps, publish, status, update, unpublish };
}
const send = (method: string, body: unknown, init: { origin?: string | null; type?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers["content-type"] = init.type ?? "application/json";
  return new Request(`${ORIGIN}/api/connections/1/publication`, { method, headers, body: typeof body === "string" ? body : JSON.stringify(body) });
};
const get = (doc: string) => new Request(`${ORIGIN}/api/connections/1/publication?doc=${doc}`);
const json = async (response: Response) => JSON.parse(await response.text());

describe("publishing a Doc as a page (ROADMAP 3h.1)", () => {
  it("answers the address once, built on the instance's origin, for the caller's own connection", async () => {
    const { deps, publish } = stub();
    const response = await handlePublication(send("POST", { doc: DOC }), ALICE, deps, "1");
    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({ token: TOKEN, url: `${ORIGIN}/p/${TOKEN}` });
    expect(publish).toHaveBeenCalledWith("alice", 1, DOC, {});
    expect(pageUrl(`${ORIGIN}///`, TOKEN)).toBe(`${ORIGIN}/p/${TOKEN}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("says whether a Doc is published, and since when, and never the token itself", async () => {
    const { deps, status } = stub();
    expect(await json(await handlePublication(get(DOC), ALICE, deps, "1"))).toEqual({ published: false, publishedAt: null, passwordProtected: false, comments: "off" });
    status.mockResolvedValueOnce({ found: true, publishedAt: 1_800_000_000_000, passwordProtected: true, comments: "off" });
    const published = await handlePublication(get(DOC), ALICE, deps, "1");
    expect(await json(published)).toEqual({ published: true, publishedAt: 1_800_000_000_000, passwordProtected: true, comments: "off" });
    expect(JSON.stringify(await json(await handlePublication(get(DOC), ALICE, deps, "1")))).not.toContain(TOKEN);
  });

  it("publishes with a password and who may comment, passed on as given and never answered", async () => {
    const { deps, publish } = stub();
    const response = await handlePublication(send("POST", { doc: DOC, password: "correct horse battery", comments: "users" }), ALICE, deps, "1");
    expect(response.status).toBe(201);
    expect(publish).toHaveBeenCalledWith("alice", 1, DOC, { password: "correct horse battery", comments: "users" });
    expect(await response.text()).not.toContain("correct horse");
  });

  it("refuses a password that is too short and a comment mode that is not one, in words, and publishes nothing", async () => {
    const { deps, publish } = stub();
    for (const body of [{ doc: DOC, password: "short" }, { doc: DOC, password: 12345678 }, { doc: DOC, comments: "everyone" }]) {
      const response = await handlePublication(send("POST", body), ALICE, deps, "1");
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("changes how a page is open without a new address: a password set or taken off (null), and who may comment", async () => {
    const { deps, update } = stub();
    expect((await handlePublication(send("PATCH", { doc: DOC, password: "correct horse battery" }), ALICE, deps, "1")).status).toBe(200);
    expect(update).toHaveBeenLastCalledWith("alice", 1, DOC, { password: "correct horse battery" });
    expect((await handlePublication(send("PATCH", { doc: DOC, password: null }), ALICE, deps, "1")).status).toBe(200);
    expect(update).toHaveBeenLastCalledWith("alice", 1, DOC, { password: null });
    expect((await handlePublication(send("PATCH", { doc: DOC, comments: "anyone" }), ALICE, deps, "1")).status).toBe(200);
    update.mockResolvedValueOnce({ found: true, updated: false });
    expect((await handlePublication(send("PATCH", { doc: DOC, comments: "off" }), ALICE, deps, "1")).status).toBe(404);
    update.mockResolvedValueOnce({ found: false });
    expect((await handlePublication(send("PATCH", { doc: DOC, comments: "off" }), ALICE, deps, "9")).status, "another's connection").toBe(404);
    expect((await handlePublication(send("PATCH", { doc: DOC, password: "short" }), ALICE, deps, "1")).status).toBe(400);
  });

  it("shows the owner the page's address again when the server kept it, built on the instance's origin", async () => {
    const { deps, status } = stub();
    status.mockResolvedValueOnce({ found: true, publishedAt: 5, passwordProtected: false, comments: "off", token: TOKEN });
    expect(await json(await handlePublication(get(DOC), ALICE, deps, "1"))).toMatchObject({ published: true, url: `${ORIGIN}/p/${TOKEN}` });
    expect(await json(await handlePublication(get(DOC), ALICE, deps, "1"))).not.toHaveProperty("url");
  });

  it("ends an address", async () => {
    const { deps, unpublish } = stub();
    const response = await handlePublication(send("DELETE", { doc: DOC }), ALICE, deps, "1");
    expect(await json(response)).toEqual({ unpublished: true });
    expect(unpublish).toHaveBeenCalledWith("alice", 1, DOC);
  });

  it("is for someone signed in (401), from this site for any change (403), by GET, POST, PATCH or DELETE only (405), and for the caller's own connection (404)", async () => {
    const { deps, publish, status, unpublish } = stub();
    for (const request of [get(DOC), send("POST", { doc: DOC }), send("DELETE", { doc: DOC })]) expect((await handlePublication(request, null, deps, "1")).status).toBe(401);
    for (const origin of ["https://evil.example", `${ORIGIN}.evil.example`, "null", null]) {
      expect((await handlePublication(send("POST", { doc: DOC }, { origin }), ALICE, deps, "1")).status, String(origin)).toBe(403);
      expect((await handlePublication(send("DELETE", { doc: DOC }, { origin }), ALICE, deps, "1")).status, String(origin)).toBe(403);
    }
    for (const method of ["PUT"]) expect((await handlePublication(send(method, { doc: DOC }), ALICE, deps, "1")).status).toBe(405);
    expect(publish).not.toHaveBeenCalled();
    expect(unpublish).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    for (const id of ["0", "01", "x", "-1", "1".repeat(17)]) expect((await handlePublication(get(DOC), ALICE, deps, id)).status, id).toBe(404);
    publish.mockResolvedValueOnce({ found: false });
    status.mockResolvedValueOnce({ found: false });
    unpublish.mockResolvedValueOnce({ found: false });
    expect((await handlePublication(send("POST", { doc: DOC }), ALICE, deps, "1")).status).toBe(404);
    expect((await handlePublication(get(DOC), ALICE, deps, "1")).status).toBe(404);
    expect((await handlePublication(send("DELETE", { doc: DOC }), ALICE, deps, "1")).status).toBe(404);
  });

  it.each([
    ["no doc", {}],
    ["a doc that is not an id", { doc: "main" }],
    ["an id in capitals", { doc: DOC.toUpperCase() }],
    ["a doc that is not text", { doc: 7 }],
  ])("refuses %s with 400, without asking", async (_name, sent) => {
    const { deps, publish } = stub();
    expect((await handlePublication(send("POST", sent), ALICE, deps, "1")).status).toBe(400);
    expect((await handlePublication(send("POST", "not json"), ALICE, deps, "1")).status).toBe(400);
    expect((await handlePublication(send("POST", sent, { type: "text/plain" }), ALICE, deps, "1")).status).toBe(415);
    expect((await handlePublication(send("POST", { doc: DOC, pad: "x".repeat(1100) }), ALICE, deps, "1")).status).toBe(413);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ["gone", 404],
    ["unavailable", 502],
  ] as const)("%s is %i, with its own code and no token", async (reason, statusCode) => {
    const { deps, publish } = stub();
    publish.mockResolvedValueOnce({ found: true, result: { ok: false, reason } });
    const response = await handlePublication(send("POST", { doc: DOC }), ALICE, deps, "1");
    expect(response.status).toBe(statusCode);
    const body = await json(response);
    expect(body.error.code).toBe(reason);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});
