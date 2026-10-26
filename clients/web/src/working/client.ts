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
