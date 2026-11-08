import type { ImageEntry } from "./images";

/**
 * The browser's side of the media library (RFC 0004): requests to `/api/connections/<id>/images`, each answered with data or with the words to
 * show. Nothing here decides what a picture may be: the server does, and says why not.
 */
export type Listed = { ok: true; dir: string; images: ImageEntry[] } | { ok: false; message: string };
export type Uploaded = { ok: true; images: { name: string; path: string; status: "added" | "exists" }[] } | { ok: false; message: string };
export type Removed = { ok: true } | { ok: false; message: string };

const OFFLINE = "Could not reach this server. Try again in a moment.";

async function messageOf(response: Response): Promise<string> {
  const parsed = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
  return parsed?.error?.message ?? "That did not work. Try again.";
}

const base = (connectionId: number) => `/api/connections/${connectionId}/images`;

/** Where a picture is shown from: the server's own route, which serves it as the type its bytes are. */
export const imageUrl = (connectionId: number, path: string): string => `${base(connectionId)}/file?path=${encodeURIComponent(path)}`;

export async function fetchImages(connectionId: number): Promise<Listed> {
  try {
    const response = await fetch(base(connectionId), { credentials: "same-origin" });
    if (!response.ok) return { ok: false, message: await messageOf(response) };
    const parsed = (await response.json()) as { dir: string; images: ImageEntry[] };
    return { ok: true, dir: parsed.dir, images: parsed.images };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}

export async function sendImages(connectionId: number, files: File[]): Promise<Uploaded> {
  try {
    const body = new FormData();
    for (const file of files) body.append("files", file, file.name);
    const response = await fetch(base(connectionId), { method: "POST", body, credentials: "same-origin" });
    if (!response.ok) return { ok: false, message: await messageOf(response) };
    const parsed = (await response.json()) as { images: { name: string; path: string; status: "added" | "exists" }[] };
    return { ok: true, images: parsed.images };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}

export async function removeImage(connectionId: number, path: string, blob: string): Promise<Removed> {
  try {
    const response = await fetch(base(connectionId), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, blob }), credentials: "same-origin" });
    return response.ok ? { ok: true } : { ok: false, message: await messageOf(response) };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}

/** The posts that show a picture, by their paths, for the warning before it is deleted. */
export async function fetchImageUses(connectionId: number, path: string): Promise<{ ok: true; posts: string[]; complete: boolean } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${base(connectionId)}?uses=${encodeURIComponent(path)}`, { credentials: "same-origin" });
    if (!response.ok) return { ok: false, message: await messageOf(response) };
    const parsed = (await response.json()) as { posts: string[]; complete: boolean };
    return { ok: true, posts: parsed.posts, complete: parsed.complete };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}

/** How the post at `post` refers to the picture at `image`, in the form its site's engine reads. */
export async function fetchReference(connectionId: number, post: string, image: string): Promise<{ ok: true; reference: string } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${base(connectionId)}/reference?post=${encodeURIComponent(post)}&image=${encodeURIComponent(image)}`, { credentials: "same-origin" });
    if (!response.ok) return { ok: false, message: await messageOf(response) };
    return { ok: true, reference: ((await response.json()) as { reference: string }).reference };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}

/** Where to show a picture a post refers to as `reference`: this server's route for it, or the reference itself when it is a URL or not the library's. */
export async function fetchDisplayUrl(connectionId: number, post: string, reference: string): Promise<string> {
  try {
    const response = await fetch(`${base(connectionId)}/reference?post=${encodeURIComponent(post)}&reference=${encodeURIComponent(reference)}`, { credentials: "same-origin" });
    if (!response.ok) return reference;
    const { path } = (await response.json()) as { path: string | null };
    return path === null ? reference : imageUrl(connectionId, path);
  } catch {
    return reference;
  }
}
