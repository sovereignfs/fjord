import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client';
import { dbRun } from '../db/exec';
import { runMigrations } from '../db/migrate';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { freshDatabase, testTarget } from '../db/test-support';
import { fjord, wasmAvailable } from '../format/wasm';
import { MemoryProvider } from '../providers/memory';
import type { RepositoryRef } from '../providers/types';
import { forgetBlobTexts } from '../browse/blob-text';
import { readRepository } from '../browse/repository';
import { TreeCache } from '../browse/tree-cache';
import { JournalIndex } from './index-store';
import { PAGE_SIZE, arrange, summaries, tagCounts } from './timeline';

/**
 * A plaintext journal's timeline (ROADMAP 3b.2, 3b.3): placed by `date`, newest first, by day, paged; read from the host once per blob,
 * however often it is looked at; filtered by tags and days. On whichever database the leg runs on.
 */
const { leg } = testTarget();
const available = wasmAvailable();
const REF: RepositoryRef = { owner: 'acme', name: 'diary' };
let database: Database;
const table = () =>
  database.dialect === 'postgres' ? postgresSchema.journalEntry : sqliteSchema.journalEntry;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterAll(async () => database.close());
beforeEach(async () => {
  await dbRun(database, sql`DELETE FROM ${table()}`);
  forgetBlobTexts();
});

const entry = (date: string | null, title: string, tags: string[] = []) =>
  `---\nid: 01jagc4k7pt8y3wqnmzv5xrb9c\n${date ? `date: "${date}"\n` : ''}${tags.length ? `tags: [${tags.join(', ')}]\n` : ''}---\n\n# ${title}\n\nSome words.\n`;

function journal(files: Record<string, string>) {
  const host = new MemoryProvider();
  host.createRepository(REF, { canPush: true });
  host.seed(REF, {
    'fjord.json': JSON.stringify({
      fjord: 1,
      id: '01jagc4k7pqw2xn8rvty5zb3md',
      name: 'Diary',
      createdAt: '2026-11-01T00:00:00Z',
      kind: 'journal',
      vaults: [{ path: 'journal', id: '01jagc4k7pr9tbm3ykwx6zq2hv' }],
    }),
    'journal/fjord.vault.json': JSON.stringify({
      fjord: 1,
      id: '01jagc4k7pr9tbm3ykwx6zq2hv',
      name: 'Journal',
      createdAt: '2026-11-01T00:00:00Z',
      encryption: null,
      fileNaming: 'plain',
    }),
    ...files,
  });
  return host;
}

/** Count the host's blob reads. */
function counting(host: MemoryProvider) {
  let reads = 0;
  const readBlob = host.readBlob.bind(host);
  host.readBlob = (...args: Parameters<MemoryProvider['readBlob']>) => {
    reads += 1;
    return readBlob(...args);
  };
  return () => reads;
}

async function timelineOf(host: MemoryProvider, options: Parameters<typeof arrange>[2] = {}) {
  const read = await readRepository(
    { provider: host, cache: new TreeCache(database), format: fjord() },
    { id: 1, ref: REF, branch: 'main' },
  );
  const vault = read.discovery.vaults[0];
  if (!vault) throw new Error('no vault');
  const entries = await summaries(
    { provider: host, ref: REF, format: fjord(), index: new JournalIndex(database) },
    1,
    vault,
    read.blobs,
  );
  return arrange(fjord(), entries, options);
}

