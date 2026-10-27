import { describe, expect, it, vi } from "vitest";
import { type AccessDeps, filesAccess } from "./access";

/** Whose, and where (`access.ts`), with stand-ins for the connection and the repository. */
const WHEN = { year: 2026, month: 10, day: 22, hour: 14, minute: 30 };
const input = { vault: "Notes", folder: "", kind: "note" as const, title: "Plan", localMinute: WHEN, author: { name: "Alice", email: "alice@example.com" } };

function setup(over: { owns?: boolean; vault?: Awaited<ReturnType<AccessDeps["vaultFor"]>>; vaults?: Record<string, Awaited<ReturnType<AccessDeps["vaultFor"]>>> } = {}) {
  const owns = vi.fn(async (..._args: unknown[]) => over.owns ?? true);
  const vaultFor = vi.fn(async (_a: string, _i: number, vault: string) => over.vaults?.[vault] ?? over.vault ?? ("ok" as const));
  const create = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, path: "Notes/Plan.md", commit: "c".repeat(40) }));
  const remove = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, commit: "d".repeat(40), files: 1, deletions: [1] }));
  const restore = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, commit: "e".repeat(40), paths: ["Notes/Plan.md"] }));
  const setTitle = vi.fn((header: string, title: string): string | undefined => (header.includes("broken") ? undefined : `${header}title: ${title}\n`));
  const move = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, commit: "f".repeat(40), files: 1, moved: [{ from: "Notes/a.md", to: "Other/a.md" }] }));
  const access = filesAccess({
    owns: (a, i) => owns(a, i),
    setTitle: (header, title) => setTitle(header, title),
    vaultFor: (a, i, v) => vaultFor(a, i, v),
    create: (a, i, x) => create(a, i, x),
    delete: (a, i, x) => remove(a, i, x),
    restore: (a, i, x) => restore(a, i, x),
    move: (a, i, x) => move(a, i, x),
  });
  return { access, owns, vaultFor, create, remove, restore, setTitle, move };
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

describe("changing a header's title", () => {
  it("is for the caller's own connection only: another's is not found, and the header is not touched", async () => {
    const { access, setTitle } = setup({ owns: false });
    expect(await access.header("mallory", 1, { header: "---\n", title: "x" })).toEqual({ found: false });
    expect(setTitle).not.toHaveBeenCalled();
  });

  it("gives the header the module wrote, or says it cannot be read", async () => {
    const { access } = setup();
    expect(await access.header("alice", 1, { header: "---\n", title: "x" })).toEqual({ found: true, result: { ok: true, header: "---\ntitle: x\n" } });
    expect(await access.header("alice", 1, { header: "broken", title: "x" })).toEqual({ found: true, result: { ok: false, reason: "unreadable" } });
  });
});

describe("renaming and moving", () => {
  const input = { vault: "Notes", target: { type: "file" as const, path: "Notes/a.md", blob: "b".repeat(40) }, destination: "Other/a.md", author: { name: "Alice", email: "alice@example.com" } };

  it("is for the caller's own connection only: another's is not found, and no vault is asked about", async () => {
    const { access, vaultFor, move } = setup({ owns: false });
    expect(await access.move("mallory", 1, input)).toEqual({ found: false });
    expect(vaultFor).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it("asks of both vaults, the one it is in and the one it goes to, and says which was refused", async () => {
    const encrypted = setup({ vaults: { Other: "encrypted_vault" } });
    expect(await encrypted.access.move("alice", 1, input)).toEqual({ found: true, result: { ok: false, reason: "encrypted_vault", where: "destination" } });
    const from = setup({ vaults: { Notes: "unsupported_vault" } });
    expect(await from.access.move("alice", 1, input)).toEqual({ found: true, result: { ok: false, reason: "unsupported_vault", where: "source" } });
    const unknown = setup({ vaults: { Other: "unknown_vault" } });
    expect(await unknown.access.move("alice", 1, input)).toEqual({ found: true, result: { ok: false, reason: "unknown_vault", where: "destination" } });
    for (const refused of [encrypted, from, unknown]) expect(refused.move).not.toHaveBeenCalled();
  });

  it("moves when both are fine, asking of the destination only when it is another vault", async () => {
    const { access, vaultFor, move } = setup();
    expect((await access.move("alice", 1, input)).found).toBe(true);
    expect(vaultFor).toHaveBeenCalledTimes(2);
    expect(move).toHaveBeenCalledWith("alice", 1, input);
    vaultFor.mockClear();
    await access.move("alice", 1, { ...input, destination: "Notes/Sub/a.md" });
    expect(vaultFor).toHaveBeenCalledTimes(1);
  });
});
