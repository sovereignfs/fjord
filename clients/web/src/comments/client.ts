import { NAME_KEY } from "../sharing/guest-client";
import { cleanGuestName } from "../sharing/guest-name";
import type { TextQuoteAnchor } from "./service";

/**
 * The browser's side of `/doc/<id>/comments` (ROADMAP 1d.1): the requests the comments panel makes, and what each answer means to it. The `*From`
 * functions are the meaning, kept apart from `fetch` so that they are tested without a browser. Every failure comes back as words for the person.
 */
export interface ThreadView {
  id: number;
  anchor: TextQuoteAnchor;
  body: string;
  authorKind: "account" | "guest";
  authorName: string;
  createdAt: number;
  editedAt: number | null;
  resolved: boolean;
  resolvedBy: string | null;
  mine: boolean;
  replies: ReplyView[];
}

export interface ReplyView {
  id: number;
  body: string;
  authorKind: "account" | "guest";
  authorName: string;
  createdAt: number;
  editedAt: number | null;
  mine: boolean;
}

export interface Listing {
  threads: ThreadView[];
  closed: boolean;
  /** Where the comments were up to when they were read (ROADMAP 1d.3): the live stream says when it is no longer this. */
  version: number;
  viewer: { role: "owner" | "view" | "comment" | "edit"; canComment: boolean; canModerate: boolean; name: string | null };
}

export type Done<T = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };
type Body = { error?: { code?: string; message?: string } } & Record<string, unknown>;

export function failureFrom(status: number, body: Body | undefined): { ok: false; code: string; message: string } {
  if (status === 404 && (body?.error?.code === "not_found" || body?.error?.code === undefined)) return { ok: false, code: "not_found", message: "You no longer have access to this document's comments." };
  return { ok: false, code: body?.error?.code ?? "failed", message: body?.error?.message ?? "Could not do that just now. Nothing was changed. Try again in a moment." };
}

export function listingFrom(status: number, body: Body | undefined): Done<{ listing: Listing }> {
  if (status === 200 && Array.isArray(body?.threads) && typeof body?.closed === "boolean" && typeof body?.viewer === "object") return { ok: true, listing: body as unknown as Listing };
  return failureFrom(status, body);
}

export function madeFrom(status: number, body: Body | undefined): Done<{ id: number | undefined }> {
  if ((status === 200 || status === 201) && body?.ok === true) return { ok: true, id: typeof body.id === "number" ? body.id : undefined };
  return failureFrom(status, body);
}

/** The id this browser makes up for itself, so that its own comments can be told from others' where nobody is signed in. */
export const CLIENT_KEY = "fjord:guest-id";
let fallback: string | undefined;

export function clientId(): string {
  try {
    const kept = window.localStorage.getItem(CLIENT_KEY);
    if (kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept)) return kept;
    const made = globalThis.crypto.randomUUID().replace(/-/g, "");
    window.localStorage.setItem(CLIENT_KEY, made);
    return made;
  } catch {
    // No storage: an id for as long as the page lives.
    return (fallback ??= globalThis.crypto.randomUUID().replace(/-/g, ""));
  }
}

/** The name this browser gave before, if it did. */
export function givenName(): string | undefined {
  try {
    return cleanGuestName(window.localStorage.getItem(NAME_KEY));
  } catch {
    return undefined;
  }
}

export function keepName(name: string): void {
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    // Not remembering it only means it is asked for again.
  }
}

const address = (docId: string) => `/doc/${docId}/comments`;

/** Where the live stream of a document's comments is (ROADMAP 1d.3). */
export const eventsAddress = (docId: string) => `${address(docId)}/events`;

/** What a message of the live stream says: the version the comments are at now, or nothing if it does not say. */
export function versionFrom(data: unknown): number | undefined {
  try {
    const parsed: unknown = JSON.parse(String(data));
    const version = typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
    return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

async function call(method: string, docId: string, data?: unknown, query = ""): Promise<{ status: number; body: Body | undefined } | undefined> {
  try {
    const response = await fetch(`${address(docId)}${query}`, {
      method,
      headers: data === undefined ? {} : { "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      credentials: "same-origin",
    });
    return { status: response.status, body: (await response.json().catch(() => undefined)) as Body | undefined };
  } catch {
    return undefined;
  }
}
const unreachable: { ok: false; code: string; message: string } = { ok: false, code: "unreachable", message: "Could not reach this server, so nothing was changed. Try again in a moment." };

/** Who the person says they are, for the requests that need it: nothing for a signed-in account (the server knows), else a name and a browser id. */
export interface Claim {
  name?: string;
  clientId?: string;
}

export async function loadComments(docId: string, claim: Claim): Promise<Done<{ listing: Listing }>> {
  const query = claim.name && claim.clientId ? `?name=${encodeURIComponent(claim.name)}&client=${encodeURIComponent(claim.clientId)}` : "";
  const answer = await call("GET", docId, undefined, query);
  return answer ? listingFrom(answer.status, answer.body) : unreachable;
}

export async function startThread(docId: string, anchor: TextQuoteAnchor, body: string, claim: Claim) {
  const answer = await call("POST", docId, { op: "thread", anchor, body, ...claim });
  return answer ? madeFrom(answer.status, answer.body) : unreachable;
}

export async function addReply(docId: string, thread: number, body: string, claim: Claim) {
  const answer = await call("POST", docId, { op: "reply", thread, body, ...claim });
  return answer ? madeFrom(answer.status, answer.body) : unreachable;
}

export async function setResolved(docId: string, thread: number, resolved: boolean, claim: Claim) {
  const answer = await call("PATCH", docId, { op: "resolve", thread, resolved, ...claim });
  return answer ? madeFrom(answer.status, answer.body) : unreachable;
}

export async function editComment(docId: string, kind: "thread" | "reply", id: number, body: string, claim: Claim) {
  const answer = await call("PATCH", docId, { op: "edit", kind, id, body, ...claim });
  return answer ? madeFrom(answer.status, answer.body) : unreachable;
}

export async function deleteComment(docId: string, kind: "thread" | "reply", id: number, claim: Claim) {
  const answer = await call("DELETE", docId, { kind, id, ...claim });
  return answer ? madeFrom(answer.status, answer.body) : unreachable;
}

/** Move a thread onto the words its text was edited into (ROADMAP 1d.2): from the anchor it was found with, to the one it has now. */
export async function moveThread(docId: string, thread: number, from: TextQuoteAnchor, to: TextQuoteAnchor, claim: Claim) {
  const answer = await call("PATCH", docId, { op: "reanchor", thread, from, to, ...claim });
  return answer ? madeFrom(answer.status, answer.body) : unreachable;
}

export async function setClosed(docId: string, closed: boolean) {
  const answer = await call("PATCH", docId, { op: "close", closed });
  return answer ? madeFrom(answer.status, answer.body) : unreachable;
}
