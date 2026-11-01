import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wasmAvailable, wasmDirectory } from "../format/wasm";
import { whyNotCiphertext } from "../working/ciphertext";
import { fromBase64, openCiphertext, sealText, toBase64 } from "./files";
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

  it("round-trips base64 for large bytes", () => {
    const bytes = new Uint8Array(100_000).map((_, at) => at % 251);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });
});
