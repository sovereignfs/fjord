import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConnectionError, type ConnectionErrorCode } from '../connections/errors';
import type { Database } from '../db/client';
import { dbRun } from '../db/exec';
import { runMigrations } from '../db/migrate';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { freshDatabase, testTarget } from '../db/test-support';
import { fjord, wasmAvailable, wasmDirectory } from '../format/wasm';
import { ProviderError } from '../providers/errors';
import { MemoryProvider } from '../providers/memory';
import type { Provider, RepositoryRef } from '../providers/types';
import { forgetBlobTexts } from './blob-text';
import { readRepository } from './repository';
import {
  type SetupChoice,
  type SetupDeps,
  applySetup,
  assessSetup,
  changeKind,
  isNotFjord,
} from './setup';
import { TreeCache } from './tree-cache';

/**
 * Setting up a repository that is not a Fjord repository (ROADMAP 1a.10): what is offered, what is written, and what
 * is refused. The host is the in-memory provider, the format is the real module, and the cache is on whichever
 * database the leg runs on. The point of most of these is what is *not* done: nothing is written when it is refused,
 * and nothing that was in the repository is changed.
 */
const { leg } = testTarget();
const available = wasmAvailable();
if (!available && process.env.CI)
  throw new Error(
    `the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`,
  );

const REF: RepositoryRef = { owner: 'acme', name: 'plain' };
const TARGET = { id: 9, ref: REF, branch: 'main', repositoryName: 'plain' };
const GUARD = '*.age binary -diff -merge';
const CODE: Record<string, string> = {
  'README.md': '# Mine\n',
  'src/main.rs': 'fn main() {}\n',
  'Cargo.toml': '[package]\n',
};

let database: Database;
const cacheTable = () =>
  database.dialect === 'postgres' ? postgresSchema.treeCache : sqliteSchema.treeCache;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterAll(async () => database.close());
beforeEach(async () => {
  await dbRun(database, sql`DELETE FROM ${cacheTable()}`);
  forgetBlobTexts();
});

function repository(
  files: Record<string, string | Uint8Array>,
  options: { canPush?: boolean } = {},
) {
  const host = new MemoryProvider();
  host.createRepository(REF, { canPush: options.canPush ?? true });
  host.seed(REF, files);
  return host;
}

const deps = (provider: Provider): SetupDeps => ({
  provider,
  cache: new TreeCache(database),
  format: fjord(),
  now: () => 1_792_000_000_000,
  random: () => Uint8Array.from({ length: 80 }, (_, i) => (i * 7 + 3) % 256),
});

const headOf = async (host: MemoryProvider) => {
  const result = await host.getHead(REF, 'main');
  if (!result.changed) throw new Error('no head');
  return result.head.commit;
};

async function textAt(host: MemoryProvider, path: string): Promise<string | undefined> {
  const commit = await headOf(host);
  const tree = await host.getTree(REF, commit);
  const entry = tree.entries.find(
    (candidate) => candidate.path === path && candidate.kind === 'file',
  );
  return entry
    ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(await host.readBlob(REF, entry.id))
    : undefined;
}

async function refusal(
  promise: Promise<unknown>,
  code: ConnectionErrorCode,
): Promise<ConnectionError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(
    error instanceof ConnectionError && error.code,
    `expected ${code}, got ${String(error)}`,
  ).toBe(code);
  return error as ConnectionError;
}

