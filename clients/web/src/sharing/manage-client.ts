import type { Role } from "../access/policy";

/**
 * The browser's side of sharing a document (ROADMAP 1c.7): the requests the Sharing panel makes to `/api/connections/<id>/shares` and
 * `/links`, and what each answer means to it. The `*From` functions are the meaning, kept apart from `fetch` so that they are tested without
 * a browser. Every failure comes back as words for the person; a link's token is in the answer to making it and is handed on once.
 */
export interface SharedWith {
  accountId: string;
  name: string;
  email: string;
  role: Role;
}

export interface LinkEntry {
  id: number;
  role: Role;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  status: "active" | "expired" | "revoked";
  passwordProtected: boolean;
}

export type Done<T = object> = ({ ok: true } & T) | { ok: false; message: string };

type Body = { error?: { code?: string; message?: string } } & Record<string, unknown>;

/** The words for a refusal: the server's own, else what the status says, else a plain apology. `what` is "the sharing" or "that". */
export function failureFrom(status: number, body: Body | undefined, what: string): { ok: false; message: string } {
  if (status === 401) return { ok: false, message: `You are signed out, so ${what} was not changed. Sign in again, then try again.` };
  return { ok: false, message: body?.error?.message ?? `Could not change ${what} just now. Nothing was changed. Try again in a moment.` };
}

export function sharesFrom(status: number, body: Body | undefined): Done<{ shares: SharedWith[] }> {
  if (status === 200 && Array.isArray(body?.shares)) return { ok: true, shares: body.shares as SharedWith[] };
  return failureFrom(status, body, "the sharing");
}

export function linksFrom(status: number, body: Body | undefined): Done<{ links: LinkEntry[] }> {
  if (status === 200 && Array.isArray(body?.links)) return { ok: true, links: body.links as LinkEntry[] };
  return failureFrom(status, body, "the links");
}

export function sharedFrom(status: number, body: Body | undefined): Done<{ message: string }> {
  if (status === 200 && typeof body?.message === "string") return { ok: true, message: body.message };
  return failureFrom(status, body, "the sharing");
}

export function createdFrom(status: number, body: Body | undefined): Done<{ id: number; token: string; url: string; passwordProtected: boolean }> {
  if (status === 201 && typeof body?.id === "number" && typeof body.token === "string" && typeof body.url === "string") {
    return { ok: true, id: body.id, token: body.token, url: body.url, passwordProtected: body.passwordProtected === true };
  }
  return failureFrom(status, body, "the links");
}

export function doneFrom(status: number, body: Body | undefined, field: "removed" | "revoked" | "updated"): Done<{ changed: boolean }> {
  if (status === 200 && typeof body?.[field] === "boolean") return { ok: true, changed: body[field] as boolean };
  return failureFrom(status, body, "that");
}

async function call(method: string, url: string, data?: unknown): Promise<{ status: number; body: Body | undefined } | undefined> {
  try {
    const response = await fetch(url, {
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
const unreachable = (what: string): { ok: false; message: string } => ({ ok: false, message: `Could not reach this server, so ${what} was not changed. Try again in a moment.` });

const shares = (connectionId: number) => `/api/connections/${connectionId}/shares`;
const links = (connectionId: number) => `/api/connections/${connectionId}/links`;

export async function listShares(connectionId: number, doc: string) {
  const answer = await call("GET", `${shares(connectionId)}?doc=${encodeURIComponent(doc)}`);
  return answer ? sharesFrom(answer.status, answer.body) : unreachable("the sharing");
}

export async function addShare(connectionId: number, doc: string, email: string, role: Role) {
  const answer = await call("POST", shares(connectionId), { doc, email, role });
  return answer ? sharedFrom(answer.status, answer.body) : unreachable("the sharing");
}

export async function removeShare(connectionId: number, doc: string, accountId: string) {
  const answer = await call("DELETE", shares(connectionId), { doc, accountId });
  return answer ? doneFrom(answer.status, answer.body, "removed") : unreachable("the sharing");
}

export async function listLinks(connectionId: number, doc: string) {
  const answer = await call("GET", `${links(connectionId)}?doc=${encodeURIComponent(doc)}`);
  return answer ? linksFrom(answer.status, answer.body) : unreachable("the links");
}

export async function createLink(connectionId: number, doc: string, input: { role: Role; expiresAt: number | null; password: string | null }) {
  const answer = await call("POST", links(connectionId), { doc, role: input.role, ...(input.expiresAt === null ? {} : { expiresAt: input.expiresAt }), ...(input.password === null ? {} : { password: input.password }) });
  return answer ? createdFrom(answer.status, answer.body) : unreachable("the links");
}

export async function updateLink(connectionId: number, doc: string, linkId: number, change: { role?: Role; expiresAt?: number | null; password?: string | null }) {
  const answer = await call("PATCH", links(connectionId), { doc, linkId, ...change });
  return answer ? doneFrom(answer.status, answer.body, "updated") : unreachable("the link");
}

export async function revokeLink(connectionId: number, doc: string, linkId: number) {
  const answer = await call("DELETE", links(connectionId), { doc, linkId });
  return answer ? doneFrom(answer.status, answer.body, "revoked") : unreachable("the link");
}

/** A time as the value of a `datetime-local` input, in the person's own zone; empty for none. */
export function toLocalInput(ms: number | null): string {
  if (ms === null) return "";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What a `datetime-local` input holds as a time: `null` when empty, `undefined` when it is not a time. */
export function fromLocalInput(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}
