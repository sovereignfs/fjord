import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wasmAvailable, wasmDirectory } from "../format/wasm";
import { fromBase64, openCiphertext } from "../keys/files";
import type { CryptoModule } from "../keys/module";
import { newEncryptedEntry } from "./seal";

/** An encrypted journal's new entry, as the page writes it (ROADMAP 3b.1): dated in the writer's time, and nothing of it outside the ciphertext. */
const available = wasmAvailable();
const load = () => createRequire(import.meta.url)(join(wasmDirectory(), "fjord_wasm.js")) as CryptoModule;

describe.runIf(available)("an encrypted journal's new entry", () => {
  it("is filed in the writer's day folder, which is all of it that is public: its date, time, title and name are inside the ciphertext", () => {
    const module = load();
    const identity = module.generateIdentity();
    const recipients = `${module.identityRecipient(identity)}\n`;
    // A moment just after midnight where this test pretends to be: the offset is the Date's, so fake one that is five and a half hours ahead.
    const now = new Date(1_793_559_600_000 + 30 * 60 * 1000);
    now.getTimezoneOffset = () => -330;
    const sealed = newEncryptedEntry(module, { title: "Night walk", recipients, now, random: new Uint8Array(16).fill(9) });
    expect(sealed.date).toBe("2026-11-02T01:00:00+05:30");
    const bytes = fromBase64(sealed.ciphertext);
    const visible = Buffer.from(bytes).toString("latin1");
    for (const secret of ["2026-11-02", "01-00", "Night walk", "night-walk"]) expect(visible).not.toContain(secret);
    // The day folder is the one thing the server is told (a directory name is never encrypted, and the owner chose that, workstream 0003).
    expect(sealed.folder).toBe("2026-11-02");

    const opened = openCiphertext(module, { with: (use) => use(identity) }, bytes, "id", "01x.age");
    expect(opened.kind).toBe("text");
    if (opened.kind !== "text") return;
    // Named by the writer's day and minute: what is inside the container, which only a key opens. Nothing of the title.
    expect(opened.name).toBe("01-00.md");
    expect(opened.text).toContain('date: "2026-11-02T01:00:00+05:30"');
    expect(opened.text).toContain("title: Night walk");
  });
});
