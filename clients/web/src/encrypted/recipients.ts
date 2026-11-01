import { safeSegments } from "../browse/location";
import { readNoteText } from "../browse/note";
import type { RepositoryRead } from "../browse/repository";
import type { Provider, RepositoryRef } from "../providers/types";

/**
 * The recipients of an encrypted vault (spec §6.1, ROADMAP 2b.3): the public keys a file is encrypted to, from the file its manifest names. They are not secret
 * (a recipients file is committed in the open), and the browser needs them to encrypt what is edited; the server only reads the file and hands its text over.
 */

/** Where the vault's recipients file is, repository-relative, from the vault's manifest text; undefined if the manifest does not say, or says a way out of the vault. */
export function recipientsPath(vaultDirectory: string, manifestText: string | undefined): string | undefined {
  if (manifestText === undefined) return undefined;
  let named: unknown;
  try {
    const manifest: unknown = JSON.parse(manifestText);
    named = (manifest as { encryption?: { recipients?: unknown } } | null)?.encryption?.recipients;
  } catch {
    return undefined;
  }
  if (typeof named !== "string" || named === "" || named.startsWith("/")) return undefined;
  const segments = named.split("/");
  return safeSegments(segments) ? [vaultDirectory, ...segments].join("/") : undefined;
}

export type Recipients = { ok: true; text: string } | { ok: false; message: string };

export async function readRecipients(provider: Provider, ref: RepositoryRef, read: RepositoryRead, vaultDirectory: string): Promise<Recipients> {
  const path = recipientsPath(vaultDirectory, read.manifests[`${vaultDirectory}/fjord.vault.json`]);
  if (path === undefined) return { ok: false, message: "This vault's manifest does not name a recipients file, so there is no one to encrypt to." };
  const file = await readNoteText(provider, ref, read, path);
  if (!file.ok) return { ok: false, message: "This vault's recipients file could not be read, so there is no one to encrypt to." };
  return { ok: true, text: file.text };
}
