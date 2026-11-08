import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client';
import { dbRun } from '../db/exec';
import { runMigrations } from '../db/migrate';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { freshDatabase, testTarget } from '../db/test-support';
import { FileHandles, isHandle } from './handles';

/** The handles in `/f/<handle>`, over the real databases. */
const { leg } = testTarget();
let database: Database;
let handles: FileHandles;
let calls = 0;
const table = () =>
  database.dialect === 'postgres' ? postgresSchema.fileHandle : sqliteSchema.fileHandle;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  // Different bytes each call, so that two handles are not alike.
  handles = new FileHandles(
    database,
    () => 1_800_000_000_000,
    () => {
      calls += 1;
      return Uint8Array.from({ length: 16 }, (_, i) => (calls * 7 + i * 13 + 5) & 255);
    },
  );
});
afterAll(async () => database.close());
beforeEach(async () => {
  await dbRun(database, sql`DELETE FROM ${table()}`);
});

describe(`file handles (${leg})`, () => {
  it('makes a handle the first time a path is asked for, and gives the same one after', async () => {
    const first = await handles.forPath(1, 'Notes/Plans/Q4 plan.md');
    expect(isHandle(first)).toBe(true);
    expect(await handles.forPath(1, 'Notes/Plans/Q4 plan.md')).toBe(first);
    expect(await handles.resolve(first)).toEqual({
      connectionId: 1,
      path: 'Notes/Plans/Q4 plan.md',
    });
  });

  it("is a handle of one connection's path, not of another's with the same path, and shows nothing of the path", async () => {
    const one = await handles.forPath(1, 'Notes/a.md');
    const two = await handles.forPath(2, 'Notes/a.md');
    expect(one).not.toBe(two);
    expect(await handles.resolve(two)).toEqual({ connectionId: 2, path: 'Notes/a.md' });
    expect(one).not.toMatch(/notes|a\.md/i);
  });

  it('says nothing of a handle that was never made, or is not one', async () => {
    expect(await handles.resolve('0000000000000000')).toBeUndefined();
    for (const bad of [
      '',
      'short',
      'ILOU000000000000',
      '0000000000000000x',
      'Notes/a.md',
      '../etc/passwd',
    ])
      expect(await handles.resolve(bad), bad).toBeUndefined();
    expect(isHandle('0123456789abcdef')).toBe(true);
    expect(isHandle('0123456789abcdei')).toBe(false); // no i, l, o or u in the alphabet
  });

  it('follows a file that Fjord renamed or moved, and a folder with everything inside it', async () => {
    const file = await handles.forPath(1, 'Notes/a.md');
    const folder = await handles.forPath(1, 'Notes/Projects');
    const inside = await handles.forPath(1, 'Notes/Projects/2026/x.md');
    const beside = await handles.forPath(1, 'Notes/Projects2/y.md');
    await handles.move(1, 'Notes/a.md', 'Notes/Sub/a.md');
    await handles.move(1, 'Notes/Projects', 'Notes/Archive/Projects');
    expect(await handles.resolve(file)).toEqual({ connectionId: 1, path: 'Notes/Sub/a.md' });
    expect(await handles.resolve(folder)).toEqual({
      connectionId: 1,
      path: 'Notes/Archive/Projects',
    });
    expect(await handles.resolve(inside)).toEqual({
      connectionId: 1,
      path: 'Notes/Archive/Projects/2026/x.md',
    });
    // `Projects2` only shares a name prefix with `Projects`.
    expect(await handles.resolve(beside)).toEqual({
      connectionId: 1,
      path: 'Notes/Projects2/y.md',
    });
  });

  it('does not follow a move of another connection, and a name with LIKE characters in it is only itself', async () => {
    const other = await handles.forPath(2, 'Notes/a.md');
    const odd = await handles.forPath(1, 'Notes/100%_done/x.md');
    const decoy = await handles.forPath(1, 'Notes/100abc_done/x.md');
    await handles.move(1, 'Notes/a.md', 'Notes/b.md');
    await handles.move(1, 'Notes/100%_done', 'Notes/Done');
    expect(await handles.resolve(other)).toEqual({ connectionId: 2, path: 'Notes/a.md' });
    expect(await handles.resolve(odd)).toEqual({ connectionId: 1, path: 'Notes/Done/x.md' });
    expect(await handles.resolve(decoy)).toEqual({
      connectionId: 1,
      path: 'Notes/100abc_done/x.md',
    });
  });

  it('leaves a handle on a path that is no longer there when something else moved the file: it still points at that path, which the page finds empty', async () => {
    const handle = await handles.forPath(1, 'Notes/a.md');
    // Nothing calls `move` for a file Git moved elsewhere. The handle is of the path, and the repository says there is nothing there.
    expect(await handles.resolve(handle)).toEqual({ connectionId: 1, path: 'Notes/a.md' });
  });

  it('makes the handles of many paths at once: those that have one keep it, the rest are made, and asking again changes nothing', async () => {
    // Real randomness here: the stand-in above repeats after a few dozen handles, which is not what 450 need.
    const handles = new FileHandles(database);
    const had = await handles.forPath(1, 'Notes/a.md');
    const paths = [
      'Notes/a.md',
      'Notes/b.md',
      'Notes/Projects',
      ...Array.from({ length: 450 }, (_, n) => `Notes/Projects/file-${n}.md`),
    ];
    const made = await handles.forPaths(1, paths);
    expect(made.size).toBe(paths.length);
    expect(made.get('Notes/a.md')).toBe(had);
    expect(new Set(made.values()).size).toBe(paths.length);
    for (const handle of made.values()) expect(isHandle(handle)).toBe(true);
    expect(await handles.forPaths(1, paths)).toEqual(made);
    expect(await handles.forPath(1, 'Notes/b.md')).toBe(made.get('Notes/b.md'));
    // Each connection has its own.
    expect((await handles.forPaths(2, ['Notes/a.md'])).get('Notes/a.md')).not.toBe(had);
    expect((await handles.forPaths(1, [])).size).toBe(0);
  });
});
