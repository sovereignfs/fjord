import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ConnectionError, type ConnectionErrorCode } from "../connections/errors";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { checkEncryptedVault } from "../files/create-encrypted";
import type { VaultOptions } from "../format/types";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import { ProviderError } from "../providers/errors";
import { MemoryProvider } from "../providers/memory";
import type { Provider, RepositoryRef } from "../providers/types";
import { forgetBlobTexts } from "./blob-text";
import { type AddVaultDeps, addVault } from "./add-vault";
import { readRepository } from "./repository";
import { TreeCache } from "./tree-cache";

/**
 * Adding a vault to a Fjord repository (ROADMAP 2d.1): what is written, and what is refused. The host is the in-memory
 * provider, the format is the real module, and the cache is on whichever database the leg runs on. As with the setup, the
 * point of most of these is what is *not* done: nothing is written when it is refused, and nothing that was there changes.
 */
const { leg } = testTarget();
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const REF: RepositoryRef = { owner: "acme", name: "notes" };
const TARGET = { id: 9, ref: REF, branch: "main" };
const GUARD = "*.age binary -diff -merge";
/** A public key from the age documentation: valid, and nobody's. */
const KEY = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

const MANIFEST = {
  fjord: 1,
  id: "01m4xrc0000c51260z4rpk8et2",
  name: "notes",
  createdAt: "2026-10-14T17:46:40Z",
  generator: "fjord-web 0.0.0",
  "x-custom": { keep: true },
  vaults: [{ path: "Public", id: "01m4xrc000edx8324fjtet9axj" }],
};
const PUBLIC = { fjord: 1, id: "01m4xrc000edx8324fjtet9axj", name: "Public", createdAt: "2026-10-14T17:46:40Z", encryption: null, fileNaming: "plain" };
const FJORD: Record<string, string> = {
  "fjord.json": `${JSON.stringify(MANIFEST, null, 2)}\n`,
  "Public/fjord.vault.json": JSON.stringify(PUBLIC),
  "Public/hello.md": "# Hello\n",
  ".gitattributes": `${GUARD}\n`,
};

let database: Database;
const cacheTable = () => (database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterAll(async () => database.close());
beforeEach(async () => {
  await dbRun(database, sql`DELETE FROM ${cacheTable()}`);
  forgetBlobTexts();
});

function repository(files: Record<string, string | Uint8Array> = FJORD, options: { canPush?: boolean } = {}) {
  const host = new MemoryProvider();
  host.createRepository(REF, { canPush: options.canPush ?? true });
  host.seed(REF, files);
  return host;
}

const deps = (provider: Provider): AddVaultDeps => ({
  provider,
  cache: new TreeCache(database),
  format: fjord(),
  now: () => 1_793_000_000_000,
  random: () => Uint8Array.from({ length: 16 }, (_, i) => (i * 11 + 5) % 256),
});

const plain = (name: string, extra: Partial<VaultOptions> = {}): VaultOptions => ({ name, encrypted: false, idNaming: false, recipients: [], ...extra });
const secret = (name: string, extra: Partial<VaultOptions> = {}): VaultOptions => ({ name, encrypted: true, idNaming: false, recipients: [KEY], ...extra });

const headOf = async (host: MemoryProvider) => {
  const result = await host.getHead(REF, "main");
  if (!result.changed) throw new Error("no head");
  return result.head.commit;
};

async function textAt(host: MemoryProvider, path: string): Promise<string | undefined> {
  const tree = await host.getTree(REF, await headOf(host));
  const entry = tree.entries.find((candidate) => candidate.path === path && candidate.kind === "file");
  return entry ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(await host.readBlob(REF, entry.id)) : undefined;
}

async function refusal(promise: Promise<unknown>, code: ConnectionErrorCode): Promise<ConnectionError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error instanceof ConnectionError && error.code, `expected ${code}, got ${String(error)}`).toBe(code);
  return error as ConnectionError;
}

