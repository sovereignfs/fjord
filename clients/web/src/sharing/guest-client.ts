import type { Attempt } from "../working/saver";

/**
 * The browser's side of `PUT /doc/<id>/draft` (ROADMAP 1c.6): what the saver sends through when someone edits through a link, and what
 * each answer means to it. `guestAttemptFrom` is the meaning, kept apart from `fetch` so that it is tested without a browser.
 */
const KEEPALIVE_LIMIT = 40_000;

export function guestAttemptFrom(status: number, body: { error?: { code?: string; message?: string } } | undefined): Attempt {
  if (status >= 200 && status < 300) return { kind: "kept" };
  const code = body?.error?.code;
  const message = body?.error?.message;
  switch (code) {
    case "bad_name":
      return { kind: "refused", stop: true, message: message ?? "That name cannot be used. Give another." };
    case "read_only":
      return { kind: "refused", stop: true, message: "This link lets you read the document, not change it, so changes are not being kept." };
    case "not_editable":
      return { kind: "refused", stop: true, message: message ?? "This document cannot be edited through a link." };
    case "unstorable":
    case "too_large":
      return { kind: "refused", stop: false, message: message ?? "This text cannot be kept as a draft." };
    case "too_many_drafts":
    case "too_many_editors":
      return { kind: "refused", stop: true, message: message ?? "The owner needs to save a version before more changes can be kept." };
  }
  if (status === 403 || status === 404) return { kind: "refused", stop: true, message: "This link no longer works, so changes are not being kept. What you typed is still on this page." };
  // Anything else is the host or our side being unwell, or the network: the text is not lost, so ask again later.
  return { kind: "failed" };
}

export async function sendGuestDraft(docId: string, name: string, body: string): Promise<Attempt> {
  const payload = JSON.stringify({ name, body });
  try {
    const response = await fetch(`/doc/${docId}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: payload.length <= KEEPALIVE_LIMIT,
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => undefined)) as { error?: { code?: string; message?: string } } | undefined;
    return guestAttemptFrom(response.status, parsed);
  } catch {
    return { kind: "failed" };
  }
}

/** Where the name a person gave is kept in their browser (DESIGN.md §12): theirs, shown on what they change. */
export const NAME_KEY = "fjord:guest-name";
