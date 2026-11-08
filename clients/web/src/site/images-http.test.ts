import { describe, expect, it, vi } from "vitest";
import { type ImagesDeps, handleImageFile, handleImageReference, handleImages } from "./images-http";

/** The media library's HTTP rules (RFC 0004): who may call, from where, what is accepted, and how a picture is served. */
const ORIGIN = "https://fjord.example";
const CALLER = { accountId: "a1", name: "Alice", email: "alice@example.com" };
const BLOB = "a".repeat(40);

function deps(over: Partial<ImagesDeps> = {}): ImagesDeps {
  return {
    origin: ORIGIN,
    list: vi.fn(async () => ({ found: true as const, result: { ok: true as const, dir: "content/images", images: [{ path: "content/images/a.png", name: "a.png", size: 3, blob: BLOB }] } })),
    upload: vi.fn(async () => ({ found: true as const, result: { ok: true as const, commit: "c1", images: [{ name: "a.png", path: "content/images/a.png", status: "added" as const }] } })),
    remove: vi.fn(async () => ({ found: true as const, result: { ok: true as const, commit: "c2" } })),
    uses: vi.fn(async () => ({ found: true as const, result: { ok: true as const, posts: ["content/posts/one.md"], complete: true } })),
    read: vi.fn(async () => ({ found: true as const, result: { ok: true as const, bytes: new Uint8Array([1, 2, 3]), mime: "image/png" as string | undefined } })),
    reference: vi.fn(async (_a: string, _i: number, input: { post: string; image: string } | { post: string; reference: string }) => ({ found: true as const, result: "image" in input ? { ok: true as const, reference: "../images/a.png" } : { ok: true as const, path: "content/images/a.png" as string | null } })),
    ...over,
  };
}

const url = "https://fjord.example/api/connections/1/images";
const form = (files: { name: string; data: Uint8Array }[]) => {
  const body = new FormData();
  for (const file of files) body.append("files", new File([file.data as BlobPart], file.name, { type: "image/png" }));
  return body;
};
/** A form as a browser sends it: the boundary in its type, and its length (`new Request` with a form body gives neither). */
const upload = async (body: FormData, headers: Record<string, string> = { origin: ORIGIN }) => {
  const encoded = new Response(body);
  const bytes = await encoded.arrayBuffer();
  return new Request(url, { method: "POST", body: bytes, headers: { ...headers, "content-type": encoded.headers.get("content-type") as string, "content-length": String(bytes.byteLength) } });
};
const del = (body: unknown, origin: string | null = ORIGIN) => new Request(url, { method: "DELETE", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(origin ? { origin } : {}) } });