describe.skipIf(!available)(`adding a vault (${leg})`, () => {
  it("adds a plaintext vault in one commit, lists it in fjord.json with every other field kept, and changes nothing that was there", async () => {
    const host = repository();
    const before = await headOf(host);
    const beforeTree = await host.getTree(REF, before);

    const done = await addVault(deps(host), TARGET, plain("Journal"));

    const after = await headOf(host);
    expect(after).toBe(done.commit);
    const tree = await host.getTree(REF, after);
    const added = tree.entries.filter((entry) => entry.kind === "file" && !beforeTree.entries.some((old) => old.path === entry.path)).map((entry) => entry.path);
    expect(added).toEqual(["Journal/fjord.vault.json"]);
    // Everything that was there is the same object, but for fjord.json.
    for (const old of beforeTree.entries.filter((entry) => entry.kind === "file" && entry.path !== "fjord.json")) {
      expect(tree.entries.find((entry) => entry.path === old.path)?.id, old.path).toBe(old.id);
    }
    const manifest = JSON.parse((await textAt(host, "fjord.json")) as string);
    expect(manifest["x-custom"], "a field of its own survives").toEqual({ keep: true });
    expect(manifest.vaults).toEqual([...MANIFEST.vaults, { path: "Journal", id: done.vaultId }]);

    const read = await readRepository(deps(host), TARGET);
    expect(read.discovery.vaults.map((vault) => [vault.directory, vault.encrypted, vault.manifestError])).toEqual([
      ["Journal", false, null],
      ["Public", false, null],
    ]);
  });

  it("adds an encrypted vault with its recipients and plaintext guard, writable at once, in one commit", async () => {
    const host = repository();
    const done = await addVault(deps(host), TARGET, secret("Secret"));

    expect(await host.getTree(REF, await headOf(host)).then((tree) => tree.entries.filter((entry) => entry.path.startsWith("Secret/")).map((entry) => entry.path).sort())).toEqual([
      "Secret/.gitignore",
      "Secret/fjord.vault.json",
      "Secret/recipients.txt",
    ]);
    expect(await textAt(host, "Secret/recipients.txt")).toContain(KEY);
    expect(await textAt(host, "Secret/.gitignore")).toContain("!*.age");
    expect(done.vaultId).toMatch(/^[0-9a-z]{26}$/);

    const read = await readRepository(deps(host), TARGET);
    expect(read.discovery.vaults.find((vault) => vault.directory === "Secret")).toMatchObject({ encrypted: true, fileNaming: "plain", manifestError: null });
    expect(checkEncryptedVault(read.discovery.vaults, read.manifests, "Secret")).toMatchObject({ ok: true, target: { naming: "plain", suffix: ".age" } });
  });

  it("names an encrypted vault's files by id when asked, with the tar container the spec requires", async () => {
    const host = repository();
    await addVault(deps(host), TARGET, secret("Vault", { idNaming: true }));
    const read = await readRepository(deps(host), TARGET);
    expect(checkEncryptedVault(read.discovery.vaults, read.manifests, "Vault")).toMatchObject({ ok: true, target: { naming: "id" } });
    expect(JSON.parse((await textAt(host, "Vault/fjord.vault.json")) as string).encryption.container).toBe("tar");
  });

  it("registers a key given twice once, and every key given", async () => {
    const host = repository();
    const other = "age1lggyhqrw2nlhcxprm67z43rta597azn8gknawjehu9d9dl0jq3yqqvfafg";
    await addVault(deps(host), TARGET, secret("Secret", { recipients: [KEY, other, ` ${KEY} `] }));
    const recipients = (await textAt(host, "Secret/recipients.txt")) as string;
    expect(recipients.match(new RegExp(KEY, "g"))).toHaveLength(1);
    expect(recipients).toContain(other);
  });

  it("gives an encrypted vault the merge guard where the repository lacks it, and leaves the rest of .gitattributes byte for byte", async () => {
    const original = "﻿* text=auto\r\n*.png binary\r\n";
    const host = repository({ ...FJORD, ".gitattributes": original });
    await addVault(deps(host), TARGET, secret("Secret"));
    const after = (await textAt(host, ".gitattributes")) as string;
    expect(after.startsWith(original)).toBe(true);
    expect(after.slice(original.length)).toContain(GUARD);

    const { ".gitattributes": _gone, ...without } = FJORD;
    const bare = repository(without);
    await addVault(deps(bare), TARGET, secret("Secret"));
    expect(await textAt(bare, ".gitattributes")).toContain(GUARD);
  });

  it("leaves a .gitattributes that has the guard alone, and never reads one for a plaintext vault", async () => {
    const host = repository();
    const before = await host.getTree(REF, await headOf(host));
    await addVault(deps(host), TARGET, secret("Secret"));
    const after = await host.getTree(REF, await headOf(host));
    expect(after.entries.find((entry) => entry.path === ".gitattributes")?.id).toBe(before.entries.find((entry) => entry.path === ".gitattributes")?.id);

    // A .gitattributes that cannot be read stops an encrypted vault, which needs a line in it, and not a plaintext one, which does not.
    const unreadable = repository({ ...FJORD, ".gitattributes": Uint8Array.from([0x2a, 0x20, 0xff, 0xfe, 0x0a]) });
    const head = await headOf(unreadable);
    await refusal(addVault(deps(unreadable), TARGET, secret("Secret")), "gitattributes_unreadable");
    expect(await headOf(unreadable)).toBe(head);
    await addVault(deps(unreadable), TARGET, plain("Journal"));
    expect(await textAt(unreadable, "Journal/fjord.vault.json")).toBeDefined();
  });

  it("puts the vault in the commit message, and sends one commit on the head that was read, never forced", async () => {
    const host = repository();
    const before = await headOf(host);
    const sent: { branch: string; expectedHead: string; message: string; changes: { path: string }[] }[] = [];
    const recording: Provider = new Proxy(host, {
      get(target, property, receiver) {
        if (property === "commit") {
          return async (...args: Parameters<Provider["commit"]>) => {
            sent.push(args[1] as (typeof sent)[number]);
            return target.commit(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await addVault(deps(recording), TARGET, secret("Secret"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.expectedHead).toBe(before);
    expect(sent[0]?.branch).toBe("main");
    expect(sent[0]?.message.split("\n")[0]).toBe('Add vault "Secret"');
    expect(sent[0]?.changes.map((change) => change.path).sort()).toEqual(["Secret/.gitignore", "Secret/fjord.vault.json", "Secret/recipients.txt", "fjord.json"]);
  });

  it("refuses what cannot be honoured, and writes nothing: a name that is taken or cannot be a directory", async () => {
    const host = repository();
    const before = await headOf(host);
    for (const [name, code] of [
      ["public", "vault_name_taken"],
      ["PUBLIC", "vault_name_taken"],
      ["fjord.json", "vault_name_taken"],
      ["", "invalid_vault_name"],
      [".hidden", "invalid_vault_name"],
      ["a/b", "invalid_vault_name"],
      ["bad:name", "invalid_vault_name"],
      ["CON", "invalid_vault_name"],
    ] as const) {
      await refusal(addVault(deps(host), TARGET, plain(name)), code);
    }
    expect(await headOf(host), "nothing was written").toBe(before);
  });

  it("refuses a combination that would leave a vault readable by everyone or unbrowsable, and a key that is not one, writing nothing", async () => {
    const host = repository();
    const before = await headOf(host);
    await refusal(addVault(deps(host), TARGET, plain("Notes", { recipients: [KEY] })), "invalid_vault_options");
    await refusal(addVault(deps(host), TARGET, plain("Notes", { idNaming: true })), "invalid_vault_options");
    await refusal(addVault(deps(host), TARGET, secret("Secret", { recipients: [KEY, "not a key"] })), "invalid_vault_options");
    // An encrypted vault with no key could not be written to: the web client does not make one.
    const nobody = await refusal(addVault(deps(host), TARGET, secret("Secret", { recipients: [] })), "invalid_vault_options");
    expect(nobody.message).toMatch(/at least one recipient/);
    expect(await headOf(host)).toBe(before);
  });

  it("never echoes a secret key given as a recipient", async () => {
    const identity = "AGE-SECRET-KEY-1GQ9778VQXMMJVE8SK7J6VT8UJ4HDQAJUVSFCWCM02D8GEWQ72PVQ2Y5J33";
    const host = repository();
    const error = await refusal(addVault(deps(host), TARGET, secret("Secret", { recipients: [identity] })), "invalid_vault_options");
    expect(error.message).not.toContain(identity);
    expect(error.message).toMatch(/secret key/);
  });

  it("will not rewrite a fjord.json it cannot read as it is: broken, not there, not text, or of a newer format", async () => {
    const without = Object.fromEntries(Object.entries(FJORD).filter(([path]) => path !== "fjord.json"));
    const cases: [string, Record<string, string | Uint8Array>, ConnectionErrorCode][] = [
      ["not JSON", { ...FJORD, "fjord.json": "this is not json" }, "manifest_unusable"],
      ["not there", without, "manifest_unusable"],
      ["not UTF-8", { ...FJORD, "fjord.json": Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]) }, "manifest_unusable"],
      ["a newer format", { ...FJORD, "fjord.json": JSON.stringify({ ...MANIFEST, fjord: 2 }) }, "newer_version"],
    ];
    for (const [name, files, code] of cases) {
      const host = repository(files);
      const before = await headOf(host);
      await refusal(addVault(deps(host), TARGET, plain("Journal")), code);
      expect(await headOf(host), `${name}: nothing was written`).toBe(before);
    }
  });

  it("does not add one with a token that cannot write", async () => {
    const host = repository(FJORD, { canPush: false });
    const before = await headOf(host);
    await refusal(addVault(deps(host), TARGET, plain("Journal")), "read_only");
    expect(await headOf(host)).toBe(before);
  });

  it("writes nothing, and says so, when the repository changed after it was read, and works when looked at again", async () => {
    const host = repository();
    let raced = false;
    const racing: Provider = new Proxy(host, {
      get(target, property, receiver) {
        if (property === "listDirectory") {
          return async (...args: Parameters<Provider["listDirectory"]>) => {
            const entries = await target.listDirectory(...args);
            if (!raced) {
              raced = true;
              target.seed(REF, { "someone-else.txt": "landed in between" });
            }
            return entries;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await refusal(addVault(deps(racing), TARGET, plain("Journal")), "head_moved");
    expect(raced).toBe(true);
    expect(await textAt(host, "Journal/fjord.vault.json"), "nothing of ours was written").toBeUndefined();
    await addVault(deps(host), TARGET, plain("Journal"));
    expect(await textAt(host, "Journal/fjord.vault.json")).toBeDefined();
  });

  it("passes on what the host says when it cannot be reached, and is not a ConnectionError", async () => {
    const host = repository();
    const failing: Provider = new Proxy(host, {
      get(target, property, receiver) {
        if (property === "commit") {
          return async () => {
            throw new ProviderError("unavailable", "down");
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(addVault(deps(failing), TARGET, plain("Journal"))).rejects.toMatchObject({ code: "unavailable" });
  });

  it("makes the same files from the same moment and randomness, and the same as the CLI's planner (the plan is the module's)", async () => {
    const first = repository();
    const second = repository();
    await addVault(deps(first), TARGET, secret("Secret"));
    await addVault(deps(second), TARGET, secret("Secret"));
    for (const path of ["fjord.json", "Secret/fjord.vault.json", "Secret/recipients.txt", "Secret/.gitignore"]) {
      expect(await textAt(first, path), path).toBe(await textAt(second, path));
    }
  });
});
