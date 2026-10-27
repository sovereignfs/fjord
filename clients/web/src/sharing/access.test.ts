import { describe, expect, it, vi } from "vitest";
import { MAX_SHARES_PER_DOCUMENT } from "./shares";
import { type AccessDeps, sharingAccess } from "./access";

/** Whose, and what is shared (`access.ts`), with stand-ins for the connection, the repository and the accounts. */
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";

function setup(over: { owns?: boolean; kind?: Awaited<ReturnType<AccessDeps["documentIn"]>>; accounts?: Record<string, { id: string; name: string; email: string }>; count?: number } = {}) {
  const accounts = over.accounts ?? { "grace@example.com": { id: "grace", name: "Grace", email: "grace@example.com" } };
  const owns = vi.fn(async (..._args: unknown[]) => over.owns ?? true);
  const documentIn = vi.fn(async (..._args: unknown[]) => over.kind ?? ("document" as const));
  const accountByEmail = vi.fn(async (email: string) => accounts[email]);
  const accountById = vi.fn(async (id: string) => Object.values(accounts).find((account) => account.id === id));
  const shares = {
    set: vi.fn(async (..._args: unknown[]) => "ok" as const),
    list: vi.fn(async (..._args: unknown[]) => [{ accountId: "grace", role: "view" as const, createdAt: 1 }, { accountId: "deleted", role: "edit" as const, createdAt: 2 }]),
    remove: vi.fn(async (..._args: unknown[]) => true),
    count: vi.fn(async (..._args: unknown[]) => over.count ?? 0),
  };
  const access = sharingAccess({ owns: (a, i) => owns(a, i), documentIn: (a, i, d) => documentIn(a, i, d), accountByEmail, accountById, shares });
  return { access, owns, documentIn, accountByEmail, accountById, shares };
}

const input = { docId: DOC, email: "grace@example.com", role: "comment" as const };

describe("sharing a document", () => {
  it("is the owner's only: another's connection is not found, and nothing is looked at", async () => {
    const { access, documentIn, accountByEmail, shares } = setup({ owns: false });
    expect(await access.share("mallory", 1, input)).toEqual({ found: false });
    expect(await access.list("mallory", 1, DOC)).toEqual({ found: false });
    expect(await access.unshare("mallory", 1, { docId: DOC, accountId: "grace" })).toEqual({ found: false });
    expect(documentIn).not.toHaveBeenCalled();
    expect(accountByEmail).not.toHaveBeenCalled();
    expect(shares.set).not.toHaveBeenCalled();
    expect(shares.remove).not.toHaveBeenCalled();
  });

  it("shares a document with the account at that address, at that role, as the owner", async () => {
    const { access, shares } = setup();
    expect(await access.share("alice", 1, input)).toEqual({ found: true, result: { ok: true } });
    expect(shares.set).toHaveBeenCalledWith(1, DOC, "grace", "comment", "alice");
  });

  it("says the same, and stores nothing, for an address with no account and for oneself", async () => {
    const { access, shares } = setup({ accounts: { "grace@example.com": { id: "grace", name: "Grace", email: "grace@example.com" }, "alice@example.com": { id: "alice", name: "Alice", email: "alice@example.com" } } });
    const known = await access.share("alice", 1, input);
    const unknown = await access.share("alice", 1, { ...input, email: "nobody@example.com" });
    const oneself = await access.share("alice", 1, { ...input, email: "alice@example.com" });
    expect(unknown).toEqual(known);
    expect(oneself).toEqual(known);
    expect(shares.set).toHaveBeenCalledTimes(1);
  });

  it("refuses a note, and an id that is not there, whatever the address", async () => {
    for (const [kind, reason] of [["note", "not_a_document"], ["gone", "gone"], ["unavailable", "unavailable"]] as const) {
      const { access, accountByEmail, shares } = setup({ kind });
      expect(await access.share("alice", 1, input)).toEqual({ found: true, result: { ok: false, reason } });
      expect(await access.share("alice", 1, { ...input, email: "nobody@example.com" })).toEqual({ found: true, result: { ok: false, reason } });
      expect(accountByEmail).not.toHaveBeenCalled();
      expect(shares.set).not.toHaveBeenCalled();
    }
  });

  it("refuses at the cap before it looks the address up, so the cap is no way to tell addresses apart", async () => {
    const { access, accountByEmail, shares } = setup({ count: MAX_SHARES_PER_DOCUMENT });
    const known = await access.share("alice", 1, input);
    const unknown = await access.share("alice", 1, { ...input, email: "nobody@example.com" });
    expect(known).toEqual({ found: true, result: { ok: false, reason: "too_many" } });
    expect(unknown).toEqual(known);
    expect(accountByEmail).not.toHaveBeenCalled();
    expect(shares.set).not.toHaveBeenCalled();
  });
});

describe("who a document is shared with, and stopping", () => {
  it("lists the accounts that still exist, with their names, and not the ones that are gone", async () => {
    const { access } = setup();
    expect(await access.list("alice", 1, DOC)).toEqual({ found: true, result: { ok: true, shares: [{ accountId: "grace", name: "Grace", email: "grace@example.com", role: "view" }] } });
  });

  it("stops sharing with an account, and says whether there was a share", async () => {
    const { access, shares } = setup();
    expect(await access.unshare("alice", 1, { docId: DOC, accountId: "grace" })).toEqual({ found: true, result: { ok: true, removed: true } });
    expect(shares.remove).toHaveBeenCalledWith(1, DOC, "grace");
    shares.remove.mockResolvedValueOnce(false);
    expect(await access.unshare("alice", 1, { docId: DOC, accountId: "grace" })).toEqual({ found: true, result: { ok: true, removed: false } });
  });
});