describe("the library's HTTP rules", () => {
  it("lets nobody in who is not signed in, before anything is read", async () => {
    const d = deps();
    expect((await handleImages(new Request(url), null, d, "1")).status).toBe(401);
    expect((await handleImages(await upload(form([])), null, d, "1")).status).toBe(401);
    expect((await handleImageFile(new Request(`${url}/file?path=content/images/a.png`), null, d, "1")).status).toBe(401);
    expect(d.list).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("takes a write only from this site's own pages", async () => {
    const d = deps();
    const png = new Uint8Array([0x89, 0x50]);
    expect((await handleImages(await upload(form([{ name: "a.png", data: png }]), {}), CALLER, d, "1")).status).toBe(403);
    expect((await handleImages(await upload(form([{ name: "a.png", data: png }]), { origin: "https://evil.example" }), CALLER, d, "1")).status).toBe(403);
    expect((await handleImages(del({ path: "content/images/a.png", blob: BLOB }, null), CALLER, d, "1")).status).toBe(403);
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.remove).not.toHaveBeenCalled();
  });

  it("says nothing of a connection that is not the caller's", async () => {
    const gone = deps({ list: async () => ({ found: false }), upload: async () => ({ found: false }), remove: async () => ({ found: false }), uses: async () => ({ found: false }), read: async () => ({ found: false }) });
    expect((await handleImages(new Request(url), CALLER, gone, "1")).status).toBe(404);
    expect((await handleImages(await upload(form([{ name: "a.png", data: new Uint8Array([1]) }])), CALLER, gone, "1")).status).toBe(404);
    expect((await handleImages(del({ path: "content/images/a.png", blob: BLOB }), CALLER, gone, "1")).status).toBe(404);
    expect((await handleImages(new Request(`${url}?uses=content/images/a.png`), CALLER, gone, "1")).status).toBe(404);
    expect((await handleImageFile(new Request(`${url}/file?path=content/images/a.png`), CALLER, gone, "1")).status).toBe(404);
    expect((await handleImages(new Request(url), CALLER, deps(), "../1")).status).toBe(404);
  });

  it("lists the pictures and the posts that show one", async () => {
    const d = deps();
    const listed = await handleImages(new Request(url), CALLER, d, "1");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ dir: "content/images", images: [{ name: "a.png", blob: BLOB }] });
    const used = await handleImages(new Request(`${url}?uses=content/images/a.png`), CALLER, d, "1");
    expect(await used.json()).toEqual({ posts: ["content/posts/one.md"], complete: true });
    expect((await handleImages(new Request(`${url}?uses=../x.png`), CALLER, d, "1")).status).toBe(400);
  });

  it("adds pictures from a form, handing over their bytes and never trusting a name", async () => {
    const d = deps();
    const made = await handleImages(await upload(form([{ name: "../../evil.png", data: new Uint8Array([9, 9]) }])), CALLER, d, "1");
    expect(made.status).toBe(201);
    expect(await made.json()).toMatchObject({ commit: "c1", images: [{ status: "added" }] });
    expect(d.upload).toHaveBeenCalledWith("a1", 1, { files: [{ name: "../../evil.png", bytes: new Uint8Array([9, 9]) }], author: { name: "Alice", email: "alice@example.com" } });
  });

  it("refuses an upload that is not a form, has no length, is too large, or has too many", async () => {
    const d = deps();
    expect((await handleImages(new Request(url, { method: "POST", body: "{}", headers: { origin: ORIGIN, "content-type": "application/json" } }), CALLER, d, "1")).status).toBe(415);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    expect((await handleImages(await upload(form([{ name: "big.png", data: big }])), CALLER, d, "1")).status).toBe(413);
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `${i}.png`, data: new Uint8Array([i]) }));
    expect((await handleImages(await upload(form(many)), CALLER, d, "1")).status).toBe(413);
    const text = new FormData();
    text.append("files", "not a file");
    expect((await handleImages(await upload(text), CALLER, d, "1")).status).toBe(400);
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("tells what the library refused, in the words of the refusal", async () => {
    const svg = deps({ upload: async () => ({ found: true, result: { ok: false, reason: "not_an_image", detail: "x.svg" } }) });
    const response = await handleImages(await upload(form([{ name: "x.svg", data: new Uint8Array([60]) }])), CALLER, svg, "1");
    expect(response.status).toBe(415);
    expect(JSON.stringify(await response.json())).toContain("x.svg");
    const notSite = deps({ list: async () => ({ found: true, result: { ok: false, reason: "not_a_site" } }) });
    expect((await handleImages(new Request(url), CALLER, notSite, "1")).status).toBe(422);
  });

  it("deletes the picture it was shown, and asks for nothing else", async () => {
    const d = deps();
    expect((await handleImages(del({ path: "content/images/a.png", blob: BLOB }), CALLER, d, "1")).status).toBe(200);
    expect(d.remove).toHaveBeenCalledWith("a1", 1, { path: "content/images/a.png", blob: BLOB, author: { name: "Alice", email: "alice@example.com" } });
    for (const body of [{}, { path: "content/images/a.png" }, { path: "content/images/a.png", blob: "nope" }, { path: "../a.png", blob: BLOB }, { path: 1, blob: BLOB }]) {
      expect((await handleImages(del(body), CALLER, d, "1")).status).toBe(400);
    }
    expect(d.remove).toHaveBeenCalledTimes(1);
  });

  it("serves a picture as the type its bytes are, in a sandbox, never sniffed", async () => {
    const response = await handleImageFile(new Request(`${url}/file?path=content/images/a.png`), CALLER, deps(), "1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("serves bytes that are not a picture of a type the library takes as an attachment, whatever the name", async () => {
    const html = deps({ read: async () => ({ found: true, result: { ok: true, bytes: new TextEncoder().encode("<script>alert(1)</script>"), mime: undefined } }) });
    const response = await handleImageFile(new Request(`${url}/file?path=content/images/a.png`), CALLER, html, "1");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
    expect((await handleImageFile(new Request(`${url}/file`), CALLER, deps(), "1")).status).toBe(400);
    expect((await handleImageFile(new Request(`${url}/file?path=a.png`, { method: "POST" }), CALLER, deps(), "1")).status).toBe(405);
  });

  it("says how a post refers to a picture, and what a reference means, for a person who may read the site", async () => {
    const d = deps();
    const ref = `${url}/reference?post=content/posts/p.md`;
    expect(await (await handleImageReference(new Request(`${ref}&image=content/images/a.png`), CALLER, d, "1")).json()).toEqual({ reference: "../images/a.png" });
    expect(await (await handleImageReference(new Request(`${ref}&reference=../images/a.png`), CALLER, d, "1")).json()).toEqual({ path: "content/images/a.png" });
    expect((await handleImageReference(new Request(`${ref}&image=a.png&reference=b`), CALLER, d, "1")).status).toBe(400);
    expect((await handleImageReference(new Request(`${url}/reference?image=a.png`), CALLER, d, "1")).status).toBe(400);
    expect((await handleImageReference(new Request(`${ref}&image=../a.png`), CALLER, d, "1")).status).toBe(400);
    expect((await handleImageReference(new Request(`${ref}&image=a.png`), null, d, "1")).status).toBe(401);
    const gone = deps({ reference: async () => ({ found: false }) });
    expect((await handleImageReference(new Request(`${ref}&image=a.png`), CALLER, gone, "1")).status).toBe(404);
  });
});
