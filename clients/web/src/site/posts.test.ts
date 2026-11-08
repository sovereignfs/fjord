import { describe, expect, it } from 'vitest';
import { fjord, wasmAvailable } from '../format/wasm';
import { MemoryProvider } from '../providers/memory';
import type { RepositoryRef } from '../providers/types';
import { createPost, siteVault } from './posts';

/** A site's new post (ROADMAP 3c.2): where it goes and what it says are the engine's, decided by the format module; one commit each. */
const available = wasmAvailable();
const REF: RepositoryRef = { owner: 'acme', name: 'site' };
const AUTHOR = { name: 'Alice', email: 'alice@example.com' };
// 19:30 UTC on 2026-11-01 is 01:00 on the 2nd at +05:30.
const AT = 1_793_561_400_000;

function site(engine: 'astro' | 'jekyll') {
  const host = new MemoryProvider();
  host.createRepository(REF, { canPush: true });
  const plan = fjord().planSetupKind(
    { repositoryName: 'Notes', generator: 'fjord-web test', kind: 'ssg', engine },
    { paths: [], gitattributes: null },
    1_793_000_000_000,
    new Uint8Array(80).fill(3),
  );
  if (!plan.ok) throw new Error('no plan');
  host.seed(REF, Object.fromEntries(plan.files.map((file) => [file.path, file.contents])));
  return host;
}

async function files(host: MemoryProvider) {
  const head = await host.getHead(REF, 'main');
  if (!head.changed) throw new Error('no head');
  const tree = await host.getTree(REF, head.head.commit);
  return Object.fromEntries(
    await Promise.all(
      tree.entries
        .filter((e) => e.kind === 'file')
        .map(
          async (e) => [e.path, new TextDecoder().decode(await host.readBlob(REF, e.id))] as const,
        ),
    ),
  );
}

