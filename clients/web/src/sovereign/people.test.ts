import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keyring } from "../crypto/keyring";
import { CredentialStore } from "../crypto/store";
import { type Database, openDatabase } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as postgresAuth from "../db/schema/postgres/auth";
import * as sqliteSchema from "../db/schema/sqlite";
import * as sqliteAuth from "../db/schema/sqlite/auth";
import { freshDatabase } from "../db/test-support";
import { MemoryProvider } from "../providers/memory";
import { CommentService, type Author } from "../comments/service";
import { ConnectionService } from "../connections/service";
import { LinkService } from "../sharing/links";
import { ShareService } from "../sharing/shares";
import { SealedShareService } from "../sealed/service";
import { WorkingCopyService } from "../working/service";
import { FileHandles } from "../browse/handles";
import { JournalIndex } from "../journal/index-store";
import { DELETED_AUTHOR, DELETED_COMMENT, People } from "./people";

/**
 * What happens to a person when Sovereign says their session ended, or that they deleted their account: over the real databases, with the
 * real services, with a second person whose data must not be touched.
 */
let app: Database;
let auth: Database;
let connections: ConnectionService;
let people: People;
let comments: CommentService;
let shares: ShareService;
let links: LinkService;
let sealed: SealedShareService;
let drafts: WorkingCopyService;

