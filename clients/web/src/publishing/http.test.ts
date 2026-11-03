import { describe, expect, it, vi } from "vitest";
import type { Caller } from "../working/http";
import { type Deps, handlePublication, pageUrl } from "./http";

const ORIGIN = "https://fjord.example.com";
const ALICE: Caller = { accountId: "alice", name: "Alice", email: "alice@example.com" };
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const TOKEN = "T".repeat(43);

function stub() {
  const publish = vi.fn(async (..._args: unknown[]): Promise<Awaited<ReturnType<Deps["publish"]>>> => ({ found: true, result: { ok: true, token: TOKEN } }));
  const status = vi.fn(async (..._args: unknown[]): Promise<Awaited<ReturnType<Deps["status"]>>> => ({ found: true, publishedAt: null }));
  const unpublish = vi.fn(async (..._args: unknown[]): Promise<Awaited<ReturnType<Deps["unpublish"]>>> => ({ found: true, unpublished: true }));
  const deps: Deps = { origin: ORIGIN, publish: (a, i, d) => publish(a, i, d), status: (a, i, d) => status(a, i, d), unpublish: (a, i, d) => unpublish(a, i, d) };
  return { deps, publish, status, unpublish };
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
    expect(publish).toHaveBeenCalledWith("alice", 1, DOC);
    expect(pageUrl(`${ORIGIN}///`, TOKEN)).toBe(`${ORIGIN}/p/${TOKEN}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("says whether a Doc is published, and since when, and never the token", async () => {
    const { deps, status } = stub();
    expect(await json(await handlePublication(get(DOC), ALICE, deps, "1"))).toEqual({ published: false, publishedAt: null });
    status.mockResolvedValueOnce({ found: true, publishedAt: 1_800_000_000_000 });
    const published = await handlePublication(get(DOC), ALICE, deps, "1");
    expect(await json(published)).toEqual({ published: true, publishedAt: 1_800_000_000_000 });
    expect(JSON.stringify(await json(await handlePublication(get(DOC), ALICE, deps, "1")))).not.toContain(TOKEN);
  });

  it("ends an address", async () => {
    const { deps, unpublish } = stub();
    const response = await handlePublication(send("DELETE", { doc: DOC }), ALICE, deps, "1");
    expect(await json(response)).toEqual({ unpublished: true });
    expect(unpublish).toHaveBeenCalledWith("alice", 1, DOC);
  });

  it("is for someone signed in (401), from this site for any change (403), by GET, POST or DELETE only (405), and for the caller's own connection (404)", async () => {
    const { deps, publish, status, unpublish } = stub();
    for (const request of [get(DOC), send("POST", { doc: DOC }), send("DELETE", { doc: DOC })]) expect((await handlePublication(request, null, deps, "1")).status).toBe(401);
    for (const origin of ["https://evil.example", `${ORIGIN}.evil.example`, "null", null]) {
      expect((await handlePublication(send("POST", { doc: DOC }, { origin }), ALICE, deps, "1")).status, String(origin)).toBe(403);
      expect((await handlePublication(send("DELETE", { doc: DOC }, { origin }), ALICE, deps, "1")).status, String(origin)).toBe(403);
    }
    for (const method of ["PUT", "PATCH"]) expect((await handlePublication(send(method, { doc: DOC }), ALICE, deps, "1")).status).toBe(405);
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
    expect((await handlePublication(send("POST", { doc: DOC, pad: "x".repeat(300) }), ALICE, deps, "1")).status).toBe(413);
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