describe.skipIf(!available)('a post of a site', () => {
  const deps = (host: MemoryProvider) => ({
    provider: host,
    ref: REF,
    branch: 'main',
    format: fjord(),
    now: () => AT,
    random: () => new Uint8Array(16).fill(7),
  });
  const make = (
    host: MemoryProvider,
    engine: 'astro' | 'jekyll',
    over: Partial<Parameters<typeof createPost>[1]> = {},
  ) =>
    createPost(deps(host), {
      vault: 'content',
      engine,
      at: AT,
      offsetMinutes: 330,
      title: 'Hello, World!',
      draft: false,
      author: AUTHOR,
      ...over,
    });

  it("is Astro's content/posts/<slug>.md, with the date in the writer's offset and no draft field", async () => {
    const host = site('astro');
    const made = await make(host, 'astro');
    expect(made).toMatchObject({
      ok: true,
      path: 'content/posts/hello-world.md',
      date: '2026-11-02T01:00:00+05:30',
    });
    const written = (await files(host))['content/posts/hello-world.md'];
    expect(written).toContain('title: Hello, World!');
    expect(written).toContain('date: "2026-11-02T01:00:00+05:30"');
    expect(written).not.toContain('draft');
  });

  it("is a draft by Astro's own field", async () => {
    const host = site('astro');
    await make(host, 'astro', { draft: true, title: 'Later' });
    expect((await files(host))['content/posts/later.md']).toContain('draft: true');
  });

  it("is named by its day in Jekyll, the writer's and not UTC's, and a draft is in _drafts", async () => {
    const host = site('jekyll');
    const made = await make(host, 'jekyll', { title: 'First light' });
    // The 1st in UTC, the 2nd where it was written: the name is a rule, and the writer's day is the one it uses.
    expect(made).toMatchObject({ ok: true, path: 'content/_posts/2026-11-02-first-light.md' });
    const draft = await make(host, 'jekyll', { title: 'Not yet', draft: true });
    expect(draft).toMatchObject({ ok: true, path: 'content/_drafts/not-yet.md' });
    expect((await files(host))['content/_drafts/not-yet.md']).not.toContain('draft');
    const other = await make(host, 'jekyll', { title: 'First light', offsetMinutes: -480 });
    expect(other).toMatchObject({ ok: true, path: 'content/_posts/2026-11-01-first-light.md' });
  });

  it('is never written over: the same title takes a number', async () => {
    const host = site('astro');
    const first = await make(host, 'astro');
    const second = await make(host, 'astro');
    expect(first).toMatchObject({ ok: true, path: 'content/posts/hello-world.md' });
    expect(second).toMatchObject({ ok: true, path: 'content/posts/hello-world-2.md' });
  });

  it("is made only in a site's one plaintext vault, whose engine is known", () => {
    const vault = (encrypted: boolean | null, fileNaming = 'plain') => ({
      directory: 'content',
      id: null,
      name: 'Content',
      encrypted,
      fileNaming,
      suffix: '.age',
      manifestError: null,
      files: [],
    });
    expect(siteVault([], 'astro')).toBe('not_a_site');
    expect(siteVault([vault(false)], 'hugo')).toBe('unknown_engine');
    expect(siteVault([vault(false)], null)).toBe('unknown_engine');
    expect(siteVault([vault(true)], 'astro')).toBe('unsupported_site');
    expect(siteVault([vault(false, 'id')], 'jekyll')).toBe('unsupported_site');
    expect(siteVault([vault(false)], 'jekyll')).toMatchObject({ engine: 'jekyll' });
  });

  it('has Jekyll refuse a tag with a space, and nothing else', () => {
    expect(fjord().siteTagProblem('jekyll', 'two words')).toMatch(/two tags/);
    expect(fjord().siteTagProblem('jekyll', 'project/fjord')).toBeUndefined();
    expect(fjord().siteTagProblem('astro', 'two words')).toBeUndefined();
  });

  it("knows a site's images through the module (RFC 0004)", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(fjord().siteImageType(png)).toBe('png');
    expect(fjord().siteImageType(new TextEncoder().encode('<svg/>'))).toBeUndefined();
    expect(fjord().siteImageDir('jekyll', '_posts')).toBe('assets/images');
    expect(fjord().siteImageName('My Photo.JPG', 'jpg', ['my-photo.jpg'])).toBe('my-photo-2.jpg');
    expect(fjord().siteImageRef('astro', 'content/posts/p.md', 'content/images/x.png')).toBe(
      '../images/x.png',
    );
    expect(
      fjord().siteRefersTo('content/posts/p.md', '![a](../images/x.png)', 'content/images/x.png'),
    ).toBe(true);
  });

  describe('in a site adopted where its engine already reads its content (RFC 0002)', () => {
    const plain = (files: Record<string, string>) => {
      const host = new MemoryProvider();
      host.createRepository(REF, { canPush: true });
      host.seed(REF, files);
      return host;
    };

    it("goes under the engine's content folder for Astro, wherever the vault is below the root", async () => {
      const host = plain({
        'src/content/fjord.vault.json': '{}',
        'src/content/posts/old.md': 'old',
      });
      const made = await make(host, 'astro', { vault: 'src/content' });
      expect(made).toMatchObject({ ok: true, path: 'src/content/posts/hello-world.md' });
      expect((await files(host))['src/content/posts/old.md']).toBe('old');
    });

    it('goes straight into _posts for Jekyll when the vault is _posts, not into a _posts inside it', async () => {
      const host = plain({ '_posts/fjord.vault.json': '{}', '_posts/2026-01-01-old.md': 'old' });
      const made = await make(host, 'jekyll', { vault: '_posts', title: 'First light' });
      expect(made).toMatchObject({ ok: true, path: '_posts/2026-11-02-first-light.md' });
      expect(Object.keys(await files(host))).not.toContain(
        '_posts/_posts/2026-11-02-first-light.md',
      );
    });

    it('cannot make a Jekyll draft there, since _drafts is beside the vault and outside it, and writes nothing', async () => {
      const host = plain({ '_posts/fjord.vault.json': '{}' });
      const before = Object.keys(await files(host)).sort();
      expect(
        await make(host, 'jekyll', { vault: '_posts', title: 'Not yet', draft: true }),
      ).toEqual({ ok: false, reason: 'draft_not_here' });
      expect(Object.keys(await files(host)).sort()).toEqual(before);
    });
  });
});