describe.skipIf(!available)(`a plaintext journal's timeline (${leg})`, () => {
  it("is newest first, by the writer's day, placed by date over path, then path, then nothing", async () => {
    const host = journal({
      'journal/2026/11/02/0814-run.md': entry('2026-11-02T08:14:00+05:30', 'Run'),
      'journal/2026/11/02/0030.md': entry('2026-11-02T00:30:00+05:30', 'After midnight'),
      // Filed under the 1st, dated the 3rd: the date wins.
      'journal/2026/11/01/0900-moved.md': entry('2026-11-03T09:00:00+05:30', 'Moved here'),
      // No date: its path places it.
      'journal/2026/10/31/2200-old.md': entry(null, 'Old'),
      'journal/loose.md': entry(null, 'Loose'),
      'journal/notes.txt': 'not an entry',
    });
    const timeline = await timelineOf(host);
    expect(timeline.days.map((day) => [day.day, day.entries.map((e) => e.title)])).toEqual([
      ['2026-11-03', ['Moved here']],
      ['2026-11-02', ['Run', 'After midnight']],
      ['2026-10-31', ['Old']],
      [null, ['Loose']],
    ]);
    expect(timeline.total).toBe(5);
  });

  it('reads each entry from the host once, however often it is shown, and again only when it changes', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 120; i++)
      files[`journal/2026/11/01/${String(1000 + i).slice(-4)}.md`] = entry(
        `2026-11-01T${String(Math.floor(i / 60) + 10).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
        `Entry ${i}`,
      );
    const host = journal(files);
    const reads = counting(host);
    const first = await timelineOf(host);
    expect(first.pages).toBe(Math.ceil(120 / PAGE_SIZE));
    const afterFirst = reads();
    forgetBlobTexts();
    await timelineOf(host, { page: 2 });
    await timelineOf(host, { page: 3 });
    // The repository's manifests may be read again; no entry is.
    expect(reads() - afterFirst).toBeLessThanOrEqual(2);
  });

  it('filters by tag (case aside, a nested one under its parent) and by days, and counts every tag once', async () => {
    const host = journal({
      'journal/2026/11/02/0800.md': entry('2026-11-02T08:00:00Z', 'One', ['Work', 'project/fjord']),
      'journal/2026/11/03/0800.md': entry('2026-11-03T08:00:00Z', 'Two', ['work']),
      'journal/2026/11/04/0800.md': entry('2026-11-04T08:00:00Z', 'Three', ['health']),
    });
    const titles = (t: Awaited<ReturnType<typeof timelineOf>>) =>
      t.days.flatMap((day) => day.entries.map((e) => e.title));
    expect(titles(await timelineOf(host, { filter: { tags: ['WORK'] } }))).toEqual(['Two', 'One']);
    expect(titles(await timelineOf(host, { filter: { tags: ['project'] } }))).toEqual(['One']);
    expect(
      titles(await timelineOf(host, { filter: { from: '2026-11-03', to: '2026-11-03' } })),
    ).toEqual(['Two']);
    expect((await timelineOf(host)).tags).toEqual([
      { tag: 'Work', count: 2 },
      { tag: 'health', count: 1 },
      { tag: 'project/fjord', count: 1 },
    ]);
  });

  it('reads an entry again when what is stored was made by another version of the summary', async () => {
    const host = journal({
      'journal/2026/11/02/0800.md':
        "---\ntitle: The header's title\ndate: 2026-11-02\n---\n\nNo heading.\n",
    });
    // A row as an older summary left it: the right blob and path, the file name for a title.
    const read = await readRepository(
      { provider: host, cache: new TreeCache(database), format: fjord() },
      { id: 1, ref: REF, branch: 'main' },
    );
    const [path, blob] = [...read.blobs].find(([p]) => p.endsWith('0800.md'))!;
    await dbRun(
      database,
      sql`INSERT INTO ${table()} (connection_id, path, blob, summary, indexed_at) VALUES (1, ${path}, ${blob}, ${JSON.stringify({ docId: null, title: '0800', date: null, dateInvalid: false, tags: [], when: null, excerpt: '', draft: false })}, 1)`,
    );
    const timeline = await timelineOf(host);
    expect(timeline.days.flatMap((day) => day.entries.map((e) => e.title))).toEqual([
      "The header's title",
    ]);
  });

  it('keeps both spellings as written', () => {
    expect(tagCounts(fjord(), [{ tags: ['Work', 'WORK'] }, { tags: ['work'] }])).toEqual([
      { tag: 'Work', count: 2 },
    ]);
  });
});
