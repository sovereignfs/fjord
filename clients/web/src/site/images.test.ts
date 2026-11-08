import { describe, expect, it } from 'vitest';
import { fjord, wasmAvailable } from '../format/wasm';
import { MemoryProvider } from '../providers/memory';
import type { RepositoryRef } from '../providers/types';
import {
  MAX_IMAGE_BYTES,
  deleteImageOutsideVault,
  isLibraryPath,
  listImages,
  postsShowing,
  uploadImages,
} from './images';

/** A site's media library (RFC 0004, ROADMAP 3j): where pictures go, what they are called, what is refused, and which posts show one. */
const available = wasmAvailable();
const REF: RepositoryRef = { owner: 'acme', name: 'site' };
const AUTHOR = { name: 'Alice', email: 'alice@example.com' };

const PNG = (extra = 0) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, extra, 0]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

function site(engine: 'astro' | 'jekyll', extra: Record<string, string> = {}) {
  const host = new MemoryProvider();
  host.createRepository(REF, { canPush: true });
  const plan = fjord().planSetupKind(
    { repositoryName: 'Notes', generator: 'fjord-web test', kind: 'ssg', engine },
    { paths: [], gitattributes: null },
    1_793_000_000_000,
    new Uint8Array(80).fill(3),
  );
  if (!plan.ok) throw new Error('no plan');
  host.seed(REF, {
    ...Object.fromEntries(plan.files.map((file) => [file.path, file.contents])),
    ...extra,
  });
  return host;
}

async function paths(host: MemoryProvider) {
  const head = await host.getHead(REF, 'main');
  if (!head.changed) throw new Error('no head');
  return (await host.getTree(REF, head.head.commit)).entries
    .filter((e) => e.kind === 'file')
    .map((e) => e.path);
}

