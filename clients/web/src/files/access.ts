import type { LocalMinute } from "../format/types";
import type { Identity } from "../providers/types";
import type { CreateResult, FileKind, VaultRefusal } from "./create";
import type { CreateEncryptedResult, EncryptedTarget, EncryptedVaultRefusal } from "./create-encrypted";
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
  move: (accountId: string, id: number, input: { vault: string; target: DeleteTarget; destination: string; author: Identity }) => Promise<MoveResult>;
  /** Put back, through the connection's own token. Only called for a connection that is the caller's; its records are checked there. */
  restore: (accountId: string, id: number, input: { ids: number[]; path: string | undefined; author: Identity }) => Promise<RestoreResult>;
}

export function filesAccess(deps: AccessDeps): Pick<Deps, "create" | "createEncrypted" | "delete" | "restore" | "header" | "move"> {
  return {
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
      const vault = await deps.vaultFor(accountId, id, input.vault);
      if (vault !== "ok") return { found: true, result: { ok: false, reason: vault } };
      return { found: true, result: await deps.delete(accountId, id, input) };
    },

    async move(accountId, id, input) {
      if (!(await deps.owns(accountId, id))) return { found: false };
      const from = await deps.vaultFor(accountId, id, input.vault);
      if (from !== "ok") return { found: true, result: { ok: false, reason: from, where: "source" } };
      // Where it goes: the first step of the new path is its vault, which is asked of the repository as it is now.
      const to = input.destination.split("/")[0] as string;
      const destination = to === input.vault ? "ok" : await deps.vaultFor(accountId, id, to);
      if (destination !== "ok") return { found: true, result: { ok: false, reason: destination, where: "destination" } };
      return { found: true, result: await deps.move(accountId, id, input) };
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
