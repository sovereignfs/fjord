/**
 * The browser's side of publishing a Doc as a page (ROADMAP 3h.1): the requests the Sharing panel makes to `/api/connections/<id>/publication`, and what each
 * answer means to it. The `*From` functions are the meaning, kept apart from `fetch` so that they are tested without a browser. The address is in the answer to
 * publishing and nowhere else: only a hash of it is kept, so it is handed on once.
 */
/** Who may comment on a page: nothing but `off` is built. */
export type CommentSetting = "off" | "anyone" | "users";
export type Status = { ok: true; published: boolean; publishedAt: number | null; passwordProtected: boolean; comments: CommentSetting } | { ok: false; message: string };
/** How a page is open, as it is asked for: a password to set (`null` takes it off, absent keeps it) and who may comment. */
export interface Settings {
  password?: string | null;
  comments?: CommentSetting;
}
export type Published = { ok: true; url: string } | { ok: false; message: string };
export type Ended = { ok: true } | { ok: false; message: string };

type Body = { error?: { message?: string } } & Record<string, unknown>;

const failure = (status: number, body: Body | undefined, what: string): { ok: false; message: string } =>
  status === 401 ? { ok: false, message: `You are signed out, so ${what}. Sign in again, then try again.` } : { ok: false, message: body?.error?.message ?? `Could not ${what} just now. Nothing was changed. Try again in a moment.` };

export function statusFrom(status: number, body: Body | undefined): Status {
  if (status === 200 && typeof body?.published === "boolean") {
    const comments = body.comments === "anyone" || body.comments === "users" ? body.comments : "off";
    return { ok: true, published: body.published, publishedAt: typeof body.publishedAt === "number" ? body.publishedAt : null, passwordProtected: body.passwordProtected === true, comments };
  }
  return failure(status, body, "nothing was changed");
}

export function publishedFrom(status: number, body: Body | undefined): Published {
  if (status === 201 && typeof body?.url === "string") return { ok: true, url: body.url };
  return failure(status, body, "the page was not published");
}

export function endedFrom(status: number, body: Body | undefined): Ended {
  if (status === 200 && body?.unpublished === true) return { ok: true };
  if (status === 200) return { ok: true };
  return failure(status, body, "the page was not unpublished");
}

export function updatedFrom(status: number, body: Body | undefined): Ended {
  if (status === 200 && body?.updated === true) return { ok: true };
  return failure(status, body, "nothing was changed");
}

async function call(connectionId: number, method: "GET" | "POST" | "PATCH" | "DELETE", docId: string, settings: Settings = {}): Promise<{ status: number; body: Body | undefined } | undefined> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/publication${method === "GET" ? `?doc=${encodeURIComponent(docId)}` : ""}`, {
      method,
      ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: docId, ...settings }) }),
      credentials: "same-origin",
    });
    return { status: response.status, body: (await response.json().catch(() => undefined)) as Body | undefined };
  } catch {
    return undefined;
  }
}

const offline = (what: string) => ({ ok: false as const, message: `Could not reach this server, so ${what}. Try again in a moment.` });

export async function getStatus(connectionId: number, docId: string): Promise<Status> {
  const answer = await call(connectionId, "GET", docId);
  return answer ? statusFrom(answer.status, answer.body) : offline("nothing was changed");
}

export async function publish(connectionId: number, docId: string, settings: Settings = {}): Promise<Published> {
  const answer = await call(connectionId, "POST", docId, settings);
  return answer ? publishedFrom(answer.status, answer.body) : offline("the page was not published");
}

/** Change how a published page is open, keeping its address. */
export async function updatePublication(connectionId: number, docId: string, settings: Settings): Promise<Ended> {
  const answer = await call(connectionId, "PATCH", docId, settings);
  return answer ? updatedFrom(answer.status, answer.body) : offline("nothing was changed");
}

export async function unpublish(connectionId: number, docId: string): Promise<Ended> {
  const answer = await call(connectionId, "DELETE", docId);
  return answer ? endedFrom(answer.status, answer.body) : offline("the page was not unpublished");
}

// --- A copy of a file of an encrypted vault (ROADMAP 3h.2) ---------------------------------------------------------------------

async function callCopy(connectionId: number, method: "GET" | "POST" | "DELETE", body: Record<string, unknown>): Promise<{ status: number; body: Body | undefined } | undefined> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/publication/copy${method === "GET" ? `?path=${encodeURIComponent(String(body.path))}` : ""}`, {
      method,
      ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      credentials: "same-origin",
    });
    return { status: response.status, body: (await response.json().catch(() => undefined)) as Body | undefined };
  } catch {
    return undefined;
  }
}

/** Hand the server a plaintext copy of an encrypted file to publish, after the person said they understand what that is. */
export async function publishCopy(connectionId: number, input: { path: string; title: string; body: string }): Promise<Published> {
  const answer = await callCopy(connectionId, "POST", { ...input, understood: true });
  return answer ? publishedFrom(answer.status, answer.body) : offline("the page was not published");
}

export async function unpublishCopy(connectionId: number, path: string): Promise<Ended> {
  const answer = await callCopy(connectionId, "DELETE", { path });
  return answer ? endedFrom(answer.status, answer.body) : offline("the page was not unpublished");
}

export async function getCopyStatus(connectionId: number, path: string): Promise<Status> {
  const answer = await callCopy(connectionId, "GET", { path });
  return answer ? statusFrom(answer.status, answer.body) : offline("nothing was changed");
}

/** The title and Markdown to hand over for a decrypted file: its header taken off, its title from the header, else its first heading, else its name. */
export function copyOf(text: string, name: string): { title: string; body: string } {
  const header = /^---\r?\n([\s\S]*?\r?\n)?---\r?\n/.exec(text);
  const body = header ? text.slice(header[0].length) : text;
  const titled = header && /^title:[ \t]*(.+)$/m.exec(header[1] ?? "");
  const heading = /^#[ \t]+(.+)$/m.exec(body);
  const stem = name.replace(/\.md$/i, "");
  const raw = (titled ? titled[1] : heading ? heading[1] : stem) ?? stem;
  const title = raw.trim().replace(/^["']|["']$/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200).trim();
  return { title: title === "" ? stem.slice(0, 200).trim() || "Untitled" : title, body };
}