describe.skipIf(!available)("a site's media library", () => {
  const deps = (host: MemoryProvider) => ({
    provider: host,
    ref: REF,
    branch: 'main',
    format: fjord(),
  });
  const add = (
    host: MemoryProvider,
    files: { name: string; bytes: Uint8Array }[],
    engine: 'astro' | 'jekyll' = 'astro',
    vault = 'content',
  ) => uploadImages(deps(host), { vault, engine, files, author: AUTHOR });

  it("puts a picture in the engine's images folder under a safe name, in one commit", async () => {
    const host = site('astro');
    const made = await add(host, [
      { name: 'My Holiday.JPG', bytes: PNG() },
      { name: 'Other.png', bytes: PNG(1) },
    ]);
    expect(made).toMatchObject({
      ok: true,
      images: [
        { name: 'my-holiday.png', path: 'content/images/my-holiday.png', status: 'added' },
        { name: 'other.png' },
      ],
    });
    expect(await paths(host)).toEqual(
      expect.arrayContaining(['content/images/my-holiday.png', 'content/images/other.png']),
    );
    // One commit for the batch.
    expect((await host.getHead(REF, 'main')).changed && made.ok && made.commit).toBeTruthy();
  });

  it('gives a name that is taken a number and never writes over a picture', async () => {
    const host = site('astro');
    await add(host, [{ name: 'a.png', bytes: PNG(1) }]);
    const again = await add(host, [{ name: 'A.png', bytes: PNG(2) }]);
    expect(again).toMatchObject({ ok: true, images: [{ name: 'a-2.png', status: 'added' }] });
  });

  it('does not add the same bytes twice, and says which picture is there', async () => {
    const host = site('astro');
    await add(host, [{ name: 'a.png', bytes: PNG(1) }]);
    const again = await add(host, [{ name: 'copy.png', bytes: PNG(1) }]);
    expect(again).toEqual({
      ok: true,
      commit: null,
      images: [{ name: 'a.png', path: 'content/images/a.png', status: 'exists' }],
    });
    expect((await paths(host)).filter((p) => p.endsWith('.png'))).toHaveLength(1);
  });

  it('refuses SVG, a document named .png, an empty batch, a large file and too many, writing nothing', async () => {
    const host = site('astro');
    const before = await paths(host);
    expect(
      await add(host, [
        { name: 'ok.png', bytes: PNG() },
        { name: 'x.svg', bytes: SVG },
      ]),
    ).toEqual({ ok: false, reason: 'not_an_image', detail: 'x.svg' });
    expect(
      await add(host, [
        { name: 'x.png', bytes: new TextEncoder().encode('<html><script>1</script>') },
      ]),
    ).toMatchObject({ reason: 'not_an_image' });
    expect(await add(host, [])).toEqual({ ok: false, reason: 'nothing' });
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG());
    expect(await add(host, [{ name: 'big.png', bytes: big }])).toEqual({
      ok: false,
      reason: 'too_large',
      detail: 'big.png',
    });
    expect(
      await add(
        host,
        Array.from({ length: 21 }, (_, i) => ({ name: `${i}.png`, bytes: PNG(i) })),
      ),
    ).toEqual({ ok: false, reason: 'too_many' });
    expect(await paths(host)).toEqual(before);
  });

  it('is told by its bytes, not its name: a PNG named .jpg is a .png', async () => {
    const host = site('astro');
    expect(await add(host, [{ name: 'photo.jpg', bytes: PNG() }])).toMatchObject({
      ok: true,
      images: [{ name: 'photo.png' }],
    });
  });

  it("keeps a Jekyll vault named _posts's pictures in assets/images, which Jekyll serves", async () => {
    const host = site('jekyll');
    const made = await add(host, [{ name: 'a.png', bytes: PNG() }], 'jekyll', '_posts');
    expect(made).toMatchObject({ ok: true, images: [{ path: 'assets/images/a.png' }] });
    const listed = await listImages(deps(host), { vault: '_posts', engine: 'jekyll' });
    expect(listed).toMatchObject({
      ok: true,
      dir: 'assets/images',
      images: [{ path: 'assets/images/a.png' }],
    });
  });

  it('lists the pictures of the vault, shown wherever they are in it, and none outside it', async () => {
    const host = site('astro', {
      'content/posts/pic.png': 'x',
      'public/logo.png': 'x',
      'content/images/b.webp': 'x',
      'content/notes.txt': 'x',
    });
    const listed = await listImages(deps(host), { vault: 'content', engine: 'astro' });
    expect(listed.ok && listed.images.map((i) => i.path)).toEqual([
      'content/images/b.webp',
      'content/posts/pic.png',
    ]);
  });

  it('refuses an engine it does not know', async () => {
    const host = site('astro');
    expect(
      await uploadImages(deps(host), {
        vault: 'content',
        engine: 'hugo',
        files: [{ name: 'a.png', bytes: PNG() }],
        author: AUTHOR,
      }),
    ).toEqual({ ok: false, reason: 'unknown_engine' });
    expect(await listImages(deps(host), { vault: 'content', engine: 'hugo' })).toEqual({
      ok: false,
      reason: 'unknown_engine',
    });
  });

  it('finds the posts that show a picture, by what each refers to', async () => {
    const host = site('astro', {
      'content/images/a.png': 'x',
      'content/posts/one.md': '---\ntitle: One\n---\n\n![A](../images/a.png)\n',
      'content/posts/two.md': '---\ntitle: Two\n---\n\n![B](../images/b.png)\n',
      'content/posts/three.md':
        '---\ntitle: Three\n---\n\nsee [a](../images/a.png) only as a link\n',
    });
    expect(
      await postsShowing(deps(host), { vault: 'content', imagePath: 'content/images/a.png' }),
    ).toEqual({ ok: true, posts: ['content/posts/one.md'], complete: true });
  });

  it('takes away only a picture of the library, held to the version it was shown', async () => {
    const host = site('jekyll');
    await add(host, [{ name: 'a.png', bytes: PNG() }], 'jekyll', '_posts');
    const listed = await listImages(deps(host), { vault: '_posts', engine: 'jekyll' });
    const image = listed.ok ? listed.images[0] : undefined;
    if (!image) throw new Error('no image');
    const input = {
      vault: '_posts',
      engine: 'jekyll',
      path: image.path,
      blob: image.blob,
      author: AUTHOR,
    };
    expect(await deleteImageOutsideVault(deps(host), { ...input, blob: '0'.repeat(40) })).toEqual({
      ok: false,
      reason: 'upstream_changed',
    });
    expect(await deleteImageOutsideVault(deps(host), { ...input, path: 'fjord.json' })).toEqual({
      ok: false,
      reason: 'not_in_library',
    });
    expect(
      await deleteImageOutsideVault(deps(host), { ...input, path: 'assets/images/../../x.png' }),
    ).toEqual({ ok: false, reason: 'not_in_library' });
    expect(await deleteImageOutsideVault(deps(host), input)).toMatchObject({ ok: true });
    expect(await paths(host)).not.toContain('assets/images/a.png');
    expect(await deleteImageOutsideVault(deps(host), input)).toEqual({ ok: false, reason: 'gone' });
  });

  it("says what is the library's path", () => {
    const f = { format: fjord() };
    expect(
      isLibraryPath(f, { vault: 'content', engine: 'astro', path: 'content/images/a.png' }),
    ).toBe(true);
    expect(
      isLibraryPath(f, { vault: 'content', engine: 'astro', path: 'content/posts/a.png' }),
    ).toBe(true);
    expect(isLibraryPath(f, { vault: 'content', engine: 'astro', path: 'src/a.png' })).toBe(false);
    expect(
      isLibraryPath(f, { vault: 'content', engine: 'astro', path: 'content/posts/a.md' }),
    ).toBe(false);
  });
});
