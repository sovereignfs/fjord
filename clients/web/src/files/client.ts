/**
 * The browser's side of `/api/connections/<id>/files`: what a person's "New document" sends, and what each
 * answer means to the page. `createFrom` is the meaning, kept apart from `fetch` so it is tested without a browser.
 */
export type CreateAttempt = { ok: true; path: string } | { ok: false; message: string };

export function createFrom(status: number, body: { path?: string; error?: { message?: string } } | undefined): CreateAttempt {
  if (status === 201 && typeof body?.path === "string") return { ok: true, path: body.path };
  if (status === 401) return { ok: false, message: "You are signed out, so nothing was made. Sign in again, then try again." };
  return { ok: false, message: body?.error?.message ?? "Could not make that just now. Nothing was made. Try again in a moment." };
}

/** Make a document in a folder of a vault. The writer's own date and time goes with it, for one with no title. */
export async function sendCreate(connectionId: number, input: { vault: string; folder: string; title: string }, now: Date = new Date()): Promise<CreateAttempt> {
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

/** Make a document in an encrypted vault (ROADMAP 2b.4) from the ciphertext this browser made. `title` is sent only for a vault that names its files by their names. */
export async function sendCreateEncrypted(
  connectionId: number,
  input: { vault: string; folder: string; title: string; ciphertext: string },
  now: Date = new Date(),
): Promise<CreateAttempt> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/files/encrypted`, {
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

/** What giving a Doc an identifier answers, in words for the page (ROADMAP 3e.3). */
export type IdentifyAttempt = { ok: true; docId: string } | { ok: false; message: string };

export function identifyFrom(status: number, body: { docId?: string; error?: { message?: string } } | undefined): IdentifyAttempt {
  if (status === 200 && typeof body?.docId === "string") return { ok: true, docId: body.docId };
  if (status === 401) return { ok: false, message: "You are signed out, so nothing was changed. Sign in again, then try again." };
  return { ok: false, message: body?.error?.message ?? "Could not give the file an identifier just now. Nothing was changed. Try again in a moment." };
}

/** Give a Doc an identifier, once the person agreed: `blob` is the version they looked at. */
export async function sendIdentify(connectionId: number, input: { path: string; blob: string }): Promise<IdentifyAttempt> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/files/identify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), credentials: "same-origin" });
    return identifyFrom(response.status, (await response.json().catch(() => undefined)) as { docId?: string; error?: { message?: string } } | undefined);
  } catch {
    return { ok: false, message: "Could not reach this server, so nothing was changed. Try again in a moment." };
  }
}

/** The recipients of an encrypted vault (ROADMAP 2b.6), asked for when a person chooses to move a file into it. */
export async function fetchRecipients(connectionId: number, vault: string): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/recipients?vault=${encodeURIComponent(vault)}`, { credentials: "same-origin" });
    const parsed = (await response.json().catch(() => undefined)) as { recipients?: string; error?: { message?: string } } | undefined;
    if (response.status === 200 && typeof parsed?.recipients === "string") return { ok: true, text: parsed.recipients };
    return { ok: false, message: parsed?.error?.message ?? "Could not read that vault's recipients just now. Nothing was moved. Try again in a moment." };
  } catch {
    return { ok: false, message: "Could not reach this server, so nothing was moved. Try again in a moment." };
  }
}

/** Move one file to another vault, one of them encrypted (ROADMAP 2b.6), with the bytes the browser made for the destination (`content`, base64). */
export async function sendTransfer(connectionId: number, input: { path: string; blob: string; destination: string; content: string }): Promise<CreateAttempt> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/files/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as { path?: string; error?: { message?: string } } | undefined;
    if (response.status === 200 && typeof parsed?.path === "string") return { ok: true, path: parsed.path };
    if (response.status === 401) return { ok: false, message: "You are signed out, so nothing was moved. Sign in again, then try again." };
    return { ok: false, message: parsed?.error?.message ?? "Could not move that just now. Nothing was moved. Try again in a moment." };
  } catch {
    return { ok: false, message: "Could not reach this server, so nothing was moved. Try again in a moment." };
  }
}

// --- A header's title (ROADMAP 1b.5) -------------------------------------------------------------------------------

export type TitleAttempt = { ok: true; header: string } | { ok: false; message: string };

export function titleFrom(status: number, body: { header?: string; error?: { message?: string } } | undefined): TitleAttempt {
  if (status === 200 && typeof body?.header === "string") return { ok: true, header: body.header };
  if (status === 401) return { ok: false, message: "You are signed out, so the title was not changed. Sign in again, then try again." };
  return { ok: false, message: body?.error?.message ?? "Could not change the title just now. Try again in a moment." };
}

