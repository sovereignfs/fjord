import { isProviderError } from "../providers/errors";
import { assertWritablePath } from "../providers/validate";
import type { Fjord } from "../format/wasm";
import type { Identity, Provider, RepositoryRef } from "../providers/types";
import { looksEncrypted } from "../working/ciphertext";
import type { WorkingCopyService } from "../working/service";
import { formatIdentity } from "../working/version";
import { fileAt } from "./delete";
import { takenPaths } from "./restore";

/**
 * Moving a file between a plaintext vault and an encrypted one, or between two encrypted ones (ROADMAP 2b.6, DESIGN.md §8). The server has no key, so it cannot
 * change a file's form: the **browser** decrypts or encrypts it on the way and sends the bytes that belong at the destination. This commits them: one commit that
 * takes the source away and adds the destination, never forced, over nothing.
 *
 * What it holds to, whatever the page sent (invariant 1, spec §6.5):
 *  - **Plaintext goes only to a plaintext vault, ciphertext only to an encrypted one.** The destination vault's kind is the repository's, not the request's: bytes that
 *    begin as an age file are refused for a plaintext vault, and bytes that do not are refused for an encrypted one. So the new commit holds no plaintext in an encrypted vault.
 *  - **The shape of the destination's name:** `Name.md.age` in a plain-named encrypted vault, a new identifier and `.age` in an id-named one (its real name is inside
 *    the bytes), a `.md` or `.fj.md` in a plaintext vault. Every step passes `fjord-core`'s path rules; nothing is put over anything.
 *  - **What was shown is what moves:** the source only if it is still the blob the page decrypted or read, and with no draft (a draft is a different text from the one moved).
 *  - **The history is not rewritten.** Moving a file out of a plaintext vault leaves its plaintext in the repository's earlier commits; moving one out of an encrypted vault
 *    puts its plaintext in this one. The page says so before it asks.
 */
export interface TransferDeps {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: Pick<Fjord, "checkName" | "caseCollisions">;
  drafts: Pick<WorkingCopyService, "paths">;
}

/** How a vault holds its files: in the clear, or encrypted with names that are public (`plain`) or an identifier (`id`). */
export type VaultForm = { form: "plaintext" } | { form: "encrypted"; naming: "plain" | "id" };

export type TransferResult =
  | { ok: true; commit: string; path: string }
  | {
      ok: false;
      reason: "gone" | "upstream_changed" | "has_drafts" | "bad_path" | "protected" | "wrong_form" | "path_taken" | "same_vault" | "head_moved" | "read_only" | "bad_token" | "unavailable";
      taken?: string[];
    };

const ATTEMPTS = 2;
const MACHINERY = new Set(["fjord.vault.json", "fjord.json"]);
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function writable(path: string): boolean {
  try {
    assertWritablePath(path);
    return true;
  } catch {
    return false;
  }
}

/** The message of the commit. It names nothing that is secret: a name inside an id-named vault never appears, and a file's name only where the repository already had it. */
export function transferMessage(source: { path: string; form: VaultForm }, destination: { path: string; form: VaultForm }): string {
  const name = (path: string) => leaf(path).replace(/\.age$/i, "").replace(/\.fj\.md$/i, "").replace(/\.md$/i, "");
  const label = (side: { path: string; form: VaultForm }) => (side.form.form === "encrypted" && side.form.naming === "id" ? "a file" : name(side.path));
  const vault = (path: string) => path.split("/")[0];
  if (source.form.form === "plaintext") return `Move ${label(source)} into the encrypted vault ${vault(destination.path)}`;
  if (destination.form.form === "plaintext") return `Move ${label(source)} out of the encrypted vault ${vault(source.path)}`;
  return `Move ${label(source)} from ${vault(source.path)} to ${vault(destination.path)}`;
}

export async function transferFile(
  deps: TransferDeps,
  input: { connectionId: number; source: { path: string; blob: string; form: VaultForm }; destination: { path: string; form: VaultForm }; content: Uint8Array; author: Identity },
): Promise<TransferResult> {
  const { source, destination } = input;
  const sourceVault = source.path.split("/")[0] as string;
  const destinationVault = destination.path.split("/")[0] as string;
  if (sourceVault === destinationVault) return { ok: false, reason: "same_vault" };
  if (source.form.form === "plaintext" && destination.form.form === "plaintext") return { ok: false, reason: "wrong_form" };

  const segments = destination.path.split("/");
  if (segments.length < 2 || !writable(destination.path) || segments.some((segment) => deps.format.checkName(segment).length > 0)) return { ok: false, reason: "bad_path" };
  if (MACHINERY.has(leaf(destination.path)) || MACHINERY.has(leaf(source.path)) || source.path.split("/").length < 2) return { ok: false, reason: "protected" };

  // The bytes must be what the vault they go to holds (spec §6.5): plaintext in a plaintext vault, age in an encrypted one.
  const encrypted = looksEncrypted(input.content);
  const name = leaf(destination.path);
  if (destination.form.form === "plaintext") {
    if (encrypted || input.content.includes(0)) return { ok: false, reason: "wrong_form" };
    if (!/\.md$/i.test(name)) return { ok: false, reason: "bad_path" };
  } else {
    if (!encrypted) return { ok: false, reason: "wrong_form" };
    if (destination.form.naming === "id" ? !ULID.test(name.slice(0, -4)) || !name.endsWith(".age") : !/.\.age$/.test(name)) return { ok: false, reason: "bad_path" };
  }

  if ((await deps.drafts.paths(input.connectionId)).some((path) => path === source.path || path === destination.path || path.startsWith(`${destination.path}/`))) return { ok: false, reason: "has_drafts" };

  try {
    for (let attempt = 1; ; attempt++) {
      const head = await deps.provider.getHead(deps.ref, deps.branch);
      if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
      const expectedHead = head.head.commit;

      const entry = await fileAt(deps.provider, deps.ref, expectedHead, source.path);
      if (!entry) return { ok: false, reason: "gone" };
      if (entry.id !== source.blob) return { ok: false, reason: "upstream_changed" };

      const taken = await takenPaths(deps, expectedHead, [destination.path]);
      if (taken.length > 0) return { ok: false, reason: "path_taken", taken };

      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message: transferMessage(source, destination),
          author: formatIdentity(input.author),
          changes: [{ path: source.path, delete: true as const }, { path: destination.path, content: input.content }],
        });
        return { ok: true, commit: made.commit, path: destination.path };
      } catch (error) {
        if (isProviderError(error, "head_moved")) {
          if (attempt < ATTEMPTS) continue;
          return { ok: false, reason: "head_moved" };
        }
        throw error;
      }
    }
  } catch (error) {
    if (isProviderError(error, "forbidden")) return { ok: false, reason: "read_only" };
    if (isProviderError(error, "unauthorized")) return { ok: false, reason: "bad_token" };
    if (isProviderError(error, "not_found") || isProviderError(error, "unavailable") || isProviderError(error, "rate_limited")) return { ok: false, reason: "unavailable" };
    throw error;
  }
}
