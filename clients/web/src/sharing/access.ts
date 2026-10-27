import { type Grant, decide } from "../access/policy";
import type { Deps, ListResult, ShareResult } from "./http";
import { MAX_SHARES_PER_DOCUMENT, type ShareService } from "./shares";

/**
 * Whose, and what is shared (ROADMAP 1c.2). `http.ts` has the request's rules; this has the repository's and the accounts':
 *
 *  - Only the owner of the connection shares, and the policy says so (`manage_shares`): another's is "not found", and
 *    nothing is read.
 *  - The document is looked for in the connection's repository: a note is refused, and so is an id that is not there.
 *  - **The address is looked up last, and nothing before it differs for it.** The cap on shares is checked before the lookup,
 *    so that it is not a way to tell an address with an account from one without; naming oneself shares nothing, and says
 *    the same.
 */
export interface AccessDeps {
  /** Whether the connection is this account's. */
  owns: (accountId: string, id: number) => Promise<boolean>;
  /** What the Doc `id` is in the connection's repository now. */
  documentIn: (accountId: string, id: number, docId: string) => Promise<"document" | "note" | "gone" | "unavailable">;
  /** The account with exactly this address, if there is one. */
  accountByEmail: (email: string) => Promise<{ id: string } | undefined>;
  /** The name and address of an account, if it still exists. */
  accountById: (id: string) => Promise<{ name: string; email: string } | undefined>;
  shares: Pick<ShareService, "set" | "list" | "remove" | "count">;
  /** For tests. */
  now?: () => number;
}

export function sharingAccess(deps: AccessDeps): Pick<Deps, "share" | "list" | "unshare"> {
  /** Who may manage shares here: the owner, as the policy has it. */
  const mayShare = async (accountId: string, id: number): Promise<boolean> => {
    const grants: Grant[] = (await deps.owns(accountId, id)) ? [{ kind: "owner" }] : [];
    return decide(grants, "manage_shares", { kind: "document" }, deps.now?.() ?? Date.now()) === "allow";
  };

  return {
    async share(accountId, id, input): Promise<{ found: false } | { found: true; result: ShareResult }> {
      if (!(await mayShare(accountId, id))) return { found: false };
      const kind = await deps.documentIn(accountId, id, input.docId);
      if (kind === "note") return { found: true, result: { ok: false, reason: "not_a_document" } };
      if (kind !== "document") return { found: true, result: { ok: false, reason: kind } };
      if ((await deps.shares.count(id, input.docId)) >= MAX_SHARES_PER_DOCUMENT) return { found: true, result: { ok: false, reason: "too_many" } };
      const account = await deps.accountByEmail(input.email);
      if (account && account.id !== accountId) {
        const set = await deps.shares.set(id, input.docId, account.id, input.role, accountId);
        if (set === "too_many") return { found: true, result: { ok: false, reason: "too_many" } };
      }
      return { found: true, result: { ok: true } };
    },

    async list(accountId, id, docId): Promise<{ found: false } | { found: true; result: ListResult }> {
      if (!(await mayShare(accountId, id))) return { found: false };
      const rows = await deps.shares.list(id, docId);
      const shares: Extract<ListResult, { ok: true }>["shares"] = [];
      for (const row of rows) {
        const account = await deps.accountById(row.accountId);
        if (account) shares.push({ accountId: row.accountId, name: account.name, email: account.email, role: row.role });
      }
      return { found: true, result: { ok: true, shares } };
    },

    async unshare(accountId, id, input) {
      if (!(await mayShare(accountId, id))) return { found: false };
      return { found: true, result: { ok: true, removed: await deps.shares.remove(id, input.docId, input.accountId) } };
    },
  };
}
