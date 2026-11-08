import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { runMigrations } from '../db/migrate';
import { freshDatabase, testTarget } from '../db/test-support';
import { isProviderError } from '../providers/errors';
import type { Change, RepositoryRef } from '../providers/types';
import { type LocalLimits } from './limits';
import { LocalProvider, tables } from './provider';

/**
 * A repository on this server, over the real databases: the limits (that each is enforced on the one place that writes, that none refuses a
 * commit that makes an account hold less, and that one account's allowance is never another's), what is kept of history so that Undo can put a
 * deleted file back and no more than the limit allows, and the rules a branch moves by. The contract every provider keeps is `providerContract`.
 */
const { leg } = testTarget();
let database: Database;
const encode = (text: string) => new TextEncoder().encode(text);
const BIG = 1024 * 1024;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterAll(async () => database.close());

const LIMITS: LocalLimits = { repositories: 3, bytes: 10 * 1024, files: 5 };
const account = () => `acct-${randomBytes(6).toString('hex')}`;
let clock = 1_800_000_000_000;
const make = (accountId = account(), limits: Partial<LocalLimits> = {}, windowMs?: number) =>
  new LocalProvider({
    database,
    accountId,
    limits: { ...LIMITS, ...limits },
    ...(windowMs ? { restoreWindowMs: windowMs } : {}),
    now: () => clock,
  });

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return isProviderError(error)
    ? error.code
    : error === undefined
      ? undefined
      : `not a provider error: ${String(error)}`;
}

const headOf = async (provider: LocalProvider, ref: RepositoryRef) => {
  const head = await provider.getHead(ref, 'main');
  if (!head.changed) throw new Error('expected a head');
  return head.head.commit;
};
const write = async (
  provider: LocalProvider,
  ref: RepositoryRef,
  changes: Change[],
  message = 'A change',
) =>
  provider.commit(ref, {
    branch: 'main',
    expectedHead: await headOf(provider, ref),
    message,
    changes,
  });
const put = (path: string, text: string): Change => ({ path, content: encode(text) });

