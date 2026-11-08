import { isCredentialError } from "../crypto/errors";
import { isProviderError } from "../providers/errors";
import type { Identity } from "../providers/types";
import { type Caller, isRepositoryPath } from "../working/http";
import type { DeleteImageResult, ImageEntry, ImageFailure, UploadResult } from "./images";
import { MAX_IMAGES_PER_UPLOAD, MAX_IMAGE_BYTES } from "./images";
import type { SiteRefusal } from "./posts";

/**
 * The HTTP face of a site's media library (`/api/connections/<id>/images`, RFC 0004): who may call, what they may send, what they are told.
 * Written against `Request` and `Response` and handed the caller, like `src/files/http.ts`, so the rules are tested directly.
 *
 *  - Nobody who is not signed in: 401, before anything is read. A write must come from this instance's own pages (`Origin`).
 *  - An account uses the library of its own connections only: another's is 404, as if it were not there.
 *  - What is sent is the picture's bytes (a multipart form) or the path of one the person was shown, with the blob they were shown. **The name is
 *    never taken from the request**: `fjord-core` makes it (`siteImageName`), and the type is the bytes', never the name's or the browser's.
 *  - A picture is served as the type its first bytes say, `nosniff`, in a sandbox; anything else of the library's folder is an attachment.
 */
