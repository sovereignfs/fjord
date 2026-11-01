import type { SealedMode } from "./service";

/** The browser's side of the sealed share routes (ROADMAP 2c.1): the meaning of each answer, kept apart from the page. */
export interface SealedShareView {
  id: number;
  mode: SealedMode;
  createdAt: number;
}

const address = (connectionId: number) => `/api/connections/${connectionId}/sealed-shares`;

/** A file's sealed shares, newest first; null if they could not be read. */
export async function listSealed(connectionId: number, path: string): Promise<SealedShareView[] | null> {
  try {
    const response = await fetch(`${address(connectionId)}?path=${encodeURIComponent(path)}`, { credentials: "same-origin" });
    const parsed = (await response.json().catch(() => undefined)) as { shares?: SealedShareView[] } | undefined;
    return response.status === 200 && Array.isArray(parsed?.shares) ? parsed.shares : null;
  } catch {
    return null;
  }
}

export type CreateAttempt = { ok: true; token: string; share: SealedShareView } | { ok: false; message: string };

/** Keep a sealed copy (made in this browser) and get the link's token, once. */
export async function createSealed(connectionId: number, input: { path: string; mode: SealedMode; ciphertext: string }): Promise<CreateAttempt> {
  try {
    const response = await fetch(address(connectionId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), credentials: "same-origin" });
    const parsed = (await response.json().catch(() => undefined)) as { token?: string; share?: SealedShareView; error?: { message?: string } } | undefined;
    if (response.status === 201 && typeof parsed?.token === "string" && parsed.share) return { ok: true, token: parsed.token, share: parsed.share };
    if (response.status === 401) return { ok: false, message: "You are signed out, so nothing was shared. Sign in again, then try again." };
    return { ok: false, message: parsed?.error?.message ?? "Could not make that link just now. Nothing was shared. Try again in a moment." };
  } catch {
    return { ok: false, message: "Could not reach this server, so nothing was shared. Try again in a moment." };
  }
}

/** Revoke a share: its copy is deleted. True if it is gone (or was never there). */
export async function revokeSealed(connectionId: number, shareId: number): Promise<boolean> {
  try {
    const response = await fetch(`${address(connectionId)}?share=${shareId}`, { method: "DELETE", credentials: "same-origin" });
    return response.status === 204 || response.status === 404;
  } catch {
    return false;
  }
}

export type OpenAttempt = { ok: true; mode: SealedMode; ciphertext: string } | { ok: false; gone: boolean; message: string };

/** The copy a link opens. A 404 is "gone": revoked, or never a link. */
export async function fetchSealed(token: string): Promise<OpenAttempt> {
  try {
    const response = await fetch(`/api/sealed/${encodeURIComponent(token)}`, { credentials: "omit", cache: "no-store" });
    const parsed = (await response.json().catch(() => undefined)) as { mode?: SealedMode; ciphertext?: string } | undefined;
    if (response.status === 200 && (parsed?.mode === "key" || parsed?.mode === "password") && typeof parsed.ciphertext === "string") return { ok: true, mode: parsed.mode, ciphertext: parsed.ciphertext };
    if (response.status === 404) return { ok: false, gone: true, message: "This link does not work. It may have been revoked, or it may not be complete." };
    return { ok: false, gone: false, message: "Could not read this link just now. Try again in a moment." };
  } catch {
    return { ok: false, gone: false, message: "Could not reach the server. Try again in a moment." };
  }
}
