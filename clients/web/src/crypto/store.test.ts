import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { ConfigError } from "../db/config";
import { dbAll, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { isCredentialError } from "./errors";
import { Keyring } from "./keyring";
import { CredentialStore, prepareCredentials } from "./store";

/**
 * The credential table (DESIGN.md §7, §14), on whichever database the leg runs on: what is in
 * it, that none of it is readable, and that a rotation moves everything to the new key.
 */
const { leg } = testTarget();
let database: Database;
const table = () => (database.dialect === "postgres" ? postgresSchema.credential : sqliteSchema.credential);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterAll(async () => database.close());
beforeEach(async () => dbRun(database, sql`DELETE FROM ${table()}`));

const key = () => randomBytes(32);
const TOKEN = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";
const everything = async () => JSON.stringify(await dbAll(database, sql`SELECT * FROM ${table()}`));

describe(`the credential store (${leg})`, () => {
  it("keeps a secret and gives it back, by an id that is not a counter", async () => {
    const store = new CredentialStore(database, new Keyring(key()));
    const id = await store.put("github-pat", TOKEN, 1_800_000_000_000);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await store.get(id)).toEqual({ id, purpose: "github-pat", secret: TOKEN });
    expect(await store.put("github-pat", TOKEN)).not.toBe(id);
  });

  it("stores no part of the secret: not in any column, whatever the dialect", async () => {
    const store = new CredentialStore(database, new Keyring(key()));
    await store.put("github-pat", TOKEN);
    await store.put("github-app", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n");
    const dump = await everything();
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain("github_pat_");
    expect(dump).not.toContain("PRIVATE KEY");
    expect(dump).not.toContain("MIIEow");
    expect(JSON.parse(dump)).toHaveLength(2);
  });

  it("refuses an id that is not there", async () => {
    const store = new CredentialStore(database, new Keyring(key()));
    await expect(store.get("nope")).rejects.toSatisfy((e) => isCredentialError(e, "not_found"));
    await expect(store.replace("nope", "x")).rejects.toSatisfy((e) => isCredentialError(e, "not_found"));
  });

  it("replaces a secret, keeping its purpose, and removes one", async () => {
    const store = new CredentialStore(database, new Keyring(key()));
    const id = await store.put("github-pat", TOKEN);
    await store.replace(id, "second-token");
    expect(await store.get(id)).toMatchObject({ purpose: "github-pat", secret: "second-token" });
    await store.remove(id);
    await expect(store.get(id)).rejects.toSatisfy((e) => isCredentialError(e, "not_found"));
  });

  it("does not hand one person's credential to another row: a stored value moved onto another row is refused", async () => {
    const store = new CredentialStore(database, new Keyring(key()));
    const a = await store.put("github-pat", "alice-token");
    const b = await store.put("github-pat", "bob-token");
    // Whoever can write to the database copies a's sealed secret over b's.
    await dbRun(
      database,
      sql`UPDATE ${table()} SET ciphertext = (SELECT ciphertext FROM ${table()} WHERE id = ${a}), wrapped_key = (SELECT wrapped_key FROM ${table()} WHERE id = ${a}) WHERE id = ${b}`,
    );
    await expect(store.get(b)).rejects.toSatisfy((e) => isCredentialError(e, "corrupt"));
    expect(await store.get(a)).toMatchObject({ secret: "alice-token" });
  });

  it("refuses a secret whose purpose was changed in the database", async () => {
    const store = new CredentialStore(database, new Keyring(key()));
    const id = await store.put("github-pat", TOKEN);
    await dbRun(database, sql`UPDATE ${table()} SET purpose = 'github-app' WHERE id = ${id}`);
    await expect(store.get(id)).rejects.toSatisfy((e) => isCredentialError(e, "corrupt"));
  });
});

describe(`rotating the instance key (${leg})`, () => {
  it("wraps every credential under the new key, opens them all, and then needs no old key", async () => {
    const oldKey = key();
    const before = new CredentialStore(database, new Keyring(oldKey));
    const ids = await Promise.all([before.put("github-pat", "one"), before.put("github-pat", "two"), before.put("github-app", "three")]);
    const ciphertexts = await dbAll<{ id: string; ciphertext: string }>(database, sql`SELECT id, ciphertext FROM ${table()}`);

    const newKey = key();
    const ring = new Keyring(newKey, [oldKey]);
    const store = new CredentialStore(database, ring);
    expect(await store.status()).toEqual({ total: 3, current: 0, older: 3, unknown: {} });
    // Readable before anything is re-wrapped.
    expect((await store.get(ids[0]!)).secret).toBe("one");

    expect(await store.rewrapAll(1_900_000_000_000)).toEqual({ rewrapped: 3 });
    expect(await store.status()).toEqual({ total: 3, current: 3, older: 0, unknown: {} });
    // The credentials themselves were not rewritten.
    expect(await dbAll(database, sql`SELECT id, ciphertext FROM ${table()}`)).toEqual(expect.arrayContaining(ciphertexts));

    const withoutOld = new CredentialStore(database, new Keyring(newKey));
    expect(await Promise.all(ids.map(async (id) => (await withoutOld.get(id)).secret))).toEqual(["one", "two", "three"]);
    expect(await withoutOld.rewrapAll()).toEqual({ rewrapped: 0 });
  });

  it("is safe to run from two processes at once", async () => {
    const oldKey = key();
    const seed = new CredentialStore(database, new Keyring(oldKey));
    const ids = await Promise.all(Array.from({ length: 12 }, (_, i) => seed.put("github-pat", `secret-${i}`)));
    const ring = new Keyring(key(), [oldKey]);
    const [a, b] = await Promise.all([new CredentialStore(database, ring).rewrapAll(), new CredentialStore(database, ring).rewrapAll()]);
    expect(a.rewrapped + b.rewrapped).toBe(12);
    const store = new CredentialStore(database, ring);
    expect(await store.status()).toMatchObject({ total: 12, current: 12 });
    expect(await Promise.all(ids.map(async (id) => (await store.get(id)).secret))).toEqual(ids.map((_, i) => `secret-${i}`));
  });

  it("leaves a credential under a key that is not configured alone, and says so", async () => {
    const lost = key();
    const id = await new CredentialStore(database, new Keyring(lost)).put("github-pat", TOKEN);
    const store = new CredentialStore(database, new Keyring(key()));
    const status = await store.status();
    expect(Object.values(status.unknown)).toEqual([1]);
    expect(await store.rewrapAll()).toEqual({ rewrapped: 0 });
    await expect(store.get(id)).rejects.toSatisfy((e) => isCredentialError(e, "unknown_key"));
  });
});

describe(`start-up preparation (${leg})`, () => {
  it("does nothing when there are no credentials, with a key or without", async () => {
    expect(await prepareCredentials(database, undefined)).toMatchObject({ total: 0, rewrapped: 0 });
    expect(await prepareCredentials(database, new Keyring(key()))).toMatchObject({ total: 0, rewrapped: 0 });
  });

  it("re-wraps what is under a previous key, so a restart is the whole rotation", async () => {
    const oldKey = key();
    await new CredentialStore(database, new Keyring(oldKey)).put("github-pat", TOKEN);
    const ring = new Keyring(key(), [oldKey]);
    expect(await prepareCredentials(database, ring)).toMatchObject({ total: 1, older: 1, rewrapped: 1 });
    expect(await prepareCredentials(database, ring)).toMatchObject({ older: 0, rewrapped: 0 });
  });

  it("refuses to start when credentials are stored and there is no key", async () => {
    await new CredentialStore(database, new Keyring(key())).put("github-pat", TOKEN);
    await expect(prepareCredentials(database, undefined)).rejects.toThrow(ConfigError);
    await expect(prepareCredentials(database, undefined)).rejects.toThrow(/FJORD_ENCRYPTION_KEY/);
  });

  it("refuses to start when a key that credentials need has been dropped, naming it and not the credentials", async () => {
    const lost = new Keyring(key());
    await new CredentialStore(database, lost).put("github-pat", TOKEN);
    const attempt = prepareCredentials(database, new Keyring(key()));
    await expect(attempt).rejects.toThrow(ConfigError);
    await expect(attempt).rejects.toThrow(new RegExp(lost.current.id));
    await expect(attempt).rejects.not.toThrow(TOKEN);
  });
});
