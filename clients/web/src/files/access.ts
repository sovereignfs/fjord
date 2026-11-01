import type { LocalMinute } from "../format/types";
import type { Identity } from "../providers/types";
import type { CreateResult, FileKind, VaultRefusal } from "./create";
import type { CreateEncryptedResult, EncryptedTarget, EncryptedVaultRefusal } from "./create-encrypted";
import type { TransferResult, VaultForm } from "./transfer";
import type { DeleteResult, DeleteTarget } from "./delete";
import type { MoveResult } from "./move";
import type { RestoreResult } from "./restore";
import type { Deps } from "./http";

/**
 * Whose, and where (ROADMAP 1b.7). `http.ts` has the request's rules; this has the repository's:
 *
 *  - The connection must be the caller's. Another's is "not found", and nothing is read or made.
 *  - Deleting is in a vault this version writes to; putting back checks the vaults of what it puts back (`restore.ts`).
 *  - The vault must be one this version writes to: in the repository, plaintext, with a manifest that can be read and plain
 *    file names. That is asked of the repository as it is now (`vaultFor`), and is decided before a commit is attempted.
 */
export interface AccessDeps {
  /** Whether the connection is this account's. */
  owns: (accountId: string, id: number) => Promise<boolean>;
  /** Whether files may be made in this vault of the connection's repository: `ok`, or why not. */
  vaultFor: (accountId: string, id: number, vault: string) => Promise<"ok" | VaultRefusal | "unavailable">;
  /** Whether files may be made in this encrypted vault (ROADMAP 2b.4), and how it names them: or why not. */
  encryptedVaultFor: (accountId: string, id: number, vault: string) => Promise<{ ok: true; target: EncryptedTarget } | { ok: false; reason: EncryptedVaultRefusal | "unavailable" }>;
  /** Make the file from the ciphertext, through the connection's own token. Only called for an encrypted vault that is `ok` of a connection that is the caller's. */
  createEncrypted: (
    accountId: string,
    id: number,
    input: { vault: string; folder: string; target: EncryptedTarget; kind: FileKind; title: string; localMinute: LocalMinute; ciphertext: Uint8Array; author: Identity },
  ) => Promise<CreateEncryptedResult>;
  /** A header with its title set or taken away, by the format module; undefined for a header that cannot be rewritten. */
  setTitle: (header: string, title: string) => string | undefined;
  /** Make the file, through the connection's own token. Only called for a vault that is `ok` of a connection that is the caller's. */
  create: (
    accountId: string,
    id: number,
    input: { vault: string; folder: string; kind: FileKind; title: string; localMinute: LocalMinute; author: Identity },
  ) => Promise<CreateResult>;
  /** Delete, through the connection's own token. Only called for a vault that is `ok` of a connection that is the caller's. */
  delete: (accountId: string, id: number, input: { vault: string; target: DeleteTarget; author: Identity }) => Promise<DeleteResult>;
  /** Rename or move, through the connection's own token. Only called for two vaults that are `ok` of a connection that is the caller's. */
  move: (accountId: string, id: number, input: { vault: string; target: DeleteTarget; destination: string; author: Identity; encrypted?: { idNamed: boolean } }) => Promise<MoveResult>;
  /** Move one file between vaults, one of them encrypted, through the connection's own token. Only called for two vaults that are `ok` of a connection that is the caller's. */
  transfer: (
    accountId: string,
    id: number,
    input: { path: string; blob: string; destination: string; content: Uint8Array; author: Identity; source: VaultForm; target: VaultForm },
  ) => Promise<TransferResult>;
  /** Put back, through the connection's own token. Only called for a connection that is the caller's; its records are checked there. */
  restore: (accountId: string, id: number, input: { ids: number[]; path: string | undefined; author: Identity }) => Promise<RestoreResult>;
}

/**
 * What a vault can be changed as (ROADMAP 2b.5): a plaintext vault with plain names, or an encrypted vault this version writes (`checkEncryptedVault`), whose
 * files are renamed, moved and deleted as the bytes they are: the server needs no key for any of it.
 */
async function changeable(deps: AccessDeps, accountId: string, id: number, vault: string): Promise<{ ok: true; encrypted: { idNamed: boolean } | undefined } | { ok: false; reason: VaultRefusal | "unavailable" }> {
  const plain = await deps.vaultFor(accountId, id, vault);
  if (plain === "ok") return { ok: true, encrypted: undefined };
  if (plain !== "encrypted_vault") return { ok: false, reason: plain };
  const encrypted = await deps.encryptedVaultFor(accountId, id, vault);
  if (!encrypted.ok) return { ok: false, reason: encrypted.reason === "unavailable" ? "unavailable" : "unsupported_vault" };
  return { ok: true, encrypted: { idNamed: encrypted.target.naming === "id" } };
}

