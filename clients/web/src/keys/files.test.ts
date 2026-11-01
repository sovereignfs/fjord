import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wasmAvailable, wasmDirectory } from "../format/wasm";
import { whyNotCiphertext } from "../working/ciphertext";
import { fromBase64, newEncryptedFile, recipientCount, openCiphertext, prepareTransfer, sealText, toBase64 } from "./files";
import type { CryptoModule } from "./module";
import { KeyError } from "./store";

/** Sealing and opening an encrypted file's text with the real module, as the page does, and the same module the CLI's format shares. */
const available = wasmAvailable();
const load = () => createRequire(import.meta.url)(join(wasmDirectory(), "fjord_wasm.js")) as CryptoModule;

function person() {
  const module = load();
  const identity = module.generateIdentity();
  const recipient = module.identityRecipient(identity);
  return { module, recipient: `${recipient}\n`, keys: { with: <T,>(use: (secret: Uint8Array) => T) => use(identity) } };
}

describe.runIf(available)("an encrypted file's text", () => {
  it.each(["plain", "id"] as const)("is sealed and opened again, in a %s-named vault, with its name and its exact text", (naming) => {
    const { module, recipient, keys } = person();
    const text = "# Title\r\n\r\n SECRET PLAINTEXT ünï 💧 \n\n";
    const sealed = sealText(module, { text, name: "Plan.fj.md", naming, recipients: recipient });
    expect(Buffer.from(sealed).toString("latin1")).not.toContain("SECRET PLAINTEXT");
    expect(Buffer.from(sealed).toString("latin1")).not.toContain("Plan.fj.md");
    expect(openCiphertext(module, keys, sealed, naming, "Plan.fj.md")).toEqual({ kind: "text", name: "Plan.fj.md", text });
  });

  it("is what the server accepts as an encrypted draft, in either naming", () => {
    const { module, recipient } = person();
    for (const naming of ["plain", "id"] as const) {
      const sealed = sealText(module, { text: "x", name: "a.md", naming, recipients: recipient });
      expect(whyNotCiphertext(toBase64(sealed))).toBeUndefined();
    }
  });

  it("is sealed to every recipient, and to nobody else", () => {
    const [ada, grace, eve] = [person(), person(), person()];
    const sealed = sealText(ada.module, { text: "for two", name: "a.md", naming: "plain", recipients: ada.recipient + grace.recipient });
    expect(openCiphertext(ada.module, ada.keys, sealed, "plain", "a.md")).toMatchObject({ text: "for two" });
    expect(openCiphertext(ada.module, grace.keys, sealed, "plain", "a.md")).toMatchObject({ text: "for two" });
    expect(() => openCiphertext(ada.module, eve.keys, sealed, "plain", "a.md")).toThrow(KeyError);
  });

  it("is never sealed to nobody", () => {
    const { module } = person();
    expect(() => sealText(module, { text: "x", name: "a.md", naming: "plain", recipients: "# no keys here\n" })).toThrow();
  });

  it("says that what is not text is not text", () => {
    const { module, recipient, keys } = person();
    const sealed = module.encrypt(new Uint8Array([0xff, 0xfe, 0xfd]), recipient, false);
    expect(openCiphertext(module, keys, sealed, "plain", "a.bin")).toEqual({ kind: "binary", name: "a.bin", bytes: 3 });
  });

  it("is not put in an editor when it is larger than a note can be, in either naming", () => {
    const { module, recipient, keys } = person();
    const big = new Uint8Array(1024 * 1024 + 1).fill(97);
    for (const naming of ["plain", "id"] as const) {
      const plain = naming === "id" ? module.wrapContainer("big.txt", big) : big;
      const sealed = module.encrypt(plain, recipient, false);
      expect(openCiphertext(module, keys, sealed, naming, "big.txt")).toEqual({ kind: "large", name: "big.txt", bytes: big.length });
    }
    const small = module.encrypt(new Uint8Array(1024 * 1024).fill(97), recipient, false);
    expect(openCiphertext(module, keys, small, "plain", "ok.txt")).toMatchObject({ kind: "text" });
  });

  it("round-trips base64 for large bytes", () => {
    const bytes = new Uint8Array(100_000).map((_, at) => at % 251);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });
});

