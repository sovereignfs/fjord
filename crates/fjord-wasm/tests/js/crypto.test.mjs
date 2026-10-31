// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Encryption from JavaScript (ROADMAP web P8): that what the module writes is what `age -d` reads and the reverse, which is the
// promise that makes a file recoverable without Fjord, and that the container refuses what spec §6.4 says to.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { wasm } from "./helpers.mjs";

const have = (command) => spawnSync(command, ["--version"]).status === 0;
const text = (bytes) => new TextDecoder().decode(bytes);
const bytes = (value) => new TextEncoder().encode(value);

test("an identity makes its recipient, and what is encrypted to it is read by it and by nobody else", () => {
  const identity = wasm.generateIdentity();
  assert.ok(text(identity).startsWith("AGE-SECRET-KEY-1"));
  const recipient = wasm.identityRecipient(identity);
  assert.match(recipient, /^age1[a-z0-9]{58}$/);
  assert.equal(wasm.checkRecipient(recipient), undefined);

  const sealed = wasm.encrypt(bytes("a document ✓"), `# a comment\n${recipient}\n`, false);
  assert.ok(wasm.isWellFormed(sealed));
  assert.equal(text(wasm.decrypt(sealed, identity)), "a document ✓");
  assert.throws(() => wasm.decrypt(sealed, wasm.generateIdentity()), /./);
  identity.fill(0);
});

test("a call that is wrong is refused, in words, and a secret is refused as a recipient", () => {
  const identity = wasm.generateIdentity();
  assert.throws(() => wasm.encrypt(bytes("x"), "# nobody\n", false), /recipient/i);
  assert.throws(() => wasm.decrypt(bytes("not age"), identity), /./);
  assert.match(wasm.checkRecipient(text(identity)), /secret key/);
  assert.match(wasm.checkRecipient("age1nope"), /age public key/);
  assert.equal(wasm.isWellFormed(bytes("plain")), false);
});

test("a file encrypted here is decrypted by the real age, and one encrypted by the real age is decrypted here", { skip: !have("age") && "age is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fjord-wasm-age-"));
  try {
    const identity = wasm.generateIdentity();
    const recipient = wasm.identityRecipient(identity);
    const keyFile = join(dir, "key.txt");
    writeFileSync(keyFile, `# public key: ${recipient}\n${text(identity)}\n`, { mode: 0o600 });

    for (const armor of [false, true]) {
      const sealed = wasm.encrypt(bytes(`from the module, armor=${armor}\n`), recipient, armor);
      writeFileSync(join(dir, "sealed.age"), sealed);
      const opened = execFileSync("age", ["-d", "-i", keyFile, join(dir, "sealed.age")]);
      assert.equal(text(opened), `from the module, armor=${armor}\n`);
    }

    writeFileSync(join(dir, "plain.txt"), "from age\n");
    execFileSync("age", ["-r", recipient, "-o", join(dir, "theirs.age"), join(dir, "plain.txt")]);
    assert.equal(text(wasm.decrypt(readFileSync(join(dir, "theirs.age")), identity)), "from age\n");
    execFileSync("age", ["-a", "-r", recipient, "-o", join(dir, "theirs-armored.age"), join(dir, "plain.txt")]);
    assert.equal(text(wasm.decrypt(readFileSync(join(dir, "theirs-armored.age")), identity)), "from age\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an identity from age-keygen is read, and its recipient is the one age-keygen printed", { skip: !have("age-keygen") && "age-keygen is not installed" }, () => {
  const made = spawnSync("age-keygen", { encoding: "utf8" });
  const file = made.stdout;
  const printed = /Public key: (age1\w+)/.exec(made.stderr)?.[1] ?? /public key: (age1\w+)/.exec(file)?.[1];
  assert.ok(printed, "age-keygen printed a public key");
  assert.equal(wasm.identityRecipient(bytes(file)), printed);
});

test("the container carries one file under its own name and gives it back", () => {
  const archive = wasm.wrapContainer("01j8z3k9t2v4w5x6y7z8a9b0c1.md", bytes("# Title\n"));
  const unwrapped = wasm.unwrapContainer(archive);
  assert.equal(unwrapped.name, "01j8z3k9t2v4w5x6y7z8a9b0c1.md");
  assert.equal(text(unwrapped.contents), "# Title\n");
  assert.throws(() => wasm.wrapContainer("dir/name.md", bytes("x")), /./);
  assert.throws(() => wasm.wrapContainer("../name.md", bytes("x")), /./);
});

test("the container refuses what spec §6.4 says to: more than one entry, a path in the name, anything but a regular file", { skip: !have("tar") && "tar is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fjord-wasm-tar-"));
  const archive = (...args) => {
    // COPYFILE_DISABLE: macOS tar adds an AppleDouble `._name` entry per file unless told not to, which would make every archive two.
    execFileSync("tar", ["-cf", join(dir, "a.tar"), "-C", dir, ...args], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    return readFileSync(join(dir, "a.tar"));
  };
  try {
    writeFileSync(join(dir, "one.md"), "1");
    writeFileSync(join(dir, "two.md"), "2");
    execFileSync("mkdir", [join(dir, "sub")]);
    writeFileSync(join(dir, "sub", "in.md"), "3");

    assert.ok(wasm.unwrapContainer(archive("one.md")), "one regular file is fine");
    assert.throws(() => wasm.unwrapContainer(archive("one.md", "two.md")), /./, "two entries");
    assert.throws(() => wasm.unwrapContainer(archive("sub/in.md")), /./, "a directory in the name");
    assert.throws(() => wasm.unwrapContainer(archive("sub")), /./, "a directory is not a regular file");
    assert.throws(() => wasm.unwrapContainer(bytes("not a tar at all")), /./);
    assert.throws(() => wasm.unwrapContainer(new Uint8Array(0)), /./, "an empty archive holds no file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an identity is sealed with a passphrase and opened with it, and the cost of the real work factor in this runtime is recorded", () => {
  const identity = wasm.generateIdentity();
  const passphrase = bytes("correct horse battery staple");
  const quick = wasm.sealWithPassphrase(identity, passphrase, 10);
  assert.ok(wasm.isWellFormed(quick));
  assert.deepEqual(wasm.openWithPassphrase(quick, passphrase), identity);
  assert.throws(() => wasm.openWithPassphrase(quick, bytes("battery horse")), /./);
  assert.throws(() => wasm.sealWithPassphrase(identity, new Uint8Array(0), 10), /./);
  assert.throws(() => wasm.sealWithPassphrase(identity, passphrase, 21), /work factor/);

  const factor = wasm.passphraseWorkFactor();
  assert.equal(factor, 18);
  const started = performance.now();
  const sealed = wasm.sealWithPassphrase(identity, passphrase, factor);
  const sealMs = performance.now() - started;
  const opened = performance.now();
  assert.deepEqual(wasm.openWithPassphrase(sealed, passphrase), identity);
  console.log(`# scrypt log2(N)=${factor} in this runtime: seal ${Math.round(sealMs)} ms, open ${Math.round(performance.now() - opened)} ms`);
});