describe.skipIf(!available)(`setting a repository up (${leg})`, () => {
  it('offers a repository with no fjord.json and no vault, and says exactly what it would write, writing nothing', async () => {
    const host = repository(CODE);
    const before = await headOf(host);
    const read = await readRepository(deps(host), TARGET);
    expect(isNotFjord(read)).toBe(true);

    const assessed = await assessSetup(deps(host), TARGET, read);
    expect(assessed).toMatchObject({
      offer: true,
      preview: {
        vault: 'Public',
        branch: 'main',
        files: [
          { path: 'fjord.json', change: 'create' },
          { path: '.gitattributes', change: 'create' },
          { path: 'Public/fjord.vault.json', change: 'create' },
          { path: 'Public/welcome.md', change: 'create' },
        ],
      },
    });
    expect(await headOf(host), 'looking is not writing').toBe(before);
  });

  it('makes one commit that adds the files, changes nothing that was there, and leaves a Fjord repository', async () => {
    const host = repository(CODE);
    const before = await headOf(host);
    const beforeTree = await host.getTree(REF, before);

    const done = await applySetup(deps(host), TARGET, 'Public');

    const after = await headOf(host);
    expect(after).toBe(done.commit);
    expect(after).not.toBe(before);
    // One commit on top of the head that was read.
    const tree = await host.getTree(REF, after);
    const added = tree.entries
      .filter(
        (entry) =>
          entry.kind === 'file' && !beforeTree.entries.some((old) => old.path === entry.path),
      )
      .map((entry) => entry.path);
    expect(added.sort()).toEqual([
      '.gitattributes',
      'Public/fjord.vault.json',
      'Public/welcome.md',
      'fjord.json',
    ]);
    // Everything that was there is the same object.
    for (const old of beforeTree.entries.filter((entry) => entry.kind === 'file')) {
      expect(tree.entries.find((entry) => entry.path === old.path)?.id, old.path).toBe(old.id);
    }

    const read = await readRepository(deps(host), TARGET);
    expect(read.manifest).toMatchObject({ ok: true, version: 1, name: 'plain' });
    expect(
      read.discovery.vaults.map((vault) => [vault.directory, vault.encrypted, vault.manifestError]),
    ).toEqual([['Public', false, null]]);
    expect(read.discovery.vaults[0]?.files.map((file) => [file.relative, file.kind])).toEqual([
      ['welcome.md', 'doc'],
    ]);
    expect(isNotFjord(read)).toBe(false);
    expect(await textAt(host, '.gitattributes')).toContain(GUARD);
    expect(JSON.parse((await textAt(host, 'fjord.json')) as string).generator).toMatch(
      /^fjord-web \d/,
    );
  });

  it('adds the one line to a .gitattributes that lacks it, byte for byte keeping the rest (a byte order mark and CRLF included)', async () => {
    const original = '﻿* text=auto\r\n*.png binary\r\n';
    const host = repository({ ...CODE, '.gitattributes': original });
    const read = await readRepository(deps(host), TARGET);
    const assessed = await assessSetup(deps(host), TARGET, read);
    expect(assessed).toMatchObject({
      offer: true,
      preview: { files: expect.arrayContaining([{ path: '.gitattributes', change: 'append' }]) },
    });

    await applySetup(deps(host), TARGET, 'Public');
    const after = (await textAt(host, '.gitattributes')) as string;
    expect(after.startsWith(original)).toBe(true);
    expect(after.slice(original.length)).toContain(GUARD);
    expect(after.match(/\*\.png binary/g)).toHaveLength(1);
  });

  it('leaves a .gitattributes that already has the guard alone', async () => {
    const original = `${GUARD}\n`;
    const host = repository({ ...CODE, '.gitattributes': original });
    const before = await host.getTree(REF, await headOf(host));
    await applySetup(deps(host), TARGET, 'Public');
    const after = await host.getTree(REF, await headOf(host));
    expect(after.entries.find((entry) => entry.path === '.gitattributes')?.id).toBe(
      before.entries.find((entry) => entry.path === '.gitattributes')?.id,
    );
  });

  it('refuses, writing nothing, a .gitattributes it cannot add a line to without changing other bytes', async () => {
    const cases: [string, Record<string, string | Uint8Array>][] = [
      ['not UTF-8', { '.gitattributes': Uint8Array.from([0x2a, 0x20, 0xff, 0xfe, 0x0a]) }],
      ['too large', { '.gitattributes': `# ${'x'.repeat(70 * 1024)}\n` }],
      ['a directory', { '.gitattributes/inside': 'x' }],
    ];
    for (const [name, extra] of cases) {
      const host = repository({ ...CODE, ...extra });
      const before = await headOf(host);
      const read = await readRepository(deps(host), TARGET);

      const assessed = await assessSetup(deps(host), TARGET, read);
      expect(assessed, name).toMatchObject({
        offer: false,
        refusal: { code: 'gitattributes_unreadable' },
      });
      await refusal(applySetup(deps(host), TARGET, 'Public'), 'gitattributes_unreadable');
      expect(await headOf(host), `${name}: nothing was written`).toBe(before);
    }
  });

  it('picks the next free vault name by itself, and refuses one that is taken or cannot be a directory, writing nothing', async () => {
    const host = repository({ ...CODE, 'Public/notes.txt': 'a directory called Public is here' });
    const before = await headOf(host);
    const read = await readRepository(deps(host), TARGET);
    expect(
      isNotFjord(read),
      'a directory that is not a vault does not make it a Fjord repository',
    ).toBe(true);

    const assessed = await assessSetup(deps(host), TARGET, read);
    expect(assessed).toMatchObject({ offer: true, preview: { vault: 'Public 2' } });

    for (const [name, code] of [
      ['public', 'vault_name_taken'],
      ['SRC', 'vault_name_taken'],
      ['README.md', 'vault_name_taken'],
      ['', 'invalid_vault_name'],
      ['.hidden', 'invalid_vault_name'],
      ['a/b', 'invalid_vault_name'],
      ['bad:name', 'invalid_vault_name'],
      ['CON', 'invalid_vault_name'],
    ] as const) {
      await refusal(applySetup(deps(host), TARGET, name), code);
    }
    expect(await headOf(host), 'nothing was written').toBe(before);

    await applySetup(deps(host), TARGET, 'Public 2');
    expect(
      (await readRepository(deps(host), TARGET)).discovery.vaults.map((vault) => vault.directory),
    ).toEqual(['Public 2']);
  });

  it('will not set up a Fjord repository: one with a fjord.json, even a broken one, or one with a vault', async () => {
    for (const [files, code] of [
      [{ ...CODE, 'fjord.json': '{}' }, 'already_fjord'],
      [{ ...CODE, 'fjord.json': 'this is not json' }, 'already_fjord'],
      [
        {
          ...CODE,
          'Notes/fjord.vault.json': JSON.stringify({
            fjord: 1,
            id: '01jagc4k7pr9tbm3ykwx6zq2hv',
            name: 'Notes',
            createdAt: '2026-10-16T09:34:00Z',
            encryption: null,
            fileNaming: 'plain',
          }),
        },
        'has_vaults',
      ],
    ] as const) {
      const host = repository(files);
      const before = await headOf(host);
      const read = await readRepository(deps(host), TARGET);
      expect(isNotFjord(read)).toBe(false);
      expect(
        await assessSetup(deps(host), TARGET, read).then(
          () => 'offered',
          () => 'threw',
        ),
      ).toBeDefined();
      await refusal(applySetup(deps(host), TARGET, 'Public'), code);
      expect(await headOf(host)).toBe(before);
    }
  });

  it('does not offer it, or do it, with a token that cannot write', async () => {
    const host = repository(CODE, { canPush: false });
    const before = await headOf(host);
    const read = await readRepository(deps(host), TARGET);
    expect(await assessSetup(deps(host), TARGET, read)).toMatchObject({
      offer: false,
      refusal: { code: 'read_only' },
    });
    await refusal(applySetup(deps(host), TARGET, 'Public'), 'read_only');
    expect(await headOf(host)).toBe(before);
  });

  it('writes nothing, and says so, when the repository changed after it was read', async () => {
    const host = repository(CODE);
    // A host on which somebody else commits just as the setup reads the root of the repository.
    let raced = false;
    const racing: Provider = new Proxy(host, {
      get(target, property, receiver) {
        if (property === 'listDirectory') {
          return async (...args: Parameters<Provider['listDirectory']>) => {
            const entries = await target.listDirectory(...args);
            if (!raced) {
              raced = true;
              target.seed(REF, { 'someone-else.txt': 'landed in between' });
            }
            return entries;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await refusal(applySetup(deps(racing), TARGET, 'Public'), 'head_moved');
    expect(raced).toBe(true);
    expect(await textAt(host, 'fjord.json'), 'nothing of ours was written').toBeUndefined();
    expect(await textAt(host, 'someone-else.txt')).toBe('landed in between');

    // Looking again, it works.
    await applySetup(deps(host), TARGET, 'Public');
    expect(await textAt(host, 'fjord.json')).toBeDefined();
  });

  it('passes on what the host says when it cannot be reached, and is not a ConnectionError', async () => {
    const host = repository(CODE);
    const failing: Provider = new Proxy(host, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async () => {
            throw new ProviderError('unavailable', 'down');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(applySetup(deps(failing), TARGET, 'Public')).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it("makes the same files from the same moment and randomness (the plan is the module's, and pure)", async () => {
    const first = repository(CODE);
    const second = repository(CODE);
    await applySetup(deps(first), TARGET, 'Public');
    await applySetup(deps(second), TARGET, 'Public');
    for (const path of [
      'fjord.json',
      'Public/fjord.vault.json',
      'Public/welcome.md',
      '.gitattributes',
    ]) {
      expect(await textAt(first, path), path).toBe(await textAt(second, path));
    }
  });
});

describe.skipIf(!available)(
  `setting a repository up as a kind, and changing its kind (3a.3, ${leg})`,
  () => {
    const KEY = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

    it('offers each kind, and says what each would write', async () => {
      const host = repository(CODE);
      const read = await readRepository(deps(host), TARGET);
      const assessed = await assessSetup(deps(host), TARGET, read);
      if (!assessed.offer) throw new Error('no offer');
      const { kinds, journalVault } = assessed.preview;
      expect(journalVault).toBe('journal');
      expect(
        'files' in kinds.journal && kinds.journal.files.map((file) => file.path).sort(),
      ).toEqual(['.gitattributes', 'fjord.json', 'journal/fjord.vault.json']);
      expect(
        'files' in kinds.encryptedJournal && kinds.encryptedJournal.files.map((file) => file.path),
      ).toContain('journal/recipients.txt');
      expect('files' in kinds.astro && kinds.astro.files.map((file) => file.path)).toContain(
        'src/content.config.ts',
      );
      // The repository's own README is not one to write over: the site is offered without it.
      expect('files' in kinds.jekyll && kinds.jekyll.files.map((file) => file.path)).not.toContain(
        'README.md',
      );
    });

    it("says what to do about a folder a new site's posts would go in, for there is no other name to choose", async () => {
      const host = repository({ ...CODE, 'content/about.md': '# About' });
      const assessed = await assessSetup(
        deps(host),
        TARGET,
        await readRepository(deps(host), TARGET),
      );
      if (!assessed.offer) throw new Error('not offered');
      for (const site of [assessed.preview.kinds.astro]) {
        expect(site).toEqual({
          refused: expect.stringContaining('a new site keeps its posts there'),
        });
        expect(site).not.toEqual({ refused: expect.stringContaining('Choose another name') });
      }
    });

    it("says a site cannot be made where its engine's file is already somebody's", async () => {
      const host = repository({ ...CODE, 'package.json': '{}\n' });
      const read = await readRepository(deps(host), TARGET);
      const assessed = await assessSetup(deps(host), TARGET, read);
      if (!assessed.offer) throw new Error('no offer');
      expect(assessed.preview.kinds.astro).toEqual({
        refused: expect.stringContaining('package.json'),
      });
      expect('files' in assessed.preview.kinds.jekyll).toBe(true);
      const before = await headOf(host);
      await refusal(applySetup(deps(host), TARGET, { kind: 'ssg', engine: 'astro' }), 'file_taken');
      expect(await headOf(host), 'nothing was written').toBe(before);
    });

    it("makes a journal, plaintext or encrypted to the person's keys, and a site, each read back as its kind", async () => {
      const cases: [SetupChoice, string][] = [
        [{ kind: 'journal', vault: 'journal', encrypted: false, recipients: [] }, 'journal'],
        [{ kind: 'journal', vault: 'Diary', encrypted: true, recipients: [KEY] }, 'journal'],
        [{ kind: 'ssg', engine: 'astro' }, 'ssg'],
        [{ kind: 'ssg', engine: 'jekyll' }, 'ssg'],
      ];
      for (const [choice, kind] of cases) {
        const host = repository(CODE);
        await applySetup(deps(host), TARGET, choice);
        const read = await readRepository(deps(host), TARGET);
        expect(read.manifest?.ok && read.manifest.kind, JSON.stringify(choice)).toBe(kind);
        expect(read.discovery.vaults, JSON.stringify(choice)).toHaveLength(1);
        expect(read.discovery.vaults[0]?.encrypted).toBe(
          choice.kind === 'journal' && choice.encrypted,
        );
        expect(await textAt(host, 'README.md')).toBe('# Mine\n');
      }
    });

    describe('a site that is already here (RFC 0002)', () => {
      const ASTRO: Record<string, string> = {
        ...CODE,
        'astro.config.mjs': 'export default {};\n',
        'package.json': '{}\n',
        'src/content/posts/hello.md': '---\ntitle: Hello\n---\nHi\n',
        'src/layouts/Base.astro': '<slot />\n',
      };

      it("is found by its engine's files, and offered with its content folder as the vault and nothing of it changed", async () => {
        const host = repository(ASTRO);
        const read = await readRepository(deps(host), TARGET);
        const assessed = await assessSetup(deps(host), TARGET, read);
        if (!assessed.offer) throw new Error('no offer');
        expect(assessed.preview.adoptSite).toEqual({
          engine: 'astro',
          content: 'src/content',
          preview: {
            files: [
              { path: 'fjord.json', change: 'create' },
              { path: 'src/content/fjord.vault.json', change: 'create' },
              { path: '.gitattributes', change: 'create' },
            ],
          },
        });
        // A repository that is not a site is offered none.
        const plain = repository(CODE);
        const other = await assessSetup(
          deps(plain),
          TARGET,
          await readRepository(deps(plain), TARGET),
        );
        expect(other.offer && other.preview.adoptSite).toBeNull();
      });

      it("is set up as it is: one commit that adds only Fjord's files, the site byte for byte, read back as a site whose vault is below the root", async () => {
        const host = repository(ASTRO);
        const before = await headOf(host);
        const { commit } = await applySetup(deps(host), TARGET, {
          kind: 'ssg',
          engine: 'astro',
          adopt: 'src/content',
        });
        expect(commit).not.toBe(before);
        for (const [path, text] of Object.entries(ASTRO))
          expect(await textAt(host, path), path).toBe(text);
        const read = await readRepository(deps(host), TARGET);
        expect(read.manifest).toMatchObject({ ok: true, kind: 'ssg', ssgEngine: 'astro' });
        expect(read.discovery.vaults.map((vault) => vault.directory)).toEqual(['src/content']);
        expect(read.discovery.vaults[0]?.files.map((file) => [file.relative, file.kind])).toEqual([
          ['posts/hello.md', 'doc'],
        ]);
        expect(read.discovery.nested).toEqual([]);
      });

      it("is refused for a folder that cannot be a vault, and for a repository that already is Fjord's, writing nothing", async () => {
        const host = repository(ASTRO);
        const before = await headOf(host);
        for (const adopt of ['../outside', '.hidden', 'src//content']) {
          const error = await refusal(
            applySetup(deps(host), TARGET, { kind: 'ssg', engine: 'astro', adopt }),
            'invalid_vault_name',
          );
          expect(error.message.length).toBeGreaterThan(0);
        }
        expect(await headOf(host), 'nothing was written').toBe(before);
      });
    });

    it('changes a kind with every other field of fjord.json kept, in one commit of that file', async () => {
      const host = repository(CODE);
      await applySetup(deps(host), TARGET, 'Notes');
      const before = await headOf(host);
      const old = JSON.parse((await textAt(host, 'fjord.json')) as string) as Record<
        string,
        unknown
      >;
      const done = await changeKind(deps(host), TARGET, { kind: 'ssg', engine: 'jekyll' });
      expect(done.commit).not.toBe(before);
      const now = JSON.parse((await textAt(host, 'fjord.json')) as string) as Record<
        string,
        unknown
      >;
      expect(now).toEqual({ ...old, kind: 'ssg', ssg: { engine: 'jekyll' } });
      expect((await readRepository(deps(host), TARGET)).manifest).toMatchObject({
        ok: true,
        kind: 'ssg',
        ssgEngine: 'jekyll',
      });
    });

    it('refuses a kind whose rules the repository breaks, and says why, writing nothing', async () => {
      const host = repository({
        ...CODE,
        'fjord.json': JSON.stringify({
          fjord: 1,
          id: '01jagc4k7pqw2xn8rvty5zb3md',
          name: 'two',
          createdAt: '2026-11-02T09:34:00Z',
          vaults: [],
        }),
        'A/fjord.vault.json': JSON.stringify({
          fjord: 1,
          id: '01jagc4k7pr9tbm3ykwx6zq2hv',
          name: 'A',
          createdAt: '2026-11-02T09:34:00Z',
          encryption: null,
          fileNaming: 'plain',
        }),
        'B/fjord.vault.json': JSON.stringify({
          fjord: 1,
          id: '01jagc4k7psd5vnz8qmt3yxb4k',
          name: 'B',
          createdAt: '2026-11-02T09:34:00Z',
          encryption: {
            tool: 'age',
            recipients: 'recipients.txt',
            suffix: '.age',
            container: 'none',
            armor: false,
          },
          fileNaming: 'plain',
        }),
        'B/recipients.txt': `${KEY}\n`,
      });
      const before = await headOf(host);
      const two = await refusal(changeKind(deps(host), TARGET, { kind: 'journal' }), 'kind_rule');
      expect(two.message).toContain('exactly one vault');
      expect(await headOf(host)).toBe(before);

      const encrypted = repository({
        ...CODE,
        'fjord.json': JSON.stringify({
          fjord: 1,
          id: '01jagc4k7pqw2xn8rvty5zb3md',
          name: 'one',
          createdAt: '2026-11-02T09:34:00Z',
          vaults: [],
        }),
        'B/fjord.vault.json': JSON.stringify({
          fjord: 1,
          id: '01jagc4k7psd5vnz8qmt3yxb4k',
          name: 'B',
          createdAt: '2026-11-02T09:34:00Z',
          encryption: {
            tool: 'age',
            recipients: 'recipients.txt',
            suffix: '.age',
            container: 'none',
            armor: false,
          },
          fileNaming: 'plain',
        }),
        'B/recipients.txt': `${KEY}\n`,
      });
      const site = await refusal(
        changeKind(deps(encrypted), TARGET, { kind: 'ssg', engine: 'astro' }),
        'kind_rule',
      );
      expect(site.message).toContain('cannot be encrypted');
      // The same repository can be a journal: one vault, and a journal's may be encrypted.
      await changeKind(deps(encrypted), TARGET, { kind: 'journal' });
    });
  },
);
