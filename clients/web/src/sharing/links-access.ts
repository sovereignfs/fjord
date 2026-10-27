import { type Grant, decide } from "../access/policy";
import type { Deps, LinkSummary } from "./links-http";
import type { LinkService } from "./links";
import { hashPassword } from "./password";

/**
 * Whose, and what has a link (ROADMAP 1c.3). `links-http.ts` has the request's rules; this has the repository's:
 *
 *  - Only the owner of the connection makes links, and the policy says so (`manage_shares`): another's is "not found".
 *  - A link is made only for a document that is in the connection's repository now; a note is refused.
 *  - Revoking or listing is a matter of the connection's own rows (a link of another connection is not found by its number).
 */
export interface AccessDeps {
  owns: (accountId: string, id: number) => Promise<boolean>;
  /** What the Doc `id` is in the connection's repository now. */
  documentIn: (accountId: string, id: number, docId: string) => Promise<"document" | "note" | "gone" | "unavailable">;
  links: Pick<LinkService, "create" | "list" | "revoke">;
  now?: () => number;
}

export function linksAccess(deps: AccessDeps): Pick<Deps, "create" | "list" | "revoke"> {
  const now = () => deps.now?.() ?? Date.now();
  const mayShare = async (accountId: string, id: number): Promise<boolean> => {
    const grants: Grant[] = (await deps.owns(accountId, id)) ? [{ kind: "owner" }] : [];
    return decide(grants, "manage_shares", { kind: "document" }, now()) === "allow";
  };

  return {
    async create(accountId, id, input) {
      if (!(await mayShare(accountId, id))) return { found: false };
      const kind = await deps.documentIn(accountId, id, input.docId);
      if (kind === "note") return { found: true, result: { ok: false, reason: "not_a_document" } };
      if (kind !== "document") return { found: true, result: { ok: false, reason: kind } };
      // The password is hashed here and goes no further than this: the store is given the hash, and the answer carries neither.
      const hash = input.password === null ? null : await hashPassword(input.password);
      return { found: true, result: await deps.links.create(id, input.docId, input.role, input.expiresAt, accountId, hash) };
    },

    async list(accountId, id, docId) {
      if (!(await mayShare(accountId, id))) return { found: false };
      const at = now();
      const links: LinkSummary[] = (await deps.links.list(id, docId)).map((link) => ({
        id: link.id,
        role: link.role,
        expiresAt: link.expiresAt,
        revokedAt: link.revokedAt,
        createdAt: link.createdAt,
        passwordProtected: link.hasPassword,
        status: link.revokedAt !== null ? "revoked" : link.expiresAt !== null && link.expiresAt <= at ? "expired" : "active",
      }));
      return { found: true, links };
    },

    async revoke(accountId, id, input) {
      if (!(await mayShare(accountId, id))) return { found: false };
      return { found: true, revoked: await deps.links.revoke(id, input.docId, input.linkId) };
    },
  };
}
