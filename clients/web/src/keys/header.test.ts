import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wasmAvailable, wasmDirectory } from "../format/wasm";
import { changeHeader, splitDocument } from "./header";
import type { CryptoModule } from "./module";

const load = () => createRequire(import.meta.url)(join(wasmDirectory(), "fjord_wasm.js")) as CryptoModule;
const TEXT = `---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\ntitle: Secret plan\ncreated: "2026-10-16T09:34:00Z"\ncustom: keepme\n---\n\n# Secret plan\n\nThe words.\n`;

/** A decrypted document's header, read and changed in the page with the real format module: nothing of it is for the server (research 0002, G6). */
describe.runIf(wasmAvailable())("an encrypted document's header", () => {
  it("is told from its body, with what it says", () => {
    const found = splitDocument(load(), TEXT)!;
    expect(TEXT.slice(found.bodyStart)).toBe("\n# Secret plan\n\nThe words.\n");
    expect(found.properties).toMatchObject({ id: "01jagc4k7pt8y3wqnmzv5xrb8j", title: "Secret plan" });
    expect(found.properties.others).toEqual(expect.arrayContaining([expect.objectContaining({ key: "custom", value: "keepme" })]));
  });

  it("is not there for a text with none, or one that is not ours to split: it is edited whole", () => {
    expect(splitDocument(load(), "# Just words\n")).toBeNull();
    expect(splitDocument(load(), "---\nnot: [closed\n---\nwords\n")).toBeNull();
  });

  it("changes one thing at a time, and keeps what it does not know", () => {
    const module = load();
    const header = TEXT.slice(0, splitDocument(module, TEXT)!.bodyStart);
    const titled = changeHeader(module, header, { title: "Another" });
    expect(titled).toMatchObject({ ok: true, properties: { title: "Another" } });
    const tagged = changeHeader(module, (titled as { header: string }).header, { tags: ["one", "two/three"] });
    expect(tagged).toMatchObject({ ok: true, properties: { title: "Another", tags: ["one", "two/three"] } });
    const fielded = changeHeader(module, (tagged as { header: string }).header, { field: { key: "mood", value: "good" } });
    expect((fielded as { header: string }).header).toContain("custom: keepme");
    expect((fielded as { header: string }).header).toContain("mood: good");
    const dated = changeHeader(module, (fielded as { header: string }).header, { date: "2026-11-02" });
    expect(dated).toMatchObject({ ok: true, properties: { date: "2026-11-02" } });
  });

  it("refuses a date that is not one, in words", () => {
    const module = load();
    const header = TEXT.slice(0, splitDocument(module, TEXT)!.bodyStart);
    expect(changeHeader(module, header, { date: "soon" })).toMatchObject({ ok: false, message: expect.stringContaining("not a date") });
  });
});
