import { describe, expect, it, vi } from "vitest";
import { type AccessDeps, filesAccess } from "./access";

/** Whose, and where (`access.ts`), with stand-ins for the connection and the repository. */
const WHEN = { year: 2026, month: 10, day: 22, hour: 14, minute: 30 };
const input = { vault: "Notes", folder: "", kind: "note" as const, title: "Plan", localMinute: WHEN, author: { name: "Alice", email: "alice@example.com" } };

function setup(over: { owns?: boolean; vault?: Awaited<ReturnType<AccessDeps["vaultFor"]>> } = {}) {
  const owns = vi.fn(async (..._args: unknown[]) => over.owns ?? true);
  const vaultFor = vi.fn(async (..._args: unknown[]) => over.vault ?? ("ok" as const));
  const create = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, path: "Notes/Plan.md", commit: "c".repeat(40) }));
  const remove = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, commit: "d".repeat(40), files: 1, deletions: [1] }));
  const restore = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, commit: "e".repeat(40), paths: ["Notes/Plan.md"] }));
  const access = filesAccess({
    owns: (a, i) => owns(a, i),
    vaultFor: (a, i, v) => vaultFor(a, i, v),
    create: (a, i, x) => create(a, i, x),
    delete: (a, i, x) => remove(a, i, x),
    restore: (a, i, x) => restore(a, i, x),
  });
  return { access, owns, vaultFor, create, remove, restore };
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

describe("deleting", () => {
  const input = { vault: "Notes", target: { type: "file" as const, path: "Notes/Plan.md", blob: "a".repeat(40) }, author: { name: "Alice", email: "alice@example.com" } };

  it("is for the caller's own connection only: another's is not found, and nothing is read or deleted", async () => {
    const { access, vaultFor, remove } = setup({ owns: false });
    expect(await access.delete("mallory", 1, input)).toEqual({ found: false });
    expect(vaultFor).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("is done for the connection asked, by the caller, in a vault that is written to", async () => {
    const { access, vaultFor, remove } = setup();
    expect(await access.delete("alice", 7, input)).toEqual({ found: true, result: { ok: true, commit: "d".repeat(40), files: 1, deletions: [1] } });
    expect(vaultFor).toHaveBeenCalledWith("alice", 7, "Notes");
    expect(remove).toHaveBeenCalledWith("alice", 7, input);
  });

  it.each(["unknown_vault", "encrypted_vault", "unsupported_vault", "unavailable"] as const)("is not done in a vault that is %s, and the reason is told", async (vault) => {
    const { access, remove } = setup({ vault });
    expect(await access.delete("alice", 1, input)).toEqual({ found: true, result: { ok: false, reason: vault } });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("putting back", () => {
  const input = { ids: [1, 2], path: undefined, author: { name: "Alice", email: "alice@example.com" } };

  it("is for the caller's own connection only: another's is not found, and nothing is put back", async () => {
    const { access, restore } = setup({ owns: false });
    expect(await access.restore("mallory", 1, input)).toEqual({ found: false });
    expect(restore).not.toHaveBeenCalled();
  });

  it("is done for the connection asked, by the caller", async () => {
    const { access, restore } = setup();
    expect(await access.restore("alice", 7, input)).toEqual({ found: true, result: { ok: true, commit: "e".repeat(40), paths: ["Notes/Plan.md"] } });
    expect(restore).toHaveBeenCalledWith("alice", 7, input);
  });
});
