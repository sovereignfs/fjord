import { describe, expect, it } from "vitest";
import { MAX_PAGE_BYTES, RAW_POLICY, type RawDeps, handleRaw } from "./raw";

/** Who may be served a repository's HTML page, and what it is served with (workstream 0003, leg 5): the rules, with a stand-in for the repository. */
const HANDLE = "0123456789abcdef";
const PAGE = new TextEncoder().encode("<ul><li>a</li></ul><script>1</script>");
const ALICE = { accountId: "alice" };

const deps = (over: Partial<RawDeps> = {}): RawDeps => ({
  resolve: async (handle) => (handle === HANDLE ? { connectionId: 5, path: "Notes/checklist.html" } : undefined),
  read: async (accountId, connectionId) => (accountId === "alice" && connectionId === 5 ? { ok: true, bytes: PAGE } : { ok: false, reason: "missing" }),
  ...over,
});

describe("serving a page", () => {
  it("gives the owner the file, as HTML in a sandbox with no origin of this app's, no network and no framing but by this origin", async () => {
    const response = await handleRaw(ALICE, "5", HANDLE, deps());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<ul><li>a</li></ul><script>1</script>");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const policy = response.headers.get("content-security-policy")!;
    expect(policy).toBe(RAW_POLICY);
    // The sandbox is what keeps it off this app's origin and cookies: it runs scripts and nothing else of an origin's.
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("is a 404 that says nothing for someone signed out, someone else's repository, a handle that is not there or is another repository's, and a file that is not a page", async () => {
    expect((await handleRaw(null, "5", HANDLE, deps())).status).toBe(404);
    expect((await handleRaw({ accountId: "mallory" }, "5", HANDLE, deps())).status).toBe(404);
    expect((await handleRaw(ALICE, "5", "fedcba9876543210", deps())).status).toBe(404);
    expect((await handleRaw(ALICE, "6", HANDLE, deps())).status).toBe(404);
    expect((await handleRaw(ALICE, "05", HANDLE, deps())).status).toBe(404);
    expect((await handleRaw(ALICE, "5", HANDLE, deps({ resolve: async () => ({ connectionId: 5, path: "Notes/secret.md" }) }))).status).toBe(404);
    expect((await handleRaw(ALICE, "5", HANDLE, deps({ resolve: async () => ({ connectionId: 5, path: "Notes/page.html.md" }) }))).status).toBe(404);
    for (const response of [await handleRaw(null, "5", HANDLE, deps()), await handleRaw({ accountId: "mallory" }, "5", HANDLE, deps())]) expect(await response.text()).toBe("");
  });

  it("takes .htm too, in any case, and refuses a page that is too large with the reason", async () => {
    expect((await handleRaw(ALICE, "5", HANDLE, deps({ resolve: async () => ({ connectionId: 5, path: "Notes/PAGE.HTM" }) }))).status).toBe(200);
    const large = await handleRaw(ALICE, "5", HANDLE, deps({ read: async () => ({ ok: false, reason: "too_large" }) }));
    expect(large.status).toBe(413);
    expect(large.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(MAX_PAGE_BYTES).toBe(2 * 1024 * 1024);
  });
});
