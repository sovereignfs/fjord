import type { LocalMinute } from "../format/types";
import type { Identity } from "../providers/types";
import type { CreateResult, FileKind, VaultRefusal } from "./create";
import type { Deps } from "./http";

/**
 * Whose, and where (ROADMAP 1b.7). `http.ts` has the request's rules; this has the repository's:
 *
 *  - The connection must be the caller's. Another's is "not found", and nothing is read or made.
 *  - The vault must be one this version writes to: in the repository, plaintext, with a manifest that can be read and plain
 *    file names. That is asked of the repository as it is now (`vaultFor`), and is decided before a commit is attempted.
 */
export interface AccessDeps {
  /** Whether the connection is this account's. */
  owns: (accountId: string, id: number) => Promise<boolean>;
  /** Whether files may be made in this vault of the connection's repository: `ok`, or why not. */
  vaultFor: (accountId: string, id: number, vault: string) => Promise<"ok" | VaultRefusal | "unavailable">;
  /** Make the file, through the connection's own token. Only called for a vault that is `ok` of a connection that is the caller's. */
  create: (
    accountId: string,
    id: number,
    input: { vault: string; folder: string; kind: FileKind; title: string; localMinute: LocalMinute; author: Identity },
  ) => Promise<CreateResult>;
}

export function filesAccess(deps: AccessDeps): Pick<Deps, "create"> {
  return {
    async create(accountId, id, input) {
      if (!(await deps.owns(accountId, id))) return { found: false };
      const vault = await deps.vaultFor(accountId, id, input.vault);
      if (vault !== "ok") return { found: true, result: { ok: false, reason: vault } };
      return { found: true, result: await deps.create(accountId, id, input) };
    },
  };
}
