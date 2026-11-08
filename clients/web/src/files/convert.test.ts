import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fjord, wasmAvailable, wasmDirectory } from '../format/wasm';
import type { FakeGitHub } from '../providers/testing/fake-github';
import { githubHarness } from '../providers/testing/harnesses';
import type { Identity } from '../providers/types';
import { encryptedDraft, newRecipients } from '../working/test-ciphertext';
import { type ConvertResult, type ConvertedFile, convertMessage, convertVault } from './convert';

/**
 * Making a whole vault encrypted or plaintext from the browser (RFC 0003), against a GitHub whose storage is a real git repository. The browser made the bytes; what is asserted is
 * what git says about the one commit it produced: the manifest the vault has afterwards, every file converted, no plaintext left in an encrypted vault, and the refusals that keep it so.
 */
const available = wasmAvailable();
if (!available && process.env.CI)
  throw new Error(
    `the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`,
  );

let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;
const ADA: Identity = { name: 'Ada Lovelace', email: 'ada@example.com' };
const PLAIN_MANIFEST = JSON.stringify({
  fjord: 1,
  id: '01jagc4k7pr9tbm3ykwx6zq2hv',
  name: 'Notes',
  'x-future': 1,
  createdAt: '2026-10-16T09:34:00Z',
  encryption: null,
  fileNaming: 'plain',
});
const RECIPIENT = newRecipients().trim();

beforeEach(async () => {
  if (!available) return;
  h = await githubHarness();
  fake = h.fake;
});
afterEach(async () => h?.close());

const blobOf = async (path: string) => {
  const head = await h.provider.getHead(h.repo, 'main');
  if (!head.changed) throw new Error('no head');
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return (await h.provider.listDirectory(h.repo, head.head.commit, dir)).find(
    (entry) => entry.path === path,
  )!.id;
};
const run = (
  input: {
    direction: 'encrypt' | 'decrypt';
    files: ConvertedFile[];
    recipients?: string[];
    vault?: string;
  },
  drafts: string[] = [],
): Promise<ConvertResult> =>
  convertVault(
    {
      provider: h.provider,
      ref: h.repo,
      branch: 'main',
      format: fjord(),
      drafts: { paths: async () => drafts },
    },
    {
      connectionId: 1,
      vault: input.vault ?? 'Notes',
      direction: input.direction,
      recipients: input.recipients ?? [RECIPIENT],
      files: input.files,
      author: ADA,
    },
  );
const reason = (result: ConvertResult) => (result.ok ? 'ok' : result.reason);
const sealed = async (path: string, text: string): Promise<ConvertedFile> => ({
  path,
  blob: await blobOf(path),
  to: `${path}.age`,
  content: encryptedDraft(text, `${RECIPIENT}\n`).bytes,
});

describe("a commit's message", () => {
  it('says what was done to which vault and how many files, and nothing of the files', () => {
    expect(convertMessage('encrypt', 'Notes', 2, 1)).toBe(
      'Encrypt vault Notes\n\n2 files encrypted with age to 1 recipient.',
    );
    expect(convertMessage('decrypt', 'Notes', 1, 0)).toBe(
      'Decrypt vault Notes\n\n1 file decrypted: the vault is now plaintext.',
    );
  });
});