const GOOD = "github_pat_goodtoken0123456789abcdefghijklmnopqrstuvwxyz";
const A = () => (app.dialect === "postgres" ? postgresSchema : sqliteSchema);
const U = () => (auth.dialect === "postgres" ? postgresAuth : sqliteAuth);
const stamp = () => (auth.dialect === "postgres" ? new Date() : Date.now());
const flag = (value: boolean) => (auth.dialect === "postgres" ? value : value ? 1 : 0);
const count = async (database: Database, from: unknown, where = sql`1 = 1`) =>
  Number((await dbGet<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${from as never} WHERE ${where}`))?.n ?? 0);

beforeAll(async () => {
  const fresh = await freshDatabase("app");
  app = fresh.database;
  await runMigrations(app);
  auth = await openDatabase(fresh.config, "auth");
  await runMigrations(auth);
  const credentials = new CredentialStore(app, new Keyring(randomBytes(32)));
  const memory = new MemoryProvider();
  connections = new ConnectionService({ database: app, credentials, github: () => memory });
  people = new People({ app, auth, connections });
  comments = new CommentService(app);
  shares = new ShareService(app);
  links = new LinkService(app);
  sealed = new SealedShareService(app);
  drafts = new WorkingCopyService(app);
  (globalThis as { __memory?: MemoryProvider }).__memory = memory;
});
afterAll(async () => {
  await auth.close();
  await app.close();
});

let counter = 0;
interface Person {
  id: string;
  sub: string;
  name: string;
  email: string;
  author: Author;
}

/** An account with a Sovereign sign-in, two sessions, a password, a passkey, two-factor and a password-reset link. */
async function addPerson(name: string, sub?: string): Promise<Person> {
  const n = ++counter;
  const person: Person = { id: `user-${n}`, sub: sub ?? `sub-${n}`, name, email: `p${n}@example.com`, author: { kind: "account", id: `user-${n}`, name } };
  const u = U();
  await dbRun(auth, sql`INSERT INTO ${u.user} (id, name, email, email_verified, created_at, updated_at, two_factor_enabled) VALUES (${person.id}, ${name}, ${person.email}, ${flag(true)}, ${stamp()}, ${stamp()}, ${flag(true)})`);
  for (const [provider, accountId] of [["sovereign", person.sub], ["credential", person.id]] as const) {
    await dbRun(auth, sql`INSERT INTO ${u.account} (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (${`acc-${n}-${provider}`}, ${accountId}, ${provider}, ${person.id}, ${stamp()}, ${stamp()})`);
  }
  for (const k of [1, 2]) {
    await dbRun(auth, sql`INSERT INTO ${u.session} (id, expires_at, token, created_at, updated_at, user_id) VALUES (${`ses-${n}-${k}`}, ${auth.dialect === "postgres" ? new Date(Date.now() + 1e9) : Date.now() + 1e9}, ${`tok-${n}-${k}`}, ${stamp()}, ${stamp()}, ${person.id})`);
  }
  await dbRun(auth, sql`INSERT INTO ${u.passkey} (id, public_key, user_id, credential_id, counter, device_type, backed_up) VALUES (${`pk-${n}`}, 'k', ${person.id}, ${`cred-${n}`}, 0, 'singleDevice', ${flag(false)})`);
  await dbRun(auth, sql`INSERT INTO ${u.twoFactor} (id, secret, backup_codes, user_id) VALUES (${`tf-${n}`}, 's', 'c', ${person.id})`);
  await dbRun(auth, sql`INSERT INTO ${u.verification} (id, identifier, value, expires_at, created_at, updated_at) VALUES (${`v-${n}`}, ${`reset-password:${n}`}, ${person.id}, ${stamp()}, ${stamp()}, ${stamp()})`);
  return person;
}

const rows = async (person: Person) => ({
  user: await count(auth, U().user, sql`id = ${person.id}`),
  accounts: await count(auth, U().account, sql`user_id = ${person.id}`),
  sessions: await count(auth, U().session, sql`user_id = ${person.id}`),
  passkeys: await count(auth, U().passkey, sql`user_id = ${person.id}`),
  twoFactor: await count(auth, U().twoFactor, sql`user_id = ${person.id}`),
  verification: await count(auth, U().verification, sql`value = ${person.id}`),
  connections: await count(app, A().connection, sql`account_id = ${person.id}`),
  shared: await count(app, A().shareUser, sql`account_id = ${person.id}`),
  buckets: await count(app, A().rateBucket, sql`"key" LIKE ${`%account:${person.id}%`}`),
});
const GONE = { user: 0, accounts: 0, sessions: 0, passkeys: 0, twoFactor: 0, verification: 0, connections: 0, shared: 0, buckets: 0 };
const HERE = { user: 1, accounts: 2, sessions: 2, passkeys: 1, twoFactor: 1, verification: 1 };

const memory = () => (globalThis as { __memory?: MemoryProvider }).__memory as MemoryProvider;
async function connect(person: Person, name: string) {
  memory().createRepository({ owner: "acme", name });
  memory().seed({ owner: "acme", name }, { "fjord.json": "{}" });
  return (await connections.addWithToken(person.id, { repository: `acme/${name}`, token: GOOD })).connection;
}
const ANCHOR = { type: "text-quote" as const, quote: "words", prefix: "", suffix: "", position: 0 };
const DOC = "01J0000000000000000000000A";

/** Alice and Bob; Alice has a repository with everything on it, and is a commenter and an editor on a document of Bob's. */
async function world() {
  const tag = String(++counter);
  const alice = await addPerson(`Alice ${tag}`);
  const bob = await addPerson(`Bob ${tag}`);
  const carol = await addPerson(`Alice ${tag}`); // the same name as Alice's, and not on the same documents
  const hers = await connect(alice, `hers-${tag}`);
  const his = await connect(bob, `his-${tag}`);
  const other = await connect(bob, `other-${tag}`);

  // What hangs on her repository.
  await drafts.save(hers.id, "a.md", { baseBlob: "b".repeat(40), content: "hers" }, { type: "account", id: alice.id });
  await shares.set(hers.id, DOC, bob.id, "view", alice.id);
  await links.create(hers.id, DOC, "view", null, alice.id);
  await sealed.create(hers.id, { path: "x.md", mode: "key", ciphertext: "AAAA", createdBy: alice.id });
  await comments.createThread(hers.id, DOC, ANCHOR, "bob on alice's doc", bob.author);
  await new FileHandles(app).forPath(hers.id, "Notes/a.md");
  await new FileHandles(app).forPath(other.id, "Notes/a.md");
  await new JournalIndex(app).put(hers.id, [{ path: "journal/2026/11/02/0814.md", blob: "d".repeat(40), summary: { docId: null, title: "her entry", date: null, dateInvalid: false, tags: ["private"], when: null, excerpt: "hers", draft: false } }]);

  // Bob's document, shared with her to comment on and edit.
  await shares.set(his.id, DOC, alice.id, "comment", bob.id);
  const unanswered = (await comments.createThread(his.id, DOC, ANCHOR, "alice, unanswered", alice.author)) as { id: number };
  const answered = (await comments.createThread(his.id, DOC, ANCHOR, "alice, answered", alice.author)) as { id: number };
  const bobsThread = (await comments.createThread(his.id, DOC, ANCHOR, "bob's own", bob.author)) as { id: number };
  await comments.reply(his.id, DOC, answered.id, "bob answers alice", bob.author);
  await comments.reply(his.id, DOC, bobsThread.id, "alice replies to bob", alice.author);
  await comments.setResolved(his.id, DOC, bobsThread.id, true, alice.author);
  await drafts.save(his.id, "b.md", { baseBlob: "c".repeat(40), content: "bob's draft" }, { type: "account", id: bob.id });
  await drafts.save(his.id, "b.md", { baseBlob: "c".repeat(40), content: "bob's draft, edited" }, { type: "account", id: alice.id });

  // Carol shares Alice's name: she commented on a document of Bob's that Alice cannot reach.
  await shares.set(other.id, DOC, carol.id, "comment", bob.id);
  const carols = (await comments.createThread(other.id, DOC, ANCHOR, "carol", carol.author)) as { id: number };
  await comments.setResolved(other.id, DOC, carols.id, true, carol.author);

  // Rate counters.
  for (const p of [alice, bob]) await dbRun(app, sql`INSERT INTO ${A().rateBucket} ("key", window_start, "count") VALUES (${`comment:account:${p.id}:60000`}, ${Date.now()}, 3)`);
  return { alice, bob, carol, hers, his, other, unanswered, answered, bobsThread, carols };
}

const thread = (id: number) => dbGet<{ body: string; authorId: string; authorName: string; resolvedBy: string | null }>(app, sql`SELECT body, author_id AS "authorId", author_name AS "authorName", resolved_by AS "resolvedBy" FROM ${A().commentThread} WHERE id = ${id}`);
const replies = (threadId: number) => dbAll<{ body: string; authorName: string }>(app, sql`SELECT body, author_name AS "authorName" FROM ${A().commentReply} WHERE thread_id = ${threadId} ORDER BY id`);

describe("ending a person's sessions", () => {
  it("ends every session they have, and no one else's", async () => {
    const { alice, bob } = await world();
    expect((await rows(alice)).sessions).toBe(2);
    expect(await people.endSessions(alice.sub)).toBe(2);
    expect(await rows(alice)).toMatchObject({ sessions: 0, user: 1, accounts: 2, connections: 1 });
    expect(await rows(bob)).toMatchObject({ sessions: 2 });
  });

  it("does nothing, and says so, for someone who never signed in here, and for a sub that only another sign-in has", async () => {
    const { alice } = await world();
    expect(await people.endSessions("sub-nobody")).toBe(0);
    // A password sign-in whose account id happens to be the sub is not the Sovereign one.
    const impostor = await addPerson("Mallory", `user-${alice.sub}`);
    await dbRun(auth, sql`UPDATE ${U().account} SET account_id = ${alice.sub}, provider_id = 'credential' WHERE user_id = ${impostor.id} AND provider_id = 'sovereign'`);
    expect(await people.endSessions(alice.sub)).toBe(2);
    expect((await rows(impostor)).sessions).toBe(2);
  });
});

describe("deleting a person", () => {
  it("deletes the account, its sign-ins and sessions, its repositories and everything on them, and none of another person's", async () => {
    const w = await world();
    const bobBefore = await rows(w.bob);
    await people.deletePerson(w.alice.sub);

    expect(await rows(w.alice)).toEqual(GONE);
    expect(await count(app, A().credential, sql`id IN (SELECT credential_id FROM ${A().connection} WHERE account_id = ${w.alice.id})`)).toBe(0);
    for (const table of [A().workingCopy, A().shareLink, A().sealedShare, A().commentThread, A().treeCache, A().docIndex, A().fileHandle, A().journalEntry, A().deletion, A().accountDefault]) {
      expect(await count(app, table, sql`connection_id = ${w.hers.id}`), "hers").toBe(0);
    }
    expect(await count(app, A().accountDefault, sql`account_id = ${w.alice.id}`)).toBe(0);

    // Bob keeps all of his. (The one thing he loses is a document shared with him from her repository, which is gone.)
    expect(await rows(w.bob)).toEqual({ ...bobBefore, shared: 0 });
    expect(bobBefore.shared).toBe(1);
    expect(await rows(w.bob)).toMatchObject(HERE);
    expect(await count(app, A().connection, sql`account_id = ${w.bob.id}`)).toBe(2);
  });

  it("deletes what they said on someone else's document, and loses none of the others' words", async () => {
    const w = await world();
    await people.deletePerson(w.alice.sub);

    // An unanswered thread of theirs is gone, with its log.
    expect(await thread(w.unanswered.id)).toBeUndefined();
    // One that Bob answered stays, so that his answer keeps what it answers, and says nothing of her.
    expect(await thread(w.answered.id)).toMatchObject({ body: DELETED_COMMENT, authorId: "", authorName: DELETED_AUTHOR });
    expect((await replies(w.answered.id)).map((r) => r.body)).toEqual(["bob answers alice"]);
    // Her reply to Bob's thread is gone and his thread is whole.
    expect((await thread(w.bobsThread.id))?.body).toBe("bob's own");
    expect(await replies(w.bobsThread.id)).toEqual([]);
    expect(await count(app, A().commentReply, sql`author_id = ${w.alice.id}`)).toBe(0);
    expect(await count(app, A().commentThread, sql`author_id = ${w.alice.id}`)).toBe(0);
    expect(await count(app, A().commentThread, sql`connection_id = ${w.his.id} AND (body = 'alice, unanswered' OR body = 'alice, answered')`)).toBe(0);
    expect(await count(app, A().commentReply, sql`connection_id = ${w.his.id} AND body LIKE '%alice replies%'`)).toBe(0);
  });

  it("takes their name out of a log and a resolution on documents they could reach, and no namesake's", async () => {
    const w = await world();
    const named = (connectionId: number, name: string) => count(app, A().commentActivity, sql`connection_id = ${connectionId} AND actor_name = ${name}`);
    expect(await named(w.his.id, w.alice.name)).toBeGreaterThan(0);
    expect((await thread(w.bobsThread.id))?.resolvedBy).toBe(w.alice.name);

    await people.deletePerson(w.alice.sub);

    expect(await named(w.his.id, w.alice.name)).toBe(0);
    expect(await named(w.his.id, DELETED_AUTHOR)).toBeGreaterThan(0);
    expect((await thread(w.bobsThread.id))?.resolvedBy).toBe(DELETED_AUTHOR);
    // Carol has the same name, on a document Alice never reached: her log and her resolution are hers.
    expect(await named(w.other.id, w.carol.name)).toBeGreaterThan(0);
    expect((await thread(w.carols.id))?.resolvedBy).toBe(w.carol.name);
    expect(await rows(w.carol)).toMatchObject(HERE);
  });

  it("takes them out of the list of who edited a draft that is not theirs, and leaves what was typed", async () => {
    const w = await world();
    const editors = async () => JSON.parse((await dbGet<{ editors: string }>(app, sql`SELECT editors FROM ${A().workingCopy} WHERE connection_id = ${w.his.id}`))!.editors) as { id: string }[];
    expect((await editors()).map((e) => e.id).sort()).toEqual([w.alice.id, w.bob.id].sort());
    await people.deletePerson(w.alice.sub);
    expect((await editors()).map((e) => e.id)).toEqual([w.bob.id]);
    expect((await dbGet<{ content: string }>(app, sql`SELECT content FROM ${A().workingCopy} WHERE connection_id = ${w.his.id}`))?.content).toBe("bob's draft, edited");
  });

  it("deletes their rate counters, and no one else's", async () => {
    const w = await world();
    await people.deletePerson(w.alice.sub);
    expect((await rows(w.alice)).buckets).toBe(0);
    expect((await rows(w.bob)).buckets).toBe(1);
  });

  it("can be run again: it does nothing the second time, and it does nothing for a person it never knew", async () => {
    const w = await world();
    await people.deletePerson(w.alice.sub);
    const bob = await rows(w.bob);
    await people.deletePerson(w.alice.sub);
    await people.deletePerson("sub-nobody");
    expect(await rows(w.alice)).toEqual(GONE);
    expect(await rows(w.bob)).toEqual(bob);
  });

  it("can be run again after it stopped half way, and finishes, because the link from the sub to the account goes last", async () => {
    const w = await world();
    const failing = new People({
      app,
      auth,
      connections: {
        removeAll: async () => {
          throw new Error("the database went away");
        },
      },
    });
    await expect(failing.deletePerson(w.alice.sub)).rejects.toThrow("went away");
    // Her sessions are gone already, but the account is still there to find.
    expect(await rows(w.alice)).toMatchObject({ user: 1, sessions: 0, connections: 1 });
    expect(await people.accountsOf(w.alice.sub)).toEqual([w.alice.id]);

    await people.deletePerson(w.alice.sub);
    expect(await rows(w.alice)).toEqual(GONE);
  });

  it("finishes when only the link is left, as after a stop between the account and its link where foreign keys are not enforced", async () => {
    const w = await world();
    await people.deletePerson(w.alice.sub);
    // Put back just the link, as it would be left.
    await dbRun(auth, sql`INSERT INTO ${U().user} (id, name, email, email_verified, created_at, updated_at) VALUES (${w.alice.id}, 'x', 'gone@example.com', ${flag(true)}, ${stamp()}, ${stamp()})`);
    await dbRun(auth, sql`DELETE FROM ${U().user} WHERE id = ${w.alice.id}`);
    await dbRun(auth, sql`INSERT INTO ${U().user} (id, name, email, email_verified, created_at, updated_at) VALUES ('ghost', 'x', 'ghost@example.com', ${flag(true)}, ${stamp()}, ${stamp()})`);
    await dbRun(auth, sql`INSERT INTO ${U().account} (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('acc-ghost', ${w.alice.sub}, 'sovereign', 'ghost', ${stamp()}, ${stamp()})`);
    expect(await people.accountsOf(w.alice.sub)).toEqual(["ghost"]);
    await people.deletePerson(w.alice.sub);
    expect(await people.accountsOf(w.alice.sub)).toEqual([]);
    expect(await count(auth, U().user, sql`id = 'ghost'`)).toBe(0);
  });

  it("does not rely on the database to cascade from the account to its sign-ins, which SQLite does only when foreign keys are on", async () => {
    const w = await world();
    // On SQLite, switch enforcement off for this deletion, as a database that was not opened with it would be. (Elsewhere it is a statement
    // that does nothing, and the deletion cascades.)
    if (auth.dialect === "sqlite") await dbRun(auth, sql`PRAGMA foreign_keys = OFF`);
    try {
      await people.deletePerson(w.alice.sub);
    } finally {
      if (auth.dialect === "sqlite") await dbRun(auth, sql`PRAGMA foreign_keys = ON`);
    }
    expect(await rows(w.alice)).toEqual(GONE);
    expect(await people.accountsOf(w.alice.sub)).toEqual([]);
  });

  it("deletes the whole account of someone who also signs in with a password or a passkey", async () => {
    const w = await world();
    expect(await rows(w.alice)).toMatchObject({ accounts: 2, passkeys: 1, twoFactor: 1 });
    await people.deletePerson(w.alice.sub);
    expect(await rows(w.alice)).toMatchObject({ accounts: 0, passkeys: 0, twoFactor: 0, user: 0 });
  });
});
