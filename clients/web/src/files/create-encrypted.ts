import type { Fjord } from "../format/wasm";
import type { LocalMinute, VaultListing } from "../format/types";
import { isProviderError } from "../providers/errors";
import type { Identity, Provider, RepositoryRef } from "../providers/types";
import { formatIdentity } from "../working/version";
import type { FileKind } from "./create";

/**
 * Making a new note or document in an **encrypted** vault (ROADMAP 2b.4, DESIGN.md §9, spec §6, §7). The browser writes the file and encrypts it to the vault's
 * recipients (`src/keys/files.ts`); this commits those bytes, with the owner's token, as one new file, never forced and never over anything. The server has no key
 * and never sees the text, so what it decides is only what is public anyway:
 *
 *  - **`plain` naming:** the file's name is public, so it is made here, from the title, as for a plaintext vault (`fjord-core`'s names, numbered past what the
 *    folder has, case aside), with the suffix appended: `Plan.md.age`. The title is sent for that, and only for that.
 *  - **`id` naming:** the file is called by a new identifier and the suffix (`01j….age`), and its real name is inside the container the browser made. No title is
 *    sent, so the commit says nothing of the file.
 *  - **Only ciphertext:** the bytes must begin as an age file does (`src/working/ciphertext.ts`); plain text is refused, so none can reach an encrypted vault.
 */
export interface CreateEncryptedDeps {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: Pick<Fjord, "quickNoteName" | "titleFromText" | "freeName" | "newUlid">;
  /** For tests: milliseconds since the epoch. */
  now?: () => number;
  /** For tests: at least ten random bytes. */
  random?: () => Uint8Array;
}

/** What the vault is, as far as writing to it goes: how its files are named, and the suffix every payload has. */
export interface EncryptedTarget {
  naming: "plain" | "id";
  suffix: string;
}

export type EncryptedVaultRefusal = "unknown_vault" | "not_encrypted" | "unsupported_vault";

/**
 * Whether files may be made in the encrypted vault `directory`, and how it names them. Only a vault this version can write to correctly: a readable
 * manifest, `age` with binary payloads, and the container its naming requires (spec §6.4, §7.2): none for `plain`, tar for `id`.
 */
export function checkEncryptedVault(vaults: VaultListing[], manifests: Record<string, string>, directory: string): { ok: true; target: EncryptedTarget } | { ok: false; reason: EncryptedVaultRefusal } {
  const vault = vaults.find((candidate) => candidate.directory === directory);
  if (!vault) return { ok: false, reason: "unknown_vault" };
  if (vault.manifestError !== null) return { ok: false, reason: "unsupported_vault" };
  if (vault.encrypted !== true) return { ok: false, reason: "not_encrypted" };
  const naming = vault.fileNaming;
  // `.age` is what the rules for names after it (renaming keeps it, a rename never makes a payload of something else) are written for.
  if ((naming !== "plain" && naming !== "id") || vault.suffix !== ".age") return { ok: false, reason: "unsupported_vault" };
  let encryption: { tool?: unknown; container?: unknown; armor?: unknown } | undefined;
  try {
    encryption = (JSON.parse(manifests[`${directory}/fjord.vault.json`] ?? "null") as { encryption?: typeof encryption } | null)?.encryption;
  } catch {
    return { ok: false, reason: "unsupported_vault" };
  }
  if (!encryption || encryption.tool !== "age" || encryption.armor !== false || encryption.container !== (naming === "id" ? "tar" : "none")) return { ok: false, reason: "unsupported_vault" };
  return { ok: true, target: { naming, suffix: ".age" } };
}

export type CreateEncryptedResult =
  | { ok: true; path: string; commit: string }
  | { ok: false; reason: "folder_gone" | "bad_title" | "head_moved" | "read_only" | "bad_token" | "unavailable" };

const ATTEMPTS = 2;
const DOCUMENT_EXTENSION = ".fj.md";

export async function createEncryptedFile(
  deps: CreateEncryptedDeps,
  input: { vault: string; folder: string; target: EncryptedTarget; kind: FileKind; title: string; localMinute: LocalMinute; ciphertext: Uint8Array; author: Identity },
): Promise<CreateEncryptedResult> {
  const title = input.title.trim();
  if (input.target.naming === "plain" && input.kind === "document" && deps.format.titleFromText(title) == null) return { ok: false, reason: "bad_title" };
  const directory = input.folder === "" ? input.vault : `${input.vault}/${input.folder}`;
  const author = formatIdentity(input.author);
  const { suffix } = input.target;

  try {
    for (let attempt = 1; ; attempt++) {
      const head = await deps.provider.getHead(deps.ref, deps.branch);
      if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
      const expectedHead = head.head.commit;

      const entries = await deps.provider.listDirectory(deps.ref, expectedHead, directory).catch((error: unknown) => {
        if (isProviderError(error, "not_found")) return [];
        throw error;
      });
      if (entries.length === 0) return { ok: false, reason: "folder_gone" };
      const present = entries.map((entry) => entry.path.slice(directory.length + 1));

      const { file, label } = nameFor(deps, input, title, present, suffix);
      const path = `${directory}/${file}`;
      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message: label === undefined ? "Create an encrypted file" : `Create ${label}`,
          author,
          changes: [{ path, content: input.ciphertext }],
        });
        return { ok: true, path, commit: made.commit };
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

/** The file's name in the folder, and what to call it in the commit message (none in an `id`-named vault, where the name is a secret). */
function nameFor(deps: CreateEncryptedDeps, input: { kind: FileKind; target: EncryptedTarget; localMinute: LocalMinute }, title: string, present: string[], suffix: string): { file: string; label: string | undefined } {
  if (input.target.naming === "id") {
    const taken = new Set(present.map((name) => name.toLowerCase()));
    for (let tries = 0; ; tries++) {
      const id = deps.format.newUlid(deps.now?.() ?? Date.now(), deps.random?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(16)));
      if (!taken.has(`${id}${suffix}`.toLowerCase()) || tries > 8) return { file: `${id}${suffix}`, label: undefined };
    }
  }
  // Names that are taken are the payloads' real names (the suffix off), and anything else in the folder as it is.
  const logical = present.map((name) => (name.toLowerCase().endsWith(suffix.toLowerCase()) ? name.slice(0, name.length - suffix.length) : name));
  const name = input.kind === "note" ? deps.format.quickNoteName(title === "" ? "" : `# ${title}\n`, logical, input.localMinute) : deps.format.freeName(deps.format.titleFromText(title) as string, DOCUMENT_EXTENSION, logical);
  return { file: `${name}${suffix}`, label: name.endsWith(DOCUMENT_EXTENSION) ? name.slice(0, -DOCUMENT_EXTENSION.length) : name.replace(/\.md$/i, "") };
}