export interface ImagesDeps {
  /** The pictures of the caller's site. `found: false` if the connection is not the caller's. */
  list: (accountId: string, id: number) => Promise<{ found: false } | { found: true; result: { ok: true; dir: string; images: ImageEntry[] } | { ok: false; reason: SiteRefusal | ImageFailure } }>;
  /** Add pictures in one commit. */
  upload: (accountId: string, id: number, input: { files: { name: string; bytes: Uint8Array }[]; author: Identity }) => Promise<{ found: false } | { found: true; result: UploadResult | { ok: false; reason: SiteRefusal } }>;
  /** Take one away, held to the blob the person was shown. */
  remove: (accountId: string, id: number, input: { path: string; blob: string; author: Identity }) => Promise<{ found: false } | { found: true; result: DeleteImageResult | { ok: false; reason: SiteRefusal } }>;
  /** The posts that show a picture. */
  uses: (accountId: string, id: number, path: string) => Promise<{ found: false } | { found: true; result: { ok: true; posts: string[]; complete: boolean } | { ok: false; reason: SiteRefusal | ImageFailure } }>;
  /** A picture's bytes, if the path is the library's. */
  read: (accountId: string, id: number, path: string) => Promise<{ found: false } | { found: true; result: { ok: true; bytes: Uint8Array; mime: string | undefined } | { ok: false; reason: "missing" | "too_large" | SiteRefusal | ImageFailure } }>;
  /**
   * How the post at `post` refers to the picture at `image` in its engine's form, or the path of the repository that `reference`, written in that post,
   * refers to (`null` for a URL or a path out of the repository). Nothing is read from the repository.
   */
  reference: (accountId: string, id: number, input: { post: string; image: string } | { post: string; reference: string }) => Promise<{ found: false } | { found: true; result: { ok: true; reference: string } | { ok: true; path: string | null } | { ok: false; reason: SiteRefusal | ImageFailure } }>;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** What one upload may weigh in all: a full batch of 20 would be 200 MB, which this server's memory is not for. */
export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
/** What is served: a picture past the library's own cap can only have come from git, and is not streamed through here. */
const MAX_SERVED_BYTES = 25 * 1024 * 1024;
export { MAX_SERVED_BYTES };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const notFound = () => failure(404, "not_found", "There is no such connection.");

const REFUSALS: Record<SiteRefusal | ImageFailure | "nothing" | "too_many" | "too_large" | "not_an_image" | "gone" | "upstream_changed" | "not_in_library" | "missing", { status: number; message: (detail?: string) => string }> = {
  not_a_site: { status: 422, message: () => "This repository is not a site with one vault, so it has no images." },
  unknown_engine: { status: 422, message: () => "This site's engine is not one this version knows (Astro or Jekyll), so it does not know where its images go." },
  unsupported_site: { status: 422, message: () => "This site's vault cannot be written to from here: its manifest cannot be read, it is encrypted, or its files are not named plainly." },
  nothing: { status: 400, message: () => "Choose at least one image." },
  too_many: { status: 413, message: () => `Add at most ${MAX_IMAGES_PER_UPLOAD} images at a time.` },
  too_large: { status: 413, message: (detail) => `${detail ?? "That image"} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Nothing was added.` },
  not_an_image: { status: 415, message: (detail) => `${detail ?? "That file"} is not a PNG, JPEG, WebP, GIF or AVIF picture. Nothing was added. (SVG is not taken: it can hold script.)` },
  gone: { status: 409, message: () => "That image is no longer in the repository. Nothing was deleted." },
  upstream_changed: { status: 409, message: () => "That image changed in the repository after you looked at it, so it was not deleted. Look at it again." },
  not_in_library: { status: 422, message: () => "That is not an image of this site's library." },
  missing: { status: 404, message: () => "There is no such image." },
  head_moved: { status: 409, message: () => "The repository kept changing while this was being written. Nothing was changed. Try again." },
  read_only: { status: 422, message: () => "That token can read this repository but not write to it. Create the token with the repository permission “Contents: Read and write”, and connect the repository again." },
  bad_token: { status: 422, message: () => "The git host did not accept this repository's token. Connect the repository again with a new one." },
  unavailable: { status: 502, message: () => "Could not reach the git host just now. Nothing was changed. Try again in a moment." },
};

function refused(reason: keyof typeof REFUSALS, detail?: string): Response {
  const refusal = REFUSALS[reason];
  return failure(refusal.status, reason, refusal.message(detail));
}

function fromError(error: unknown): Response {
  if (isCredentialError(error, "no_key")) return failure(503, "not_configured", "This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.");
  if (isProviderError(error, "rate_limited")) return failure(429, "rate_limited", "The git host is limiting requests. Try again in a moment.");
  if (isProviderError(error, "limit_reached")) return failure(409, "limit_reached", error.message);
  console.error(`[fjord] images: unexpected ${error instanceof Error ? error.name : "failure"}`);
  return failure(500, "internal_error", "Something went wrong on our side. Try again.");
}

function who(request: Request, caller: Caller | null, deps: ImagesDeps, id: string, write: boolean): Response | { caller: Caller; number: number } {
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (write && request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  if (!CONNECTION_ID.test(id)) return notFound();
  return { caller, number: Number(id) };
}

/**
 * `GET` lists the pictures, or with `?uses=<path>` the posts that show one; `POST` adds pictures, a multipart form of `files`; `DELETE` takes
 * one away, `{ path, blob }`.
 */
export async function handleImages(request: Request, caller: Caller | null, deps: ImagesDeps, id: string): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "POST" && method !== "DELETE") return failure(405, "method_not_allowed", "That method is not allowed here.");
  const gate = who(request, caller, deps, id, method !== "GET");
  if (gate instanceof Response) return gate;
  const { number } = gate;
  const author = { name: gate.caller.name, email: gate.caller.email };
  try {
    if (method === "GET") {
      const uses = new URL(request.url).searchParams.get("uses");
      if (uses !== null) {
        if (!isRepositoryPath(uses)) return failure(400, "invalid_request", "Say which image, by its path in the repository.");
        const outcome = await deps.uses(gate.caller.accountId, number, uses);
        if (!outcome.found) return notFound();
        return outcome.result.ok ? json(200, { posts: outcome.result.posts, complete: outcome.result.complete }) : refused(outcome.result.reason);
      }
      const outcome = await deps.list(gate.caller.accountId, number);
      if (!outcome.found) return notFound();
      return outcome.result.ok ? json(200, { dir: outcome.result.dir, images: outcome.result.images }) : refused(outcome.result.reason);
    }

    if (method === "POST") {
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return failure(400, "invalid_request", "Send the images as a form.");
      const length = Number(request.headers.get("content-length"));
      if (!Number.isFinite(length) || length <= 0) return failure(411, "length_required", "Say how large the upload is.");
      if (length > MAX_UPLOAD_BYTES) return refused("too_large");
      const form = await request.formData().catch(() => undefined);
      if (!form) return failure(400, "invalid_request", "Send the images as a form.");
      const entries = form.getAll("files");
      const files: { name: string; bytes: Uint8Array }[] = [];
      for (const entry of entries) {
        if (typeof entry === "string") return failure(400, "invalid_request", "Send each image as a file.");
        if (files.length >= MAX_IMAGES_PER_UPLOAD) return refused("too_many");
        if (entry.size > MAX_IMAGE_BYTES) return refused("too_large", entry.name);
        files.push({ name: entry.name, bytes: new Uint8Array(await entry.arrayBuffer()) });
      }
      const outcome = await deps.upload(gate.caller.accountId, number, { files, author });
      if (!outcome.found) return notFound();
      if (outcome.result.ok) return json(201, { commit: outcome.result.commit, images: outcome.result.images });
      return refused(outcome.result.reason, "detail" in outcome.result ? outcome.result.detail : undefined);
    }

    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    let body: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = text.length <= 4_000 ? JSON.parse(text) : undefined;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");
    const { path, blob } = body;
    if (!isRepositoryPath(path)) return failure(400, "invalid_request", "Say which image, by its path in the repository.");
    if (typeof blob !== "string" || !OBJECT_ID.test(blob)) return failure(400, "invalid_request", "Send the blob id of the image you were shown.");
    const outcome = await deps.remove(gate.caller.accountId, number, { path, blob, author });
    if (!outcome.found) return notFound();
    return outcome.result.ok ? json(200, { commit: outcome.result.commit }) : refused(outcome.result.reason);
  } catch (error) {
    return fromError(error);
  }
}

