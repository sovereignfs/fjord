import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wasmAvailable, wasmDirectory } from "../format/wasm";
import { decryptFiles, encryptFiles } from "./convert";
import { toBase64 } from "./files";
import type { CryptoModule } from "./module";

/** Converting a vault's files in the browser (RFC 0003), with the real module: sealed and proved, opened and named, and wiped. */
const available = wasmAvailable();
const load = () => createRequire(import.meta.url)(join(wasmDirectory(), "fjord_wasm.js")) as CryptoModule;

function person() {
  const module = load();
  const identity = module.generateIdentity();
  const recipient = `${module.identityRecipient(identity)}\n`;
  return { module, recipient, keys: { with: <T,>(use: (secret: Uint8Array) => T) => use(identity) } };
}
const file = (path: string, bytes: Uint8Array | string) => ({ path, blob: "a".repeat(40), content: toBase64(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes) });

describe.runIf(available)("a vault's files, encrypted", () => {
  it("are sealed to `<name>.age`, binary ones too, and each is proved to open to what it was", () => {
    const { module, recipient, keys } = person();
    const binary = new Uint8Array([0, 255, 1, 2, 3]);
    const sent = encryptFiles(module, keys, { files: [file("Notes/a.md", "SECRET PLAINTEXT"), file("Notes/Deep/pic.png", binary)], recipients: recipient });
    expect(sent.map((s) => [s.path, s.to])).toEqual([["Notes/a.md", "Notes/a.md.age"], ["Notes/Deep/pic.png", "Notes/Deep/pic.png.age"]]);
    for (const s of sent) expect(Buffer.from(s.content, "base64").toString("latin1")).not.toContain("SECRET PLAINTEXT");
    expect(module.decrypt(new Uint8Array(Buffer.from(sent[1]!.content, "base64")), (keys.with((secret) => secret) as Uint8Array))).toEqual(binary);
  });

  it("are refused, and nothing is sent, when the identity is not one of the recipients", () => {
    const [mine, other] = [person(), person()];
    expect(() => encryptFiles(mine.module, mine.keys, { files: [file("Notes/a.md", "x")], recipients: other.recipient })).toThrow(/not one of the recipients/);
  });
});

describe.runIf(available)("a vault's files, decrypted", () => {
  it("lose `.age`, and in an id-named vault take the name that was inside the container", () => {
    const { module, recipient, keys } = person();
    const plainNamed = module.encrypt(new TextEncoder().encode("hello"), recipient, false);
    const idNamed = module.encrypt(module.wrapContainer("Real name.md", new TextEncoder().encode("secret")), recipient, false);
    const plain = decryptFiles(module, keys, { files: [file("Notes/Deep/a.md.age", plainNamed)], naming: "plain" });
    expect([plain[0]!.to, Buffer.from(plain[0]!.content, "base64").toString()]).toEqual(["Notes/Deep/a.md", "hello"]);
    const byId = decryptFiles(module, keys, { files: [file("Sealed/Sub/01jagc4k7pr9tbm3ykwx6zq2hz.age", idNamed)], naming: "id" });
    expect([byId[0]!.to, Buffer.from(byId[0]!.content, "base64").toString()]).toEqual(["Sealed/Sub/Real name.md", "secret"]);
  });

  it("is refused for a file the identity cannot open", () => {
    const [mine, other] = [person(), person()];
    const theirs = other.module.encrypt(new TextEncoder().encode("x"), other.recipient, false);
    expect(() => decryptFiles(mine.module, mine.keys, { files: [file("Notes/a.md.age", theirs)], naming: "plain" })).toThrow(/cannot open/);
  });
});
