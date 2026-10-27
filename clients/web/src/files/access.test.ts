import { describe, expect, it, vi } from "vitest";
import { type AccessDeps, filesAccess } from "./access";

/** Whose, and where (`access.ts`), with stand-ins for the connection and the repository. */
const WHEN = { year: 2026, month: 10, day: 22, hour: 14, minute: 30 };
const input = { vault: "Notes", folder: "", kind: "note" as const, title: "Plan", localMinute: WHEN, author: { name: "Alice", email: "alice@example.com" } };

function setup(over: { owns?: boolean; vault?: Awaited<ReturnType<AccessDeps["vaultFor"]>> } = {}) {
  const owns = vi.fn(async (..._args: unknown[]) => over.owns ?? true);
  const vaultFor = vi.fn(async (..._args: unknown[]) => over.vault ?? ("ok" as const));
  const create = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, path: "Notes/Plan.md", commit: "c".repeat(40) }));
  const access = filesAccess({ owns: (a, i) => owns(a, i), vaultFor: (a, i, v) => vaultFor(a, i, v), create: (a, i, x) => create(a, i, x) });
  return { access, owns, vaultFor, create };
}

describe("making a file", () => {
  it("is for the caller's own connection only: another's is not found, and nothing is read or made", async () => {
    const { access, vaultFor, create } = setup({ owns: false });
    expect(await access.create("mallory", 1, input)).toEqual({ found: false });
    expect(vaultFor).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("is made for the connection asked, in the vault asked, by the caller", async () => {
    const { access, vaultFor, create } = setup();
    expect(await access.create("alice", 7, input)).toEqual({ found: true, result: { ok: true, path: "Notes/Plan.md", commit: "c".repeat(40) } });
    expect(vaultFor).toHaveBeenCalledWith("alice", 7, "Notes");
    expect(create).toHaveBeenCalledWith("alice", 7, input);
  });

  it.each(["unknown_vault", "encrypted_vault", "unsupported_vault", "unavailable"] as const)("is not made in a vault that is %s, and the reason is told", async (vault) => {
    const { access, create } = setup({ vault });
    expect(await access.create("alice", 1, input)).toEqual({ found: true, result: { ok: false, reason: vault } });
    expect(create).not.toHaveBeenCalled();
  });
});