describe.skipIf(!available)('a plaintext vault made encrypted', () => {
  it("is one commit: every file ciphertext, the manifest and recipients are the planner's, and the new commit has no plaintext of the vault", async () => {
    const before = await h.seed({
      'Notes/fjord.vault.json': PLAIN_MANIFEST,
      'Notes/a.md': 'SECRET PLAINTEXT a',
      'Notes/Deep/b.md': 'SECRET PLAINTEXT b',
      'Other/keep.md': 'kept',
    });
    const files = [
      await sealed('Notes/a.md', 'SECRET PLAINTEXT a'),
      await sealed('Notes/Deep/b.md', 'SECRET PLAINTEXT b'),
    ];
    const result = await run({ direction: 'encrypt', files });
    expect(result).toMatchObject({ ok: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const commit = (result as { commit: string }).commit;
    expect(await fake.show(commit, '%P')).toBe(before);
    expect((await fake.show(commit, '%B')).split('\n')[0]).toBe('Encrypt vault Notes');

    expect(Object.keys(await fake.filesAt(commit)).sort()).toEqual([
      '.gitattributes',
      'Notes/.gitignore',
      'Notes/Deep/b.md.age',
      'Notes/a.md.age',
      'Notes/fjord.vault.json',
      'Notes/recipients.txt',
      'Other/keep.md',
    ]);
    const manifest = JSON.parse((await fake.filesAt(commit))['Notes/fjord.vault.json'] as string);
    expect(manifest).toMatchObject({
      id: '01jagc4k7pr9tbm3ykwx6zq2hv',
      'x-future': 1,
      encryption: { tool: 'age', recipients: 'recipients.txt' },
    });
    expect((await fake.filesAt(commit))['Notes/recipients.txt']).toContain(RECIPIENT);
    expect((await fake.filesAt(commit))['.gitattributes']).toContain('*.age binary -diff -merge');
    for (const [name, text] of Object.entries(await fake.filesAt(commit)))
      if (name.startsWith('Notes/')) expect(text, name).not.toContain('SECRET PLAINTEXT');
    await fake.fsck();
  });

  it('never puts plain text in the vault, and every file must be there to be converted', async () => {
    await h.seed({
      'Notes/fjord.vault.json': PLAIN_MANIFEST,
      'Notes/a.md': 'SECRET PLAINTEXT a',
      'Notes/b.md': 'b',
    });
    const before = await fake.branchHead();
    const a = await sealed('Notes/a.md', 'x');
    const b = await sealed('Notes/b.md', 'y');
    const plain: ConvertedFile = { ...b, content: new TextEncoder().encode('SECRET PLAINTEXT b') };
    expect(reason(await run({ direction: 'encrypt', files: [a, plain] }))).toBe('wrong_form');
    expect(reason(await run({ direction: 'encrypt', files: [a] }))).toBe('missing_files'); // b would stay in the clear beside an encrypted manifest
    expect(
      reason(
        await run({
          direction: 'encrypt',
          files: [a, b, { ...b, path: 'Notes/ghost.md', to: 'Notes/ghost.md.age' }],
        }),
      ),
    ).toBe('missing_files');
    expect(
      reason(await run({ direction: 'encrypt', files: [a, { ...b, to: 'Notes/b.md' }] })),
    ).toBe('bad_path');
    expect(reason(await run({ direction: 'encrypt', files: [a, b], recipients: [] }))).toBe(
      'no_recipients',
    );
    expect(
      reason(await run({ direction: 'encrypt', files: [a, b], recipients: ['age1nope'] })),
    ).toBe('bad_recipient');
    expect(await fake.branchHead()).toBe(before);
  });

  it('is over only what was shown: a file that changed, a draft, a site, a vault that is already encrypted', async () => {
    await h.seed({ 'Notes/fjord.vault.json': PLAIN_MANIFEST, 'Notes/a.md': 'a' });
    const a = await sealed('Notes/a.md', 'a');
    expect(
      reason(await run({ direction: 'encrypt', files: [{ ...a, blob: '0'.repeat(40) }] })),
    ).toBe('upstream_changed');
    expect(reason(await run({ direction: 'encrypt', files: [a] }, ['Notes/a.md']))).toBe(
      'has_drafts',
    );
    expect(reason(await run({ direction: 'encrypt', files: [a], vault: 'Nowhere' }))).toBe(
      'bad_path',
    );

    await h.seed({
      'fjord.json': JSON.stringify({
        fjord: 1,
        id: '01jagc4k7pqw2xn8rvty5zb3md',
        name: 'S',
        createdAt: '2026-10-16T09:34:00Z',
        kind: 'ssg',
        ssg: { engine: 'astro' },
        vaults: [{ path: 'Notes', id: '01jagc4k7pr9tbm3ykwx6zq2hv' }],
      }),
      'Notes/fjord.vault.json': PLAIN_MANIFEST,
      'Notes/a.md': 'a',
    });
    expect(
      reason(await run({ direction: 'encrypt', files: [await sealed('Notes/a.md', 'a')] })),
    ).toBe('site');
  });
});

describe.skipIf(!available)('an encrypted vault made plaintext', () => {
  const ENCRYPTED = JSON.stringify({
    fjord: 1,
    id: '01jagc4k7pr9tbm3ykwx6zq2hv',
    name: 'Notes',
    createdAt: '2026-10-16T09:34:00Z',
    encryption: {
      tool: 'age',
      recipients: 'recipients.txt',
      suffix: '.age',
      container: 'none',
      armor: false,
    },
    fileNaming: 'plain',
  });

  it("is one commit: every payload gone, the plaintext in, the recipients file and the guard gone with the manifest's change", async () => {
    // The vault as the planner writes it, so the guard is the one that is removed.
    const planned = fjord().planVaultEncryption(PLAIN_MANIFEST, [RECIPIENT], null);
    if (!planned.ok) throw new Error('planned');
    const payload = encryptedDraft('SECRET PLAINTEXT a', `${RECIPIENT}\n`).bytes;
    await h.seed({
      'Notes/fjord.vault.json': planned.manifest,
      ...Object.fromEntries(planned.files.map((file) => [`Notes/${file.path}`, file.contents])),
      'Notes/a.md.age': Buffer.from(payload),
      'Notes/Deep/b.md.age': Buffer.from(encryptedDraft('b', `${RECIPIENT}\n`).bytes),
    });
    const files: ConvertedFile[] = [
      {
        path: 'Notes/a.md.age',
        blob: await blobOf('Notes/a.md.age'),
        to: 'Notes/a.md',
        content: new TextEncoder().encode('SECRET PLAINTEXT a'),
      },
      {
        path: 'Notes/Deep/b.md.age',
        blob: await blobOf('Notes/Deep/b.md.age'),
        to: 'Notes/Deep/b.md',
        content: new TextEncoder().encode('b'),
      },
    ];
    const result = await run({ direction: 'decrypt', files, recipients: [] });
    expect(result).toMatchObject({ ok: true });
    const commit = (result as { commit: string }).commit;
    expect(Object.keys(await fake.filesAt(commit)).sort()).toEqual([
      'Notes/Deep/b.md',
      'Notes/a.md',
      'Notes/fjord.vault.json',
    ]);
    expect(
      JSON.parse((await fake.filesAt(commit))['Notes/fjord.vault.json'] as string).encryption,
    ).toBeNull();
    expect((await fake.show(commit, '%B')).split('\n')[0]).toBe('Decrypt vault Notes');
    await fake.fsck();
    void ENCRYPTED;
  });

  it('refuses a vault that is not encrypted, a payload left out, and bytes that are still ciphertext', async () => {
    await h.seed({ 'Notes/fjord.vault.json': PLAIN_MANIFEST, 'Notes/a.md': 'a' });
    const notEncrypted: ConvertedFile = {
      path: 'Notes/a.md',
      blob: await blobOf('Notes/a.md'),
      to: 'Notes/a',
      content: new TextEncoder().encode('a'),
    };
    expect(reason(await run({ direction: 'decrypt', files: [notEncrypted] }))).toBe('bad_path');

    await h.seed({
      'Notes/fjord.vault.json': ENCRYPTED,
      'Notes/recipients.txt': `${RECIPIENT}\n`,
      'Notes/a.md.age': Buffer.from(encryptedDraft('a', `${RECIPIENT}\n`).bytes),
      'Notes/b.md.age': Buffer.from(encryptedDraft('b', `${RECIPIENT}\n`).bytes),
    });
    const before = await fake.branchHead();
    const a: ConvertedFile = {
      path: 'Notes/a.md.age',
      blob: await blobOf('Notes/a.md.age'),
      to: 'Notes/a.md',
      content: new TextEncoder().encode('a'),
    };
    expect(reason(await run({ direction: 'decrypt', files: [a] }))).toBe('missing_files');
    expect(
      reason(
        await run({ direction: 'decrypt', files: [{ ...a, content: encryptedDraft('a').bytes }] }),
      ),
    ).toBe('wrong_form');
    expect(await fake.branchHead()).toBe(before);
  });
});