describe.runIf(available)("a new file for an encrypted vault", () => {
  const when = { year: 2026, month: 10, day: 22, hour: 14, minute: 30 };
  const make = (over: Partial<Parameters<typeof newEncryptedFile>[1]> = {}) => {
    const { module, recipient, keys } = person();
    const made = newEncryptedFile(module, { kind: "note", title: "", naming: "plain", recipients: recipient, when, now: 1_800_000_000_000, random: new Uint8Array(16).fill(7), ...over });
    return { module, keys, made };
  };

  it("is a note that is its title as a heading, or empty, and the server accepts it as ciphertext", () => {
    const { module, keys, made } = make({ title: "  Plan  " });
    expect(made).toMatchObject({ ok: true });
    const ciphertext = (made as { ciphertext: string }).ciphertext;
    expect(whyNotCiphertext(ciphertext)).toBeUndefined();
    expect(openCiphertext(module, keys, fromBase64(ciphertext), "plain", "Plan.md")).toEqual({ kind: "text", name: "Plan.md", text: "# Plan\n" });
    const empty = make();
    expect(openCiphertext(empty.module, empty.keys, fromBase64((empty.made as { ciphertext: string }).ciphertext), "plain", "x.md")).toMatchObject({ text: "" });
  });

  it("is a document with the format's own header, its title and a heading", () => {
    const { module, keys, made } = make({ kind: "document", title: "Q4: plan" });
    const shown = openCiphertext(module, keys, fromBase64((made as { ciphertext: string }).ciphertext), "plain", "x.fj.md") as { text: string };
    expect(shown.text).toMatch(/^---\nid: [0-9a-hjkmnp-tv-z]{26}\ntitle: ["']?Q4: plan["']?\ncreated: 2027-01-15T08:00:00Z\n---\n/);
    expect(shown.text).toContain("# Q4: plan");
  });

  it("is refused for a document with nothing to name it by", () => {
    expect(make({ kind: "document", title: "?!" }).made).toEqual({ ok: false, reason: "bad_title" });
  });

  it("keeps the real name inside the container in an id-named vault: from the title, else the date and time", () => {
    const named = make({ kind: "document", title: "Q4 plan", naming: "id" });
    expect(openCiphertext(named.module, named.keys, fromBase64((named.made as { ciphertext: string }).ciphertext), "id", "01j.age")).toMatchObject({ name: "Q4 plan.fj.md" });
    const dated = make({ naming: "id" });
    expect(openCiphertext(dated.module, dated.keys, fromBase64((dated.made as { ciphertext: string }).ciphertext), "id", "01j.age")).toMatchObject({ name: "2026-10-22 1430.md" });
  });
});

describe.runIf(available)("a file moved to another vault (ROADMAP 2b.6)", () => {
  const args = { now: 1_800_000_000_000, random: new Uint8Array(16).fill(7) };

  it("is the same text for a plaintext vault, under its own name", () => {
    const { module } = person();
    expect(prepareTransfer(module, { text: "SECRET ünï", name: "Plan.md", to: { form: "plaintext" }, ...args })).toEqual({ ok: true, leaf: "Plan.md", content: Buffer.from("SECRET ünï").toString("base64") });
  });

  it("is ciphertext for an encrypted vault, called by its name and .age in a plain-named one", () => {
    const { module, recipient, keys } = person();
    const made = prepareTransfer(module, { text: "SECRET PLAINTEXT", name: "Plan.md", to: { form: "encrypted", naming: "plain" }, recipients: { ok: true, text: recipient }, ...args });
    expect(made).toMatchObject({ ok: true, leaf: "Plan.md.age" });
    const content = (made as { content: string }).content;
    expect(whyNotCiphertext(content)).toBeUndefined();
    expect(Buffer.from(content, "base64").toString("latin1")).not.toContain("SECRET PLAINTEXT");
    expect(openCiphertext(module, keys, fromBase64(content), "plain", "Plan.md.age")).toMatchObject({ text: "SECRET PLAINTEXT" });
  });

  it("is called by a new identifier in an id-named vault, with the real name inside", () => {
    const { module, recipient, keys } = person();
    const made = prepareTransfer(module, { text: "x", name: "Plan.md", to: { form: "encrypted", naming: "id" }, recipients: { ok: true, text: recipient }, ...args });
    expect((made as { leaf: string }).leaf).toMatch(/^[0-7][0-9a-hjkmnp-tv-z]{25}\.age$/);
    expect(openCiphertext(module, keys, fromBase64((made as { content: string }).content), "id", "x.age")).toMatchObject({ name: "Plan.md", text: "x" });
  });

  it("makes nothing for a vault with no recipients to encrypt to", () => {
    const { module } = person();
    expect(prepareTransfer(module, { text: "x", name: "Plan.md", to: { form: "encrypted", naming: "plain" }, recipients: { ok: false, message: "no recipients" }, ...args })).toEqual({ ok: false, message: "no recipients" });
    expect(prepareTransfer(module, { text: "x", name: "Plan.md", to: { form: "encrypted", naming: "plain" }, ...args })).toMatchObject({ ok: false });
  });
});

describe("the recipients a file is encrypted to", () => {
  it("are counted from the file: not blank lines, not comments", () => {
    expect(recipientCount("age1aaa\n")).toBe(1);
    expect(recipientCount("# the team\nage1aaa\n\n  # one more\nage1bbb\r\nage1ccc")).toBe(3);
    expect(recipientCount("")).toBe(0);
  });
});
