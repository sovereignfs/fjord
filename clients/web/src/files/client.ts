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