describe(`a repository on this server (${leg})`, () => {
  describe('making one', () => {
    it('gives it a first commit with the files it was made with, on main', async () => {
      const provider = make();
      const ref = await provider.create('Notes', {
        'fjord.json': encode('{}'),
        'Public/a.md': encode('# A'),
      });
      expect(ref).toEqual({ owner: 'local', name: 'Notes' });
      const tree = await provider.getTree(ref, await headOf(provider, ref));
      expect(tree.entries.filter((e) => e.kind === 'file').map((e) => e.path)).toEqual([
        'Public/a.md',
        'fjord.json',
      ]);
      expect(
        await provider.readBlob(ref, tree.entries.find((e) => e.path === 'fjord.json')!.id),
      ).toEqual(encode('{}'));
    });

    it('may be empty: a repository that is not set up yet', async () => {
      const provider = make();
      const ref = await provider.create('Empty', {});
      expect((await provider.getTree(ref, await headOf(provider, ref))).entries).toEqual([]);
    });

    it('refuses a name that cannot be used, and one the account already has (any case)', async () => {
      const provider = make();
      for (const bad of ['', ' x', 'x ', 'a/b', 'a\\b', '.hidden', 'a\nb', 'x'.repeat(65)])
        expect(await code(provider.create(bad, {})), JSON.stringify(bad)).toBe('invalid_request');
      await provider.create('Notes', {});
      expect(await code(provider.create('notes', {}))).toBe('invalid_request');
    });

    it("gives two accounts the same name without either seeing the other's repository", async () => {
      const [alice, bob] = [make(), make()];
      const ref = await alice.create('Notes', { 'a.md': encode('alice') });
      await bob.create('Notes', { 'a.md': encode('bob') });
      expect(await code(bob.getRepository({ owner: 'local', name: 'Other' }))).toBe('not_found');
      const aliceHead = await headOf(alice, ref);
      // Alice's commit id and blobs are not reachable through Bob's provider.
      expect(await code(bob.getTree(ref, aliceHead))).toBe('not_found');
      const blob = (await alice.getTree(ref, aliceHead)).entries[0]!.id;
      expect(await code(bob.readBlob(ref, blob))).toBe('not_found');
      expect((await bob.listRepositories()).map((r) => r.ref.name)).toEqual(['Notes']);
    });

    it("is never reached through a git host's address: only `local/<name>`", async () => {
      const provider = make();
      await provider.create('Notes', {});
      expect(await code(provider.getRepository({ owner: 'acme', name: 'Notes' }))).toBe(
        'not_found',
      );
    });
  });

  describe('the limit on repositories', () => {
    it("stops the one after the last, with words that say what to do, and counts nothing else's", async () => {
      const provider = make(account(), { repositories: 2 });
      await provider.create('One', {});
      await provider.create('Two', {});
      const error = await provider.create('Three', {}).catch((e: unknown) => e);
      expect(isProviderError(error, 'limit_reached')).toBe(true);
      expect((error as { details: { limit: string } }).details.limit).toBe('repositories');
      expect((error as Error).message).toMatch(/connect one to a git repository/i);
      // Another account has its own two.
      await make(account(), { repositories: 2 }).create('One', {});
      expect((await provider.listRepositories()).length).toBe(2);
    });

    it('is switched off by a limit of 0', async () => {
      expect(await code(make(account(), { repositories: 0 }).create('One', {}))).toBe(
        'limit_reached',
      );
    });

    it('holds when two requests each saw room for one more', async () => {
      const id = account();
      const results = await Promise.allSettled(
        ['A', 'B', 'C', 'D', 'E'].map((name) => make(id, { repositories: 2 }).create(name, {})),
      );
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(2);
      expect((await make(id).listRepositories()).length).toBeLessThanOrEqual(2);
      // What failed left nothing behind.
      const t = tables(database);
      expect(
        Number(
          (
            await dbAll<{ n: number | string }>(
              database,
              sql`SELECT COUNT(*) AS n FROM ${t.repository} WHERE account_id = ${id}`,
            )
          )[0]!.n,
        ),
      ).toBe((await make(id).listRepositories()).length);
    });

    it('leaves nothing of a repository whose first files did not fit', async () => {
      const id = account();
      const provider = make(id, { files: 2 });
      expect(
        await code(
          provider.create('Big', { 'a.md': encode('a'), 'b.md': encode('b'), 'c.md': encode('c') }),
        ),
      ).toBe('limit_reached');
      expect(await provider.listRepositories()).toEqual([]);
      const t = tables(database);
      expect(
        Number(
          (
            await dbAll<{ n: number | string }>(
              database,
              sql`SELECT COUNT(*) AS n FROM ${t.repository} WHERE account_id = ${id}`,
            )
          )[0]!.n,
        ),
      ).toBe(0);
    });
  });

  describe('the limits on files and bytes', () => {
    it('refuse a commit that would put the account over its files, whichever of its repositories it is in, and say which limit', async () => {
      const provider = make(account(), { files: 5 });
      const one = await provider.create('One', {
        'a.md': encode('1'),
        'b.md': encode('2'),
        'c.md': encode('3'),
      });
      const two = await provider.create('Two', { 'a.md': encode('1') });
      await write(provider, two, [put('b.md', '2')]);
      const before = await headOf(provider, two);
      const error = await write(provider, two, [put('c.md', '3')]).catch((e: unknown) => e);
      expect(isProviderError(error, 'limit_reached')).toBe(true);
      expect((error as { details: { limit: string } }).details.limit).toBe('files');
      // Nothing was written: the branch is where it was.
      expect(await headOf(provider, two)).toBe(before);
      expect((await provider.getTree(two, before)).entries.length).toBe(2);
      expect((await provider.getTree(one, await headOf(provider, one))).entries.length).toBe(3);
    });

    it('refuse a commit that would put the account over its bytes', async () => {
      const provider = make(account(), { bytes: 100 });
      const ref = await provider.create('One', { 'a.md': encode('x'.repeat(60)) });
      const error = await write(provider, ref, [put('b.md', 'y'.repeat(60))]).catch(
        (e: unknown) => e,
      );
      expect(isProviderError(error, 'limit_reached')).toBe(true);
      expect((error as { details: { limit: string } }).details.limit).toBe('bytes');
      await write(provider, ref, [put('b.md', 'y'.repeat(40))]);
    });

    it("count a file's bytes once however many paths hold it", async () => {
      const provider = make(account(), { bytes: 100 });
      const ref = await provider.create('One', { 'a.md': encode('x'.repeat(80)) });
      await write(provider, ref, [put('b.md', 'x'.repeat(80)), put('c.md', 'x'.repeat(80))]);
      expect((await provider.usage()).bytes).toBe(80);
    });

    it('never refuse a commit that makes the account hold less, even when it is over (the limit was lowered)', async () => {
      const id = account();
      const roomy = make(id, { files: 10, bytes: 1000 });
      const ref = await roomy.create('One', {
        'a.md': encode('x'.repeat(300)),
        'b.md': encode('y'.repeat(300)),
        'c.md': encode('z'.repeat(300)),
      });
      const strict = make(id, { files: 1, bytes: 100 });
      // Over both limits now: more is refused, less is not, and replacing a file by a smaller one is less.
      expect(await code(write(strict, ref, [put('d.md', 'd')]))).toBe('limit_reached');
      await write(strict, ref, [{ path: 'a.md', delete: true }]);
      await write(strict, ref, [put('b.md', 'tiny')]);
      expect((await strict.usage()).files).toBe(2);
    });

    it('count what the branches hold, not what was deleted: deleting makes room at once', async () => {
      const provider = make(account(), { files: 2 });
      const ref = await provider.create('One', { 'a.md': encode('1'), 'b.md': encode('2') });
      expect(await code(write(provider, ref, [put('c.md', '3')]))).toBe('limit_reached');
      await write(provider, ref, [{ path: 'a.md', delete: true }]);
      await write(provider, ref, [put('c.md', '3')]);
      expect((await provider.usage()).files).toBe(2);
    });

    it("say how much is used, over all of the account's repositories", async () => {
      const provider = make();
      await provider.create('One', { 'a.md': encode('12345') });
      await provider.create('Two', { 'b.md': encode('123'), 'c.md': encode('1') });
      expect(await provider.usage()).toEqual({ repositories: 2, files: 3, bytes: 9 });
    });
  });

  describe('history, for putting back what was deleted', () => {
    it("keeps a deleted file's content, so a commit can put the same blob back", async () => {
      const provider = make();
      const ref = await provider.create('One', { 'a.md': encode('precious') });
      const blob = (await provider.getTree(ref, await headOf(provider, ref))).entries[0]!.id;
      await write(provider, ref, [{ path: 'a.md', delete: true }]);
      expect(await provider.readBlob(ref, blob)).toEqual(encode('precious'));
      await write(provider, ref, [{ path: 'back.md', blob }]);
      const tree = await provider.getTree(ref, await headOf(provider, ref));
      expect(tree.entries.map((e) => e.path)).toEqual(['back.md']);
      // It is counted as held again, and once.
      expect((await provider.usage()).bytes).toBe(8);
    });

    it('refuses to put back a blob it never had', async () => {
      const provider = make();
      const ref = await provider.create('One', { 'a.md': encode('a') });
      expect(await code(write(provider, ref, [{ path: 'x.md', blob: 'e'.repeat(40) }]))).toBe(
        'invalid_request',
      );
    });

    it('lets go of it after the restore window', async () => {
      const day = 24 * 60 * 60 * 1000;
      const provider = make(account(), {}, 30 * day);
      const ref = await provider.create('One', {
        'a.md': encode('old'),
        'keep.md': encode('keep'),
      });
      const blob = (await provider.getTree(ref, await headOf(provider, ref))).entries.find(
        (e) => e.path === 'a.md',
      )!.id;
      await write(provider, ref, [{ path: 'a.md', delete: true }]);
      expect(await provider.readBlob(ref, blob)).toEqual(encode('old'));
      clock += 31 * day;
      await write(provider, ref, [put('later.md', 'later')]);
      expect(await code(provider.readBlob(ref, blob))).toBe('not_found');
      // What a branch still holds is never let go of, however old.
      const keep = (await provider.getTree(ref, await headOf(provider, ref))).entries.find(
        (e) => e.path === 'keep.md',
      )!.id;
      expect(await provider.readBlob(ref, keep)).toEqual(encode('keep'));
    });

    it('keeps no more history than the byte limit allows, the oldest going first, and never what a branch holds', async () => {
      const provider = make(account(), { bytes: 1000, files: 50 });
      const ref = await provider.create('One', { 'live.md': encode('l'.repeat(100)) });
      const blobs: string[] = [];
      for (let i = 0; i < 5; i++) {
        clock += 1000;
        await write(provider, ref, [put('f.md', String(i).repeat(400))]);
        blobs.push(
          (await provider.getTree(ref, await headOf(provider, ref))).entries.find(
            (e) => e.path === 'f.md',
          )!.id,
        );
      }
      // Four replaced versions of 400 bytes each is 1600: past 1000, so the oldest are gone and the newest history is kept.
      const present = await Promise.all(
        blobs.map((blob) =>
          provider.readBlob(ref, blob).then(
            () => true,
            () => false,
          ),
        ),
      );
      expect(present[4]).toBe(true);
      expect(present[0]).toBe(false);
      expect(present.filter(Boolean).length).toBeLessThanOrEqual(3);
      const live = (await provider.getTree(ref, await headOf(provider, ref))).entries.find(
        (e) => e.path === 'live.md',
      )!.id;
      expect(await provider.readBlob(ref, live)).toEqual(encode('l'.repeat(100)));
      const t = tables(database);
      const row = (
        await dbAll<{ retired: number | string }>(
          database,
          sql`SELECT retired_bytes AS retired FROM ${t.repository} WHERE account_id = ${(provider as unknown as { accountId: string }).accountId}`,
        )
      )[0]!;
      expect(Number(row.retired)).toBeLessThanOrEqual(1000);
    });

    it('keeps only the head and the few commits before it, and a tree of a commit that is gone is not found', async () => {
      const provider = make();
      const ref = await provider.create('One', { 'a.md': encode('0') });
      const commits = [await headOf(provider, ref)];
      for (let i = 1; i <= 8; i++)
        commits.push((await write(provider, ref, [put('a.md', String(i))])).commit);
      expect((await provider.getTree(ref, commits[8]!)).entries.length).toBe(1);
      expect((await provider.getTree(ref, commits[4]!)).entries.length).toBe(1);
      expect(await code(provider.getTree(ref, commits[0]!))).toBe('not_found');
    });
  });

  describe('the branch', () => {
    it('moves only if it is still where the caller read it, and never by force', async () => {
      const provider = make();
      const ref = await provider.create('One', { 'a.md': encode('a') });
      const first = await headOf(provider, ref);
      await write(provider, ref, [put('b.md', 'b')]);
      expect(
        await code(
          provider.commit(ref, {
            branch: 'main',
            expectedHead: first,
            message: 'Late',
            changes: [put('c.md', 'c')],
          }),
        ),
      ).toBe('head_moved');
      expect(
        (await provider.getTree(ref, await headOf(provider, ref))).entries.map((e) => e.path),
      ).toEqual(['a.md', 'b.md']);
    });

    it('lets one of two commits made on the same head win, and the other is head_moved with nothing written', async () => {
      const provider = make();
      const ref = await provider.create('One', { 'a.md': encode('a') });
      const head = await headOf(provider, ref);
      const results = await Promise.allSettled(
        ['x', 'y', 'z'].map((name) =>
          provider.commit(ref, {
            branch: 'main',
            expectedHead: head,
            message: name,
            changes: [put(`${name}.md`, name)],
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
      for (const r of results)
        if (r.status === 'rejected') expect(isProviderError(r.reason, 'head_moved')).toBe(true);
      expect((await provider.getTree(ref, await headOf(provider, ref))).entries.length).toBe(2);
    });

    it('refuses a commit that changes nothing, and a path a git host would refuse', async () => {
      const provider = make();
      const ref = await provider.create('One', { 'a.md': encode('a') });
      expect(await code(write(provider, ref, [put('a.md', 'a')]))).toBe('no_changes');
      for (const path of ['.git/config', 'a/../b', '/abs', ''])
        expect(await code(write(provider, ref, [put(path, 'x')])), path).toBe('invalid_request');
    });

    it('is frozen by a sync that is about to delete it, only if it has not moved, and then takes no commit', async () => {
      const provider = make();
      const ref = await provider.create('One', { 'a.md': encode('a') });
      const read = await headOf(provider, ref);
      await write(provider, ref, [put('b.md', 'b')]);
      // Something was committed after the files were read: the sync must not delete.
      expect(await provider.freeze(ref, 'main', read)).toBe(false);
      const now = await headOf(provider, ref);
      expect(await provider.freeze(ref, 'main', now)).toBe(true);
      expect(
        await code(
          provider.commit(ref, {
            branch: 'main',
            expectedHead: now,
            message: 'Late',
            changes: [put('c.md', 'c')],
          }),
        ),
      ).toBe('head_moved');
      await provider.thaw(ref, 'main', now);
      await write(provider, ref, [put('c.md', 'c')]);
    });
  });

  describe('branches of their own', () => {
    it('are made at a commit, never reset, and the default branch is never deleted', async () => {
      const provider = make();
      const ref = await provider.create('One', { 'a.md': encode('a') });
      const head = await headOf(provider, ref);
      await provider.createBranch(ref, 'preview/x', head);
      expect(await code(provider.createBranch(ref, 'preview/x', head))).toBe('branch_exists');
      expect(await code(provider.createBranch(ref, 'preview/y', 'e'.repeat(40)))).toBe('not_found');
      expect(await code(provider.deleteBranch(ref, 'main'))).toBe('invalid_request');
      await provider.deleteBranch(ref, 'preview/x');
      expect(await code(provider.deleteBranch(ref, 'preview/x'))).toBe('not_found');
    });
  });

  describe('destroying', () => {
    it("takes every trace of a repository and of an account's, and can be run again", async () => {
      const id = account();
      const provider = make(id);
      const ref = await provider.create('One', { 'a.md': encode('a') });
      await provider.create('Two', { 'b.md': encode('b') });
      await provider.destroy(ref);
      await provider.destroy(ref);
      expect((await provider.listRepositories()).map((r) => r.ref.name)).toEqual(['Two']);
      await provider.destroyAll();
      await provider.destroyAll();
      const t = tables(database);
      for (const table of [t.repository])
        expect(
          Number(
            (
              await dbAll<{ n: number | string }>(
                database,
                sql`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ${id}`,
              )
            )[0]!.n,
          ),
        ).toBe(0);
      // No blob, commit or branch is left that belongs to no repository.
      for (const table of [t.blob, t.commit, t.branch]) {
        expect(
          Number(
            (
              await dbAll<{ n: number | string }>(
                database,
                sql`SELECT COUNT(*) AS n FROM ${table} WHERE repository_id NOT IN (SELECT id FROM ${t.repository})`,
              )
            )[0]!.n,
          ),
        ).toBe(0);
      }
    });
  });

  it('holds any bytes, not only text', async () => {
    const provider = make();
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 10, 13]);
    const ref = await provider.create('One', { 'b.bin': bytes });
    const blob = (await provider.getTree(ref, await headOf(provider, ref))).entries[0]!.id;
    expect(await provider.readBlob(ref, blob)).toEqual(bytes);
    expect(await code(provider.readBlob(ref, blob, { maxBytes: 3 }))).toBe('too_large');
    expect(BIG).toBeGreaterThan(0);
  });
});
