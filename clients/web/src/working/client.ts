import type { Attempt } from "./saver";

/**
 * The browser's side of `/api/connections/<id>/working-copy`: what the saver sends through, and what each answer means
 * to it. `attemptFrom` is the meaning, kept apart from `fetch` so that it is tested without a browser.
 */
const address = (connectionId: number) => `/api/connections/${connectionId}/working-copy`;

/** A request kept alive past the page is limited to 64 kB between all of them; a larger text is sent as a normal one. */
const KEEPALIVE_LIMIT = 40_000;

/** What an answer means for the saver: kept; refused (and whether anything the person types can change that); or to be tried again. */
export function attemptFrom(status: number, body: { error?: { code?: string; message?: string } } | undefined): Attempt {
  if (status >= 200 && status < 300) return { kind: "kept" };
  const code = body?.error?.code;
  const message = body?.error?.message;
  switch (code) {
    case "base_mismatch":
      return { kind: "refused", stop: true, message: "This note changed in the repository after these changes were started. They are kept as they are; reload to see the note as it is now." };
    case "unstorable":
    case "too_large":
    case "too_many_drafts":
      return { kind: "refused", stop: false, message: message ?? "This text cannot be kept as a draft." };
    case "not_editable":
      return { kind: "refused", stop: true, message: message ?? "This file cannot be edited here." };
  }
  if (status === 401) return { kind: "refused", stop: true, message: "You are signed out, so changes are not being kept. Sign in again in another tab, then reload; what you typed is still on this page." };
  if (status === 403 || status === 404) return { kind: "refused", stop: true, message: "This repository is no longer available to you, so changes are not being kept." };
  // Anything else is the host or our side being unwell, or the network: the text is not lost, so ask again later.
  return { kind: "failed" };
}

export async function sendDraft(connectionId: number, path: string, baseBlob: string, content: string): Promise<Attempt> {
  const body = JSON.stringify({ path, baseBlob, content });
  try {
    const response = await fetch(address(connectionId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      keepalive: body.length <= KEEPALIVE_LIMIT,
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as { error?: { code?: string; message?: string } } | undefined;
    return attemptFrom(response.status, parsed);
  } catch {
    return { kind: "failed" };
  }
}

/** Throw the draft away. True if it is gone (or was not there). */
export async function discardDraft(connectionId: number, path: string): Promise<boolean> {
  try {
    const response = await fetch(`${address(connectionId)}?path=${encodeURIComponent(path)}`, { method: "DELETE", credentials: "same-origin" });
    return response.status === 204 || response.status === 404;
  } catch {
    return false;
  }
}

export type VersionAttempt = { ok: true; commit: string } | { ok: false; message: string; code?: string };

/** What an answer to "make a version" means: made, or why not in the server's own words (which say whether the changes are kept). */
export function versionFrom(status: number, body: { commit?: string; error?: { code?: string; message?: string } } | undefined): VersionAttempt {
  if (status === 201 && typeof body?.commit === "string") return { ok: true, commit: body.commit };
  if (status === 401) return { ok: false, message: "You are signed out, so nothing was saved. Sign in again in another tab, then try again; your changes are kept." };
  return { ok: false, message: body?.error?.message ?? "Could not save a version just now. Your changes are kept. Try again in a moment.", ...(body?.error?.code ? { code: body.error.code } : {}) };
}

/** Make a version of the note's draft: one commit in the repository. */
export async function sendVersion(connectionId: number, path: string, message: string): Promise<VersionAttempt> {
  try {
    const response = await fetch(`${address(connectionId)}/version`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, message: message.trim() === "" ? null : message }),
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as { commit?: string; error?: { code?: string; message?: string } } | undefined;
    return versionFrom(response.status, parsed);
  } catch {
    return { ok: false, message: "Could not reach this server, so nothing was saved. Your changes are kept. Try again in a moment." };
  }
}

export type ResolveAttempt =
  | { ok: true; conflicts: number }
  /** `look_again` is for a refusal that means the page is out of date: it should be read again. */
  | { ok: false; message: string; lookAgain: boolean };

const LOOK_AGAIN = new Set(["no_draft", "up_to_date", "gone", "upstream_moved", "draft_changed"]);

/** What an answer to "go on from the changed file" means: done, or why not in the server's words, and whether to look again. */
export function resolveFrom(status: number, body: { conflicts?: number; error?: { code?: string; message?: string } } | undefined): ResolveAttempt {
  if (status === 200 && typeof body?.conflicts === "number") return { ok: true, conflicts: body.conflicts };
  if (status === 401) return { ok: false, lookAgain: false, message: "You are signed out, so nothing was changed. Sign in again in another tab, then try again; your changes are kept." };
  const code = body?.error?.code;
  return { ok: false, lookAgain: code !== undefined && LOOK_AGAIN.has(code), message: body?.error?.message ?? "Could not do that just now. Your changes are kept. Try again in a moment." };
}

/** Move the draft onto the file as it is now: as it is (`mine`) or merged with it (`combine`). Nothing is written to the repository. */
export async function sendResolve(connectionId: number, path: string, choice: "mine" | "combine", upstreamBlob: string): Promise<ResolveAttempt> {
  try {
    const response = await fetch(`${address(connectionId)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, choice, upstreamBlob }),
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as { conflicts?: number; error?: { code?: string; message?: string } } | undefined;
    return resolveFrom(response.status, parsed);
  } catch {
    return { ok: false, lookAgain: false, message: "Could not reach this server, so nothing was changed. Your changes are kept. Try again in a moment." };
  }
}
