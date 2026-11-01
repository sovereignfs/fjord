import { ConnectionError, type ConnectionErrorCode } from "../connections/errors";
import type { VaultOptions } from "../format/types";
import { isProviderError } from "../providers/errors";
import type { Change } from "../providers/types";
import { type RepositoryRead, readRepository } from "./repository";
import { type SetupDeps, type SetupTarget, strictText } from "./setup";

/**
 * Adding a vault to a Fjord repository (ROADMAP 2d.1, DESIGN.md §7): plaintext or encrypted, in one commit.
 *
 * What is written is `fjord-core`'s (`scaffold::plan_vault`, through the format module), the planner `fjord vault add` writes from
 * too, never ours: the vault's manifest, for an encrypted one its recipients file and plaintext guard, `fjord.json` with the vault
 * listed (every other field kept) and, only where it is missing, spec §9's merge guard in `.gitattributes`. It is one commit on the head
 * that was read, never forced: if anything landed meanwhile nothing is written.
 *
 * **Nothing here trusts the browser.** The request carries the choices (a name, plaintext or encrypted, the naming, the public keys);
 * the plan is made on the repository as it is then. An encrypted vault is added only with at least one key, so that it is writable at
 * once: a vault nobody can write to is a trap, and the CLI's own message for it says so.
 */
export interface AddVaultDeps extends SetupDeps {}

/** `fjord.json` is small; a larger one is not something to rewrite. */
const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_RECIPIENTS = 64;

const MESSAGES = {
  read_only:
    "That token can read this repository but not write to it, so Fjord cannot add a vault. Create the token with the repository permission “Contents: Read and write”, and connect the repository again.",
  head_moved: "The repository changed while the vault was being added. Nothing was written. Look again, then add it.",
  manifest_unusable: "This repository's fjord.json is not there or cannot be read as it is, so Fjord will not rewrite it. Nothing was written.",
  gitattributes_unreadable:
    "This repository's .gitattributes cannot be read (it is too large, or is not text), so Fjord cannot add the one line an encrypted vault needs to it. Nothing was written.",
} as const;

const NO_RECIPIENT = "An encrypted vault needs at least one recipient, so that it can be written to at once. Add your public key (the Keys page shows it), then add the vault.";

const refused = (code: keyof typeof MESSAGES & ConnectionErrorCode) => new ConnectionError(code, MESSAGES[code]);

/** The core's finding, as the error a person is told. */
const CODES: Record<string, ConnectionErrorCode> = {
  manifest_unusable: "manifest_unusable",
  newer_version: "newer_version",
  invalid_name: "invalid_vault_name",
  name_taken: "vault_name_taken",
  recipients_need_encryption: "invalid_vault_options",
  id_naming_needs_encryption: "invalid_vault_options",
  bad_recipient: "invalid_vault_options",
  recipients_unsupported: "invalid_vault_options",
  gitattributes_not_read: "gitattributes_unreadable",
};

/** What the vault is called in the history. */
export const addVaultMessage = (options: VaultOptions): string => `Add vault "${options.name}"`;

/** `fjord.json`, exactly: strict UTF-8, because it is written back whole with a vault added and a lossy reading would change bytes. */
async function manifestText(deps: AddVaultDeps, target: SetupTarget, read: RepositoryRead): Promise<string> {
  const blob = read.blobs.get("fjord.json");
  if (blob === undefined) throw refused("manifest_unusable");
  try {
    const bytes = await deps.provider.readBlob(target.ref, blob, { maxBytes: MAX_MANIFEST_BYTES });
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (isProviderError(error, "too_large") || error instanceof TypeError) throw refused("manifest_unusable");
    throw error;
  }
}

/**
 * Add a vault: one commit on the head as it is now. Throws a `ConnectionError` saying what is wrong when it is not possible, and when
 * the head moved since it was read.
 */
export async function addVault(deps: AddVaultDeps, target: SetupTarget, options: VaultOptions): Promise<{ commit: string; vaultId: string }> {
  if (options.encrypted && options.recipients.length === 0) throw new ConnectionError("invalid_vault_options", NO_RECIPIENT);

  const read = await readRepository(deps, target);
  if (read.manifest === null || !read.manifest.ok) throw refused("manifest_unusable");
  if (!(await deps.provider.canWrite(target.ref, target.branch))) throw refused("read_only");

  const manifest = await manifestText(deps, target, read);
  const root = await deps.provider.listDirectory(target.ref, read.commit, "");
  const paths = root.map((entry) => entry.path);
  // The guard is needed, and `.gitattributes` read, for an encrypted vault only: a plaintext vault is not held up by a file it does not touch.
  let gitattributes: string | null = null;
  const entry = root.find((candidate) => candidate.path === ".gitattributes");
  if (options.encrypted && entry) {
    if (entry.kind !== "file") throw refused("gitattributes_unreadable");
    gitattributes = await strictText(deps.provider, target.ref, entry.id);
  }

  const random = deps.random?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const made = deps.format.planVault(options, manifest, { paths, gitattributes }, deps.now?.() ?? Date.now(), random);
  if (!made.ok) {
    const code = CODES[made.error.code] ?? "invalid_vault_options";
    throw new ConnectionError(code, code === "vault_name_taken" ? `${made.error.message}. Choose another name.` : made.error.message);
  }

  const encoder = new TextEncoder();
  const changes: Change[] = made.files.map((file) => ({ path: file.path, content: encoder.encode(file.contents) }));
  const touched = made.files.filter((file) => !file.path.startsWith(`${options.name}/`)).map((file) => file.path);
  const message = [
    addVaultMessage(options),
    "",
    `Adds ${options.encrypted ? "an encrypted" : "a plaintext"} vault "${options.name}" and lists it in fjord.json${
      options.encrypted && touched.includes(".gitattributes") ? ", and adds the merge guard spec §9 requires to .gitattributes" : ""
    }. Nothing else that is here is changed.`,
  ].join("\n");

  try {
    const result = await deps.provider.commit(target.ref, { branch: target.branch, expectedHead: read.commit, message, changes });
    return { commit: result.commit, vaultId: made.vaultId };
  } catch (error) {
    if (isProviderError(error, "head_moved")) throw refused("head_moved");
    if (isProviderError(error, "forbidden")) throw refused("read_only");
    throw error;
  }
}
