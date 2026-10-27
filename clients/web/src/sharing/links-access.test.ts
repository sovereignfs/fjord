import { describe, expect, it, vi } from "vitest";
import { type AccessDeps, linksAccess } from "./links-access";

/** Whose, and what has a link (`links-access.ts`), with stand-ins for the connection, the repository and the store. */
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const NOW = 1_800_000_000_000;

function setup(over: { owns?: boolean; kind?: Awaited<ReturnType<AccessDeps["documentIn"]>> } = {}) {
  const owns = vi.fn(async (..._args: unknown[]) => over.owns ?? true);
  const documentIn = vi.fn(async (..._args: unknown[]) => over.kind ?? ("document" as const));
  const links = {
    create: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, id: 7, token: "T".repeat(43) })),
    list: vi.fn(async (..._args: unknown[]) => [
      { id: 3, connectionId: 1, docId: DOC, role: "view" as const, expiresAt: null, revokedAt: null, createdAt: NOW - 30 },
      { id: 2, connectionId: 1, docId: DOC, role: "edit" as const, expiresAt: NOW - 1, revokedAt: null, createdAt: NOW - 20 },
      { id: 1, connectionId: 1, docId: DOC, role: "comment" as const, expiresAt: NOW + 1000, revokedAt: NOW - 5, createdAt: NOW - 10 },
      { id: 0, connectionId: 1, docId: DOC, role: "view" as const, expiresAt: NOW, revokedAt: null, createdAt: NOW - 5 },
      { id: -1, connectionId: 1, docId: DOC, role: "view" as const, expiresAt: NOW + 1, revokedAt: null, createdAt: NOW - 4 },
    ]),
    revoke: vi.fn(async (..._args: unknown[]) => true),
  };
  const access = linksAccess({ owns: (a, i) => owns(a, i), documentIn: (a, i, d) => documentIn(a, i, d), links, now: () => NOW });
  return { access, owns, documentIn, links };
}

describe("links of a document", () => {
  it("are the owner's only: another's connection is not found, and nothing is looked at or made", async () => {
    const { access, documentIn, links } = setup({ owns: false });
    expect(await access.create("mallory", 1, { docId: DOC, role: "view", expiresAt: null })).toEqual({ found: false });
    expect(await access.list("mallory", 1, DOC)).toEqual({ found: false });
    expect(await access.revoke("mallory", 1, { docId: DOC, linkId: 3 })).toEqual({ found: false });
    expect(documentIn).not.toHaveBeenCalled();
    for (const mock of Object.values(links)) expect(mock).not.toHaveBeenCalled();
  });

  it("are made for a document, at the role and expiry asked, by the owner", async () => {
    const { access, links } = setup();
    expect(await access.create("alice", 1, { docId: DOC, role: "comment", expiresAt: NOW + 5 })).toEqual({ found: true, result: { ok: true, id: 7, token: "T".repeat(43) } });
    expect(links.create).toHaveBeenCalledWith(1, DOC, "comment", NOW + 5, "alice");
  });

  it("are not made for a note, or for an id that is not there", async () => {
    for (const [kind, reason] of [["note", "not_a_document"], ["gone", "gone"], ["unavailable", "unavailable"]] as const) {
      const { access, links } = setup({ kind });
      expect(await access.create("alice", 1, { docId: DOC, role: "view", expiresAt: null })).toEqual({ found: true, result: { ok: false, reason } });
      expect(links.create).not.toHaveBeenCalled();
    }
  });

  it("are listed with what has become of each: active, expired (from the moment of its expiry, as the policy has it) or revoked (which comes first)", async () => {
    const { access } = setup();
    const listed = await access.list("alice", 1, DOC);
    expect(listed.found && listed.links.map((link) => [link.id, link.status])).toEqual([[3, "active"], [2, "expired"], [1, "revoked"], [0, "expired"], [-1, "active"]]);
  });

  it("are revoked by the owner, who is told whether there was a link to revoke", async () => {
    const { access, links } = setup();
    expect(await access.revoke("alice", 1, { docId: DOC, linkId: 3 })).toEqual({ found: true, revoked: true });
    expect(links.revoke).toHaveBeenCalledWith(1, DOC, 3);
    links.revoke.mockResolvedValueOnce(false);
    expect(await access.revoke("alice", 1, { docId: DOC, linkId: 3 })).toEqual({ found: true, revoked: false });
  });
});