/** Ask the server to write `title` into a header (the header alone is sent, never the body); the answer is the header to use. */
export async function sendTitle(connectionId: number, header: string, title: string): Promise<TitleAttempt> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/files/header`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ header, title }),
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as Parameters<typeof titleFrom>[1];
    return titleFrom(response.status, parsed);
  } catch {
    return { ok: false, message: "Could not reach this server, so the title was not changed. Try again in a moment." };
  }
}

/** Ask the server to write a `date` (spec §8.1), or with null to take it away, into a header; as `sendTitle`. */
export async function sendDate(connectionId: number, header: string, date: string | null): Promise<TitleAttempt> {
  return sendHeaderChange(connectionId, { header, date }, "the date was not changed");
}

/** Ask the server to write `tags` into a header, as written; as `sendTitle`. */
export async function sendTags(connectionId: number, header: string, tags: string[]): Promise<TitleAttempt> {
  return sendHeaderChange(connectionId, { header, tags }, "the tags were not changed");
}

async function sendHeaderChange(connectionId: number, body: Record<string, unknown>, what: string): Promise<TitleAttempt> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/files/header`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    const parsed = (await response.json().catch(() => undefined)) as Parameters<typeof titleFrom>[1];
    if (response.status === 401) return { ok: false, message: `You are signed out, so ${what}. Sign in again, then try again.` };
    return titleFrom(response.status, parsed);
  } catch {
    return { ok: false, message: `Could not reach this server, so ${what}. Try again in a moment.` };
  }
}

// --- A site's new post (ROADMAP 3c.2) -------------------------------------------------------------------------------

/** Make a post in a site, dated now at this browser's offset from UTC: the server asks the site's engine where it goes and what it says. */
export async function sendPost(connectionId: number, title: string, draft: boolean, now: Date = new Date()): Promise<CreateAttempt> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/files/post`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ at: now.getTime(), offsetMinutes: -now.getTimezoneOffset(), title, draft }),
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as { path?: string; error?: { message?: string } } | undefined;
    return createFrom(response.status, parsed);
  } catch {
    return { ok: false, message: "Could not reach this server, so no post was made. Try again in a moment." };
  }
}

// --- A journal's new entry (ROADMAP 3b.1) ---------------------------------------------------------------------------

/** Make an entry in a plaintext journal, dated now at this browser's offset from UTC (spec §8.1): the server writes it. */
export async function sendEntry(connectionId: number, title: string, now: Date = new Date()): Promise<CreateAttempt> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/files/entry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `getTimezoneOffset` is minutes *behind* UTC; the format's offset is minutes ahead.
      body: JSON.stringify({ at: now.getTime(), offsetMinutes: -now.getTimezoneOffset(), title }),
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as { path?: string; error?: { message?: string } } | undefined;
    return createFrom(response.status, parsed);
  } catch {
    return { ok: false, message: "Could not reach this server, so no entry was made. Try again in a moment." };
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

// --- Renaming and moving (ROADMAP 1b.11) ---------------------------------------------------------------------------

export type MoveAttempt =
  | { ok: true; files: number }
  /** `lookAgain` is for a refusal that means the page is out of date: it should be read again. `taken` names the paths in the way. */
  | { ok: false; message: string; lookAgain: boolean; taken: string[] };

const MOVE_LOOK_AGAIN = new Set(["gone", "upstream_changed", "folder_changed"]);

export function moveFrom(status: number, body: { files?: number; error?: { code?: string; message?: string; taken?: string[] } } | undefined): MoveAttempt {
  if (status === 200 && typeof body?.files === "number") return { ok: true, files: body.files };
  if (status === 401) return { ok: false, lookAgain: false, taken: [], message: "You are signed out, so nothing was moved. Sign in again, then try again." };
  const code = body?.error?.code;
  return {
    ok: false,
    lookAgain: code !== undefined && MOVE_LOOK_AGAIN.has(code),
    taken: body?.error?.taken ?? [],
    message: body?.error?.message ?? "Could not move that just now. Nothing was moved. Try again in a moment.",
  };
}

/** Rename or move a note, a document or a folder to `destination`, a path in the repository. What was shown is what is sent. */
export async function sendMove(connectionId: number, vault: string, target: DeleteTarget, destination: string): Promise<MoveAttempt> {
  try {
    const response = await fetch(`/api/connections/${connectionId}/files/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault, ...target, destination }),
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as Parameters<typeof moveFrom>[1];
    return moveFrom(response.status, parsed);
  } catch {
    return { ok: false, lookAgain: false, taken: [], message: "Could not reach this server, so nothing was moved. Try again in a moment." };
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