/**
 * An encrypted vault holds its encrypted files (`….age`) and its own machinery: the manifest, the recipients file, the guard in `.gitignore`. The page offers to change
 * only the first, and the server holds to it: a file that is not an encrypted file is not deleted, moved or sent from an encrypted vault by a call that names it, since
 * taking away the recipients file or the guard would break the vault (security review of phase 2).
 */
const isPayload = (path: string) => /\.age$/i.test(path);

export function filesAccess(deps: AccessDeps): Pick<Deps, "create" | "createEncrypted" | "transfer" | "delete" | "restore" | "header" | "move"> {
  const formOf = (vault: { encrypted: { idNamed: boolean } | undefined }): VaultForm => (vault.encrypted ? { form: "encrypted", naming: vault.encrypted.idNamed ? "id" : "plain" } : { form: "plaintext" });
  return {
    async transfer(accountId, id, input) {
      if (!(await deps.owns(accountId, id))) return { found: false };
      const from = await changeable(deps, accountId, id, input.path.split("/")[0] as string);
      if (!from.ok) return { found: true, result: { ok: false, reason: from.reason, where: "source" } };
      if (from.encrypted && !isPayload(input.path)) return { found: true, result: { ok: false, reason: "protected", where: "source" } };
      const to = await changeable(deps, accountId, id, input.destination.split("/")[0] as string);
      if (!to.ok) return { found: true, result: { ok: false, reason: to.reason, where: "destination" } };
      // Between two plaintext vaults there is nothing to encrypt or decrypt, and nothing for the browser to do: that is Move.
      if (!from.encrypted && !to.encrypted) return { found: true, result: { ok: false, reason: "no_encryption", where: "destination" } };
      const { path, blob, destination, content, author } = input;
      return { found: true, result: await deps.transfer(accountId, id, { path, blob, destination, content, author, source: formOf(from), target: formOf(to) }) };
    },

    async createEncrypted(accountId, id, input) {
      if (!(await deps.owns(accountId, id))) return { found: false };
      const vault = await deps.encryptedVaultFor(accountId, id, input.vault);
      if (!vault.ok) return { found: true, result: { ok: false, reason: vault.reason } };
      // A title is sent for the name of a file in a plain-named vault. In an id-named vault the name is a secret, so sending it is a mistake of the page, not leaked on.
      if (vault.target.naming === "id" && input.title.trim() !== "") return { found: true, result: { ok: false, reason: "wrong_shape" } };
      return { found: true, result: await deps.createEncrypted(accountId, id, { ...input, target: vault.target }) };
    },

    async header(accountId, id, input) {
      if (!(await deps.owns(accountId, id))) return { found: false };
      const header = deps.setTitle(input.header, input.title);
      return { found: true, result: header === undefined ? { ok: false, reason: "unreadable" } : { ok: true, header } };
    },

    async delete(accountId, id, input) {
      if (!(await deps.owns(accountId, id))) return { found: false };
      const vault = await changeable(deps, accountId, id, input.vault);
      if (!vault.ok) return { found: true, result: { ok: false, reason: vault.reason } };
      if (vault.encrypted && input.target.type === "file" && !isPayload(input.target.path)) return { found: true, result: { ok: false, reason: "protected" } };
      return { found: true, result: await deps.delete(accountId, id, input) };
    },

    async move(accountId, id, input) {
      if (!(await deps.owns(accountId, id))) return { found: false };
      const from = await changeable(deps, accountId, id, input.vault);
      if (!from.ok) return { found: true, result: { ok: false, reason: from.reason, where: "source" } };
      if (from.encrypted && input.target.type === "file" && !isPayload(input.target.path)) return { found: true, result: { ok: false, reason: "protected", where: "source" } };
      // Where it goes: the first step of the new path is its vault, which is asked of the repository as it is now. Out of an encrypted vault, or into one
      // from another, is the browser's to do (ROADMAP 2b.6): here it would need a key, or would put plaintext where there must be none.
      const to = input.destination.split("/")[0] as string;
      if (to !== input.vault) {
        if (from.encrypted) return { found: true, result: { ok: false, reason: "other_vault", where: "destination" } };
        const destination = await deps.vaultFor(accountId, id, to);
        if (destination !== "ok") return { found: true, result: { ok: false, reason: destination, where: "destination" } };
      }
      return { found: true, result: await deps.move(accountId, id, { ...input, ...(from.encrypted ? { encrypted: from.encrypted } : {}) }) };
    },

    async restore(accountId, id, input) {
      if (!(await deps.owns(accountId, id))) return { found: false };
      return { found: true, result: await deps.restore(accountId, id, input) };
    },

    async create(accountId, id, input) {
      if (!(await deps.owns(accountId, id))) return { found: false };
      const vault = await deps.vaultFor(accountId, id, input.vault);
      if (vault !== "ok") return { found: true, result: { ok: false, reason: vault } };
      return { found: true, result: await deps.create(accountId, id, input) };
    },
  };
}
