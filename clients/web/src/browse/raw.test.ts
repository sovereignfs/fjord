import { describe, expect, it } from "vitest";
import { FILE_POLICY, MAX_FILE_BYTES, MAX_PAGE_BYTES, RAW_POLICY, type RawDeps, attachmentName, handleRaw, handleRawFile, isPicture } from "./raw";

/** Who may be served a repository's HTML page, and what it is served with (workstream 0003, leg 5): the rules, with a stand-in for the repository. */
const HANDLE = "0123456789abcdef";
const PAGE = new TextEncoder().encode("<ul><li>a</li></ul><script>1</script>");
const REPO = "k3x9m2qa";
const ALICE = { accountId: "alice" };

const deps = (over: Partial<RawDeps> = {}): RawDeps => ({
  connection: async (accountId, publicId) => (accountId === "alice" && publicId === REPO ? 5 : undefined),
  resolve: async (handle) => (handle === HANDLE ? { connectionId: 5, path: "Notes/checklist.html" } : undefined),
  read: async (accountId, connectionId) => (accountId === "alice" && connectionId === 5 ? { ok: true, bytes: PAGE } : { ok: false, reason: "missing" }),
  ...over,
});

describe("serving a page", () => {
  it("gives the owner the file, as HTML in a sandbox with no origin of this app's, no network and no framing but by this origin", async () => {
    const response = await handleRaw(ALICE, REPO, HANDLE, deps());
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
    expect((await handleRaw(null, REPO, HANDLE, deps())).status).toBe(404);
    expect((await handleRaw({ accountId: "mallory" }, REPO, HANDLE, deps())).status).toBe(404);
    expect((await handleRaw(ALICE, REPO, "fedcba9876543210", deps())).status).toBe(404);
    expect((await handleRaw(ALICE, "z3x9m2qa", HANDLE, deps())).status).toBe(404);
    expect((await handleRaw(ALICE, "5", HANDLE, deps())).status).toBe(404);
    expect((await handleRaw(ALICE, REPO, HANDLE, deps({ resolve: async () => ({ connectionId: 5, path: "Notes/secret.md" }) }))).status).toBe(404);
    expect((await handleRaw(ALICE, REPO, HANDLE, deps({ resolve: async () => ({ connectionId: 5, path: "Notes/page.html.md" }) }))).status).toBe(404);
    for (const response of [await handleRaw(null, REPO, HANDLE, deps()), await handleRaw({ accountId: "mallory" }, REPO, HANDLE, deps())]) expect(await response.text()).toBe("");
  });

  it("takes .htm too, in any case, and refuses a page that is too large with the reason", async () => {
    expect((await handleRaw(ALICE, REPO, HANDLE, deps({ resolve: async () => ({ connectionId: 5, path: "Notes/PAGE.HTM" }) }))).status).toBe(200);
    const large = await handleRaw(ALICE, REPO, HANDLE, deps({ read: async () => ({ ok: false, reason: "too_large" }) }));
    expect(large.status).toBe(413);
    expect(large.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(MAX_PAGE_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe("serving any other file", () => {
  const at = (path: string) => deps({ resolve: async (handle) => (handle === HANDLE ? { connectionId: 5, path } : undefined) });

  it("shows only a raster picture, under the type its name says, and nothing it may run", async () => {
    const response = await handleRawFile(ALICE, REPO, HANDLE, at("Notes/photo.PNG"), { download: false });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toMatch(/^inline; /);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const policy = response.headers.get("content-security-policy")!;
    expect(policy).toBe(FILE_POLICY);
    expect(policy).toContain("sandbox");
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
  });

  it("gives everything else as an attachment with no type of its own, an SVG and HTML above all", async () => {
    for (const path of ["Notes/drawing.svg", "Notes/page.html", "Notes/report.pdf", "Notes/data.csv", "Notes/noextension", "Notes/photo.png.exe"]) {
      const response = await handleRawFile(ALICE, REPO, HANDLE, at(path), { download: false });
      expect(response.headers.get("content-type"), path).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition"), path).toMatch(/^attachment; /);
    }
  });

  it("gives a picture as an attachment when it is asked to be saved", async () => {
    const response = await handleRawFile(ALICE, REPO, HANDLE, at("Notes/photo.png"), { download: true });
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; /);
  });

  it("is a 404 that says nothing for anyone but the owner, and for a handle of another repository", async () => {
    expect((await handleRawFile(null, REPO, HANDLE, at("Notes/a.png"), { download: false })).status).toBe(404);
    expect((await handleRawFile({ accountId: "bob" }, REPO, HANDLE, at("Notes/a.png"), { download: false })).status).toBe(404);
    expect((await handleRawFile(ALICE, "not-a-repo", HANDLE, at("Notes/a.png"), { download: false })).status).toBe(404);
    expect((await handleRawFile(ALICE, REPO, "other", at("Notes/a.png"), { download: false })).status).toBe(404);
    const elsewhere = deps({ resolve: async () => ({ connectionId: 9, path: "Notes/a.png" }) });
    expect((await handleRawFile(ALICE, REPO, HANDLE, elsewhere, { download: false })).status).toBe(404);
  });

  it("asks for no more than it will serve, and says so when a file is larger", async () => {
    let asked: number | undefined;
    await handleRawFile(ALICE, REPO, HANDLE, { ...at("Notes/a.png"), read: async (_a, _c, _p, maxBytes) => ((asked = maxBytes), { ok: true, bytes: PAGE }) }, { download: false });
    expect(asked).toBe(MAX_FILE_BYTES);
    const large = await handleRawFile(ALICE, REPO, HANDLE, { ...at("Notes/a.png"), read: async () => ({ ok: false, reason: "too_large" }) }, { download: false });
    expect(large.status).toBe(413);
  });

  it("knows a picture by its name, and an SVG is not one", () => {
    for (const name of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.avif"]) expect(isPicture(name), name).toBe(true);
    for (const name of ["a.svg", "a.pdf", "png", "a.png.html"]) expect(isPicture(name), name).toBe(false);
  });

  it("writes a name so that nothing in it can end the header", () => {
    expect(attachmentName("plain.png")).toBe(`filename="plain.png"; filename*=UTF-8''plain.png`);
    const odd = attachmentName('a"; x=y\r\nset-cookie: b.png');
    expect(odd).not.toMatch(/[\r\n]/);
    expect(odd.startsWith('filename="a__ x_y__set-cookie_ b.png"')).toBe(true);
    expect(attachmentName(".env")).toMatch(/^filename="_env"/);
    expect(attachmentName("ünï.png")).toContain("filename*=UTF-8''%C3%BCn%C3%AF.png");
  });
});
