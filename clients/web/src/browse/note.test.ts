import { describe, expect, it } from "vitest";
import { MemoryProvider } from "../providers/memory";
import type { Provider, RepositoryRef } from "../providers/types";
import { MAX_NOTE_BYTES, readNoteText } from "./note";
import type { RepositoryRead } from "./repository";

/**
 * A note's text for the editor (ROADMAP 1b.2): the file, exactly, or a reason it is not shown. What matters here is what
 * it will not do: change a byte of a note it does show, and show as text what is not.
 */
const REF: RepositoryRef = { owner: "acme", name: "notes" };

function repository(files: Record<string, string | Uint8Array>) {
  const host = new MemoryProvider();
  host.createRepository(REF);
  const commit = host.seed(REF, files);
  return { host, commit };
}

async function readOf(host: MemoryProvider, commit: string, listed: boolean): Promise<RepositoryRead> {
  const tree = await host.getTree(REF, commit);
  const blobs = new Map<string, string>();
  if (listed) for (const entry of tree.entries) if (entry.kind === "file") blobs.set(entry.path, entry.id);
  return { commit, branch: "main", manifest: null, discovery: { vaults: [], nested: [] }, partial: !listed, blobs, manifests: {} };
}

describe("readNoteText", () => {
  it("gives the file's text exactly: line endings, a byte order mark, no final newline, odd characters", async () => {
    for (const text of ["# Title\n\nbody\n", "a\r\nb\r\nc", "﻿with a BOM\r\n", "mixed\r\nand\nand\rlone", "nul\u0000 ls  ps ", "café é", "", "\n\n\n"]) {
      const { host, commit } = repository({ "Public/n.md": text });
      const read = await readOf(host, commit, true);
      expect(await readNoteText(host, REF, read, "Public/n.md"), JSON.stringify(text)).toEqual({ ok: true, text, blob: read.blobs.get("Public/n.md") });
    }
  });

  it("finds a file the listing did not name, in its directory", async () => {
    const { host, commit } = repository({ "Public/deep/er/n.md": "found it\n" });
    const read = await readOf(host, commit, false);
    expect(await readNoteText(host, REF, read, "Public/deep/er/n.md")).toEqual({ ok: true, text: "found it\n", blob: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  it("does not show as text what is not: bytes that are not UTF-8", async () => {
    const { host, commit } = repository({ "n.md": Uint8Array.from([0x68, 0x69, 0xff, 0xfe, 0x0a]) });
    const result = await readNoteText(host, REF, await readOf(host, commit, true), "n.md");
    expect(result).toMatchObject({ ok: false, reason: "not_text" });
  });

  it("does not open a note larger than the limit", async () => {
    const { host, commit } = repository({ "big.md": "x".repeat(MAX_NOTE_BYTES + 1), "edge.md": "y".repeat(MAX_NOTE_BYTES) });
    const read = await readOf(host, commit, true);
    expect(await readNoteText(host, REF, read, "big.md")).toMatchObject({ ok: false, reason: "too_large" });
    expect(await readNoteText(host, REF, read, "edge.md")).toMatchObject({ ok: true });
  });

  it("says so when the note is no longer there", async () => {
    const { host, commit } = repository({ "Public/n.md": "x" });
    expect(await readNoteText(host, REF, await readOf(host, commit, true), "Public/gone.md")).toMatchObject({ ok: false, reason: "gone" });
    expect(await readNoteText(host, REF, await readOf(host, commit, false), "Nowhere/gone.md")).toMatchObject({ ok: false, reason: "gone" });
  });

  it("asks for no directory when the listing already named the file", async () => {
    const { host, commit } = repository({ "Public/n.md": "x" });
    let listings = 0;
    const counting: Provider = new Proxy(host, {
      get(target, property, receiver) {
        if (property === "listDirectory") return async (...args: Parameters<Provider["listDirectory"]>) => (listings++, target.listDirectory(...args));
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const read = await readOf(host, commit, true);
    expect(await readNoteText(counting, REF, read, "Public/n.md")).toEqual({ ok: true, text: "x", blob: read.blobs.get("Public/n.md") });
    expect(listings).toBe(0);
  });

  it("says the note is gone when the host no longer has the blob the listing named", async () => {
    const { host, commit } = repository({ "n.md": "x" });
    const read = await readOf(host, commit, true);
    read.blobs.set("n.md", "0".repeat(40));
    expect(await readNoteText(host, REF, read, "n.md")).toMatchObject({ ok: false, reason: "gone" });
  });

  it("lets a failure of the host through, to be told as one", async () => {
    const { host, commit } = repository({ "n.md": "x" });
    const down: Provider = new Proxy(host, {
      get(target, property, receiver) {
        if (property === "readBlob") return async () => Promise.reject(new Error("the host fell over"));
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(readNoteText(down, REF, await readOf(host, commit, true), "n.md")).rejects.toThrow("fell over");
  });
});
