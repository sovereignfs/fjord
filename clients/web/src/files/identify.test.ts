import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fjord, wasmAvailable, wasmDirectory } from '../format/wasm';
import type { FakeGitHub } from '../providers/testing/fake-github';
import { githubHarness } from '../providers/testing/harnesses';
import type { Identity, Provider } from '../providers/types';
import { identifyFile, type IdentifyDeps } from './identify';

/**
 * Giving a Doc an identifier (ROADMAP 3e.3) against a GitHub whose storage is a real git repository, with `fjord-core`'s own header as WebAssembly. What git
 * says about the commit is what is asserted: its parent, its author, the one file it changes, and that nothing but a header was added to it.
 */
const available = wasmAvailable();
if (!available && process.env.CI)
  throw new Error(
    `the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`,
  );

let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;

const ADA: Identity = { name: 'Ada Lovelace', email: 'ada@example.com' };
const VAULT = JSON.stringify({
  fjord: 1,
  id: '01jagc4k7pr9tbm3ykwx6zq2hv',
  name: 'Notes',
  createdAt: '2026-10-16T09:34:00Z',
  encryption: null,
  fileNaming: 'plain',
});
const OLD = '01jagc4k7pt8y3wqnmzv5xrb8j';

beforeEach(async () => {
  if (!available) return;
  h = await githubHarness();
  fake = h.fake;
});
afterEach(async () => h?.close());

const deps = (provider: Provider = h.provider): IdentifyDeps => ({
  provider,
  ref: h.repo,
  branch: 'main',
  format: fjord(),
  now: () => 1_800_000_000_000,
  random: () => new Uint8Array(16).fill(7),
});
const seed = (files: Record<string, string>) =>
  h.seed({ 'Notes/fjord.vault.json': VAULT, ...files });
const blobOf = async (path: string) => {
  const head = await h.provider.getHead(h.repo, 'main');
  if (!head.changed) throw new Error('no head');
  return (
    await h.provider.listDirectory(h.repo, head.head.commit, path.slice(0, path.lastIndexOf('/')))
  ).find((entry) => entry.path === path)!.id;
};
const identify = async (path: string, over: { blob?: string } = {}) =>
  identifyFile(deps(), { path, blob: over.blob ?? (await blobOf(path)), author: ADA });
const ID = () => fjord().newUlid(1_800_000_000_000, new Uint8Array(16).fill(7));

describe.skipIf(!available)('giving a Doc an identifier', () => {
  it('is one commit that changes one file, by the person, on top of the head, and puts only a header in front of what was there', async () => {
    const before = await seed({
      'Notes/Plan.md': '# The plan\n\nBody, with a --- rule below.\n\n---\n\nmore\n',
      'Notes/other.md': 'o',
    });
    const result = await identify('Notes/Plan.md');
    expect(result).toEqual({
      ok: true,
      docId: ID(),
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    const commit = (result as { commit: string }).commit;
    expect(await fake.branchHead()).toBe(commit);
    expect(await fake.show(commit, '%P')).toBe(before);
    expect(await fake.show(commit, '%an <%ae>')).toBe('Ada Lovelace <ada@example.com>');
    expect((await fake.show(commit, '%B')).split('\n')[0]).toBe('Give “Plan” an identifier');

    const after = await fake.filesAt(commit);
    const text = after['Notes/Plan.md']!;
    expect(text.endsWith('# The plan\n\nBody, with a --- rule below.\n\n---\n\nmore\n')).toBe(true);
    expect(fjord().parseDocument(text)).toMatchObject({
      status: 'present',
      docId: ID(),
      title: 'The plan',
    });
    expect(after['Notes/other.md']).toBe('o');
    await fake.fsck();
  });

  it('keeps the keys a header already has, in their order, and adds only the id (and what it lacks)', async () => {
    await seed({ 'Notes/post.md': '---\nlayout: post\ntitle: Hello\ndraft: false\n---\n\nHi.\n' });
    const result = (await identify('Notes/post.md')) as { ok: true; commit: string };
    const text = (await fake.filesAt(result.commit))['Notes/post.md']!;
    const keys = [...text.slice(0, text.indexOf('\n---\n', 4)).matchAll(/^([A-Za-z]+):/gm)].map(
      (m) => m[1],
    );
    expect(keys).toEqual(expect.arrayContaining(['layout', 'title', 'draft', 'id']));
    expect(keys.indexOf('layout')).toBeLessThan(keys.indexOf('title'));
    expect(keys.indexOf('title')).toBeLessThan(keys.indexOf('draft'));
    expect(text).toContain('title: Hello\n');
    expect(text.endsWith('---\n\nHi.\n')).toBe(true);
  });

  it('is not an error for a file that has one: its id is the answer, and nothing is committed', async () => {
    const head = await seed({ 'Notes/Plan.md': `---\nid: ${OLD}\ntitle: Plan\n---\n\nBody\n` });
    expect(await identify('Notes/Plan.md')).toEqual({ ok: true, docId: OLD, commit: null });
    expect(await fake.branchHead()).toBe(head);
  });

  it('changes nothing when the file is not the version the person looked at, is gone, or is not Markdown', async () => {
    const head = await seed({ 'Notes/Plan.md': '# Plan\n', 'Notes/pic.txt': 'x' });
    expect(await identify('Notes/Plan.md', { blob: '0'.repeat(40) })).toEqual({
      ok: false,
      reason: 'changed',
    });
    expect(await identify('Notes/Gone.md', { blob: '0'.repeat(40) })).toEqual({
      ok: false,
      reason: 'gone',
    });
    expect(await identify('Notes/pic.txt', { blob: await blobOf('Notes/pic.txt') })).toEqual({
      ok: false,
      reason: 'not_markdown',
    });
    expect(await fake.branchHead()).toBe(head);
  });

  it('leaves a file whose header a new one would disturb, or that cannot be read, as it is', async () => {
    const head = await seed({
      'Notes/crlf.md': '# Windows\r\n\r\nbody\r\n',
      'Notes/bom.md': '﻿# With a BOM\n',
      'Notes/broken.md': '---\nid: [\n---\nbody\n',
    });
    for (const path of ['Notes/crlf.md', 'Notes/bom.md', 'Notes/broken.md'])
      expect(await identify(path), path).toEqual({ ok: false, reason: 'cannot_identify' });
    expect(await fake.branchHead()).toBe(head);
  });

  it("is made again on top of a head that moved meanwhile, and loses no one's change", async () => {
    await seed({ 'Notes/Plan.md': '# Plan\n' });
    const blob = await blobOf('Notes/Plan.md');
    let theirs = '';
    let first = true;
    const racing: Provider = new Proxy(h.provider, {
      get(target, property, receiver) {
        if (property !== 'commit') return Reflect.get(target, property, receiver);
        return async (...args: Parameters<Provider['commit']>) => {
          if (first) {
            first = false;
            theirs = await fake.commitFiles({ 'Notes/elsewhere.md': 'theirs' });
          }
          return target.commit(...args);
        };
      },
    });
    const result = await identifyFile(deps(racing), { path: 'Notes/Plan.md', blob, author: ADA });
    expect(result).toMatchObject({ ok: true });
    expect(await fake.show((result as { commit: string }).commit, '%P')).toBe(theirs);
    expect(await fake.filesAt((result as { commit: string }).commit)).toMatchObject({
      'Notes/elsewhere.md': 'theirs',
    });
  });
});
