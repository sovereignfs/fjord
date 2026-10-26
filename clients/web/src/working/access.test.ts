import { describe, expect, it, vi } from "vitest";
import { type AccessDeps, workingCopyAccess } from "./access";
import type { WorkingCopy } from "./service";

/**
 * The repository's rules for a draft (`access.ts`), with stand-ins for the database and the host: whose it may be,
 * when the host is asked, and who it is attributed to.
 */
const INPUT = { path: "Notes/a.md", baseBlob: "a".repeat(40), content: "text" };
const COPY: WorkingCopy = { path: "Notes/a.md", baseBlob: INPUT.baseBlob, content: "text", editors: [{ type: "account", id: "alice" }], createdAt: 1, lastEdit: 2 };

function setup(over: { owns?: boolean; existing?: WorkingCopy; editable?: "yes" | "no" | "unavailable" } = {}) {
  const service = {
    get: vi.fn(async (..._args: unknown[]) => over.existing),
    save: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, workingCopy: COPY })),
    discard: vi.fn(async (..._args: unknown[]) => true),
  };
  const owns = vi.fn(async (..._args: unknown[]) => over.owns ?? true);
  const editableNote = vi.fn(async (..._args: unknown[]) => over.editable ?? "yes");
  const deps: AccessDeps = { service: service as never, owns, editableNote: (a, i, p) => editableNote(a, i, p) };
  return { access: workingCopyAccess(deps), service, owns, editableNote };
}

describe("whose", () => {
  it("another account's connection is not found, and nothing is read, kept or thrown away", async () => {
    const { access, service, editableNote } = setup({ owns: false });
    expect(await access.save("mallory", 1, INPUT)).toEqual({ found: false });
    expect(await access.discard("mallory", 1, "Notes/a.md")).toEqual({ found: false });
    expect(service.get).not.toHaveBeenCalled();
    expect(service.save).not.toHaveBeenCalled();
    expect(service.discard).not.toHaveBeenCalled();
    expect(editableNote).not.toHaveBeenCalled();
  });

  it("is kept for the connection asked, attributed to the caller", async () => {
    const { access, service } = setup();
    await access.save("alice", 7, INPUT);
    expect(service.save).toHaveBeenCalledWith(7, "Notes/a.md", { baseBlob: INPUT.baseBlob, content: "text" }, { type: "account", id: "alice" });
  });

  it("is thrown away for the connection asked", async () => {
    const { access, service } = setup();
    expect(await access.discard("alice", 7, "Notes/a.md")).toEqual({ found: true });
    expect(service.discard).toHaveBeenCalledWith(7, "Notes/a.md");
  });
});

describe("starting a draft", () => {
  it("asks the host once, for a file with no draft yet, and keeps it when it is an editable note", async () => {
    const { access, service, editableNote } = setup({ editable: "yes" });
    expect(await access.save("alice", 1, INPUT)).toEqual({ found: true, result: { ok: true, workingCopy: COPY } });
    expect(editableNote).toHaveBeenCalledWith("alice", 1, "Notes/a.md");
    expect(service.save).toHaveBeenCalledOnce();
  });

  it("refuses a file that is not an editable note, and keeps nothing", async () => {
    const { access, service } = setup({ editable: "no" });
    expect(await access.save("alice", 1, INPUT)).toEqual({ found: true, result: { ok: false, reason: "not_editable" } });
    expect(service.save).not.toHaveBeenCalled();
  });

  it("says so when the host could not be asked, and keeps nothing", async () => {
    const { access, service } = setup({ editable: "unavailable" });
    expect(await access.save("alice", 1, INPUT)).toEqual({ found: true, result: { ok: false, reason: "unavailable" } });
    expect(service.save).not.toHaveBeenCalled();
  });
});

describe("saving a draft that exists", () => {
  it("does not ask the host: it was checked when it was started", async () => {
    const { access, service, editableNote } = setup({ existing: COPY, editable: "no" });
    expect(await access.save("alice", 1, INPUT)).toMatchObject({ found: true, result: { ok: true } });
    expect(editableNote).not.toHaveBeenCalled();
    expect(service.save).toHaveBeenCalledOnce();
  });

  it("looks for the draft of this connection and this path", async () => {
    const { access, service } = setup({ existing: COPY });
    await access.save("alice", 3, INPUT);
    expect(service.get).toHaveBeenCalledWith(3, "Notes/a.md");
  });
});