/** The headers every picture goes out under: a sandbox, no sniffing, nothing a cache others share may keep. */
export const IMAGE_POLICY = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'";

/**
 * `GET ?path=` is one picture's bytes, as the type its first bytes say (`image/png` and the rest). Bytes that are not a picture of a type the
 * library takes (an SVG in the vault, a document named `.png`) are `application/octet-stream` and an attachment: never shown, never run.
 */
export async function handleImageFile(request: Request, caller: Caller | null, deps: ImagesDeps, id: string): Promise<Response> {
  if (request.method !== "GET") return failure(405, "method_not_allowed", "That method is not allowed here.");
  const gate = who(request, caller, deps, id, false);
  if (gate instanceof Response) return gate;
  const path = new URL(request.url).searchParams.get("path");
  if (!isRepositoryPath(path)) return failure(400, "invalid_request", "Say which image, by its path in the repository.");
  try {
    const outcome = await deps.read(gate.caller.accountId, gate.number, path);
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (!result.ok) return result.reason === "too_large" ? failure(413, "too_large", "That file is larger than 25 MB, which is more than is served. Fetch it with git.") : refused(result.reason);
    const shown = result.mime !== undefined;
    return new Response(result.bytes as BodyInit, {
      status: 200,
      headers: {
        "content-type": result.mime ?? "application/octet-stream",
        "content-disposition": shown ? "inline" : 'attachment; filename="file"',
        "content-security-policy": IMAGE_POLICY,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return fromError(error);
  }
}

/**
 * `GET ?post=<path>&image=<path>` is the reference a post makes to a picture, in its engine's form (`{ reference }`); `GET ?post=<path>&reference=<text>`
 * is the path of the repository a reference in that post means (`{ path }`, null for a URL), which is how an editor shows a relative picture. Both are the
 * format module's (`siteImageRef`, `siteImageTarget`): the editors know no engine.
 */
export async function handleImageReference(request: Request, caller: Caller | null, deps: ImagesDeps, id: string): Promise<Response> {
  if (request.method !== "GET") return failure(405, "method_not_allowed", "That method is not allowed here.");
  const gate = who(request, caller, deps, id, false);
  if (gate instanceof Response) return gate;
  const query = new URL(request.url).searchParams;
  const post = query.get("post");
  const image = query.get("image");
  const reference = query.get("reference");
  if (!isRepositoryPath(post)) return failure(400, "invalid_request", "Say which post, by its path in the repository.");
  let input: { post: string; image: string } | { post: string; reference: string };
  if (image !== null && reference === null && isRepositoryPath(image)) input = { post, image };
  else if (reference !== null && image === null && reference.length > 0 && reference.length <= 1_000 && reference.isWellFormed()) input = { post, reference };
  else return failure(400, "invalid_request", "Give either the image's path or the reference to resolve.");
  try {
    const outcome = await deps.reference(gate.caller.accountId, gate.number, input);
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (!result.ok) return refused(result.reason);
    return json(200, "reference" in result ? { reference: result.reference } : { path: result.path });
  } catch (error) {
    return fromError(error);
  }
}
