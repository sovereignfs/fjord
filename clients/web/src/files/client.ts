/**
 * The browser's side of `/api/connections/<id>/files`: what a person's "New note" or "New document" sends, and what each
 * answer means to the page. `createFrom` is the meaning, kept apart from `fetch` so it is tested without a browser.
 */
export type CreateAttempt = { ok: true; path: string } | { ok: false; message: string };

export function createFrom(status: number, body: { path?: string; error?: { message?: string } } | undefined): CreateAttempt {
  if (status === 201 && typeof body?.path === "string") return { ok: true, path: body.path };
  if (status === 401) return { ok: false, message: "You are signed out, so nothing was made. Sign in again, then try again." };
  return { ok: false, message: body?.error?.message ?? "Could not make that just now. Nothing was made. Try again in a moment." };
}

/** Make a note or a document in a folder of a vault. The writer's own date and time goes with it, for a note with no title. */
export async function sendCreate(connectionId: number, input: { vault: string; folder: string; kind: "note" | "document"; title: string }, now: Date = new Date()): Promise<CreateAttempt> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        localMinute: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours(), minute: now.getMinutes() },
      }),
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as { path?: string; error?: { message?: string } } | undefined;
    return createFrom(response.status, parsed);
  } catch {
    return { ok: false, message: "Could not reach this server, so nothing was made. Try again in a moment." };
  }
}

// --- Deleting and putting back (ROADMAP 1b.12) ---------------------------------------------------------------------

export type DeleteAttempt =
  | { ok: true; deletions: number[]; files: number }
  /** `lookAgain` is for a refusal that means the page is out of date: it should be read again. */
  | { ok: false; message: string; lookAgain: boolean };

const DELETE_LOOK_AGAIN = new Set(["gone", "upstream_changed", "folder_changed"]);

export function deleteFrom(status: number, body: { commit?: string; deletions?: number[]; files?: number; error?: { code?: string; message?: string } } | undefined): DeleteAttempt {
  if (status === 200 && Array.isArray(body?.deletions) && typeof body?.files === "number") return { ok: true, deletions: body.deletions, files: body.files };
  if (status === 401) return { ok: false, lookAgain: false, message: "You are signed out, so nothing was deleted. Sign in again, then try again." };
  const code = body?.error?.code;
  return { ok: false, lookAgain: code !== undefined && DELETE_LOOK_AGAIN.has(code), message: body?.error?.message ?? "Could not delete that just now. Nothing was deleted. Try again in a moment." };
}

export type DeleteTarget = { type: "file"; path: string; blob: string } | { type: "folder"; path: string; files: number };

/** Delete a note, a document or a folder. What is sent is the place and what the person was shown. */
export async function sendDelete(connectionId: number, vault: string, target: DeleteTarget): Promise<DeleteAttempt> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/files/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault, ...target }),
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as Parameters<typeof deleteFrom>[1];
    return deleteFrom(response.status, parsed);
  } catch {
    return { ok: false, lookAgain: false, message: "Could not reach this server, so nothing was deleted. Try again in a moment." };
  }
}

export type RestoreAttempt = { ok: true; paths: string[]; commit: string } | { ok: false; message: string; taken: string[] };

export function restoreFrom(status: number, body: { paths?: string[]; commit?: string; error?: { message?: string; taken?: string[] } } | undefined): RestoreAttempt {
  if (status === 200 && Array.isArray(body?.paths) && typeof body?.commit === "string") return { ok: true, paths: body.paths, commit: body.commit };
  if (status === 401) return { ok: false, taken: [], message: "You are signed out, so nothing was put back. Sign in again, then try again." };
  return { ok: false, taken: body?.error?.taken ?? [], message: body?.error?.message ?? "Could not put that back just now. Nothing was changed. Try again in a moment." };
}

/** Put back deletions by their numbers, where they were or, for one, at `path`. */
export async function sendRestore(connectionId: number, ids: number[], path?: string): Promise<RestoreAttempt> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/files/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, ...(path === undefined ? {} : { path }) }),
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as Parameters<typeof restoreFrom>[1];
    return restoreFrom(response.status, parsed);
  } catch {
    return { ok: false, taken: [], message: "Could not reach this server, so nothing was put back. Try again in a moment." };
  }
}
