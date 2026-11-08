import { describe, expect, it, vi } from 'vitest';
import type { Caller } from '../working/http';
import { type Deps, MAX_COPY_BODY_CHARS, handleCopy } from './copy-http';

const ORIGIN = 'https://fjord.example.com';
const ALICE: Caller = { accountId: 'alice', name: 'Alice', email: 'alice@example.com' };
const TOKEN = 'T'.repeat(43);
const PATH = 'Secret/Plan.md.age';
const GOOD = { path: PATH, title: 'Q4 plan', body: '# Q4 plan\n\nThe plan.\n', understood: true };

function stub() {
  const publish = vi.fn(
    async (..._args: unknown[]): Promise<Awaited<ReturnType<Deps['publish']>>> => ({
      found: true,
      result: { ok: true, token: TOKEN },
    }),
  );
  const status = vi.fn(
    async (..._args: unknown[]): Promise<Awaited<ReturnType<Deps['status']>>> => ({
      found: true,
      publishedAt: null,
    }),
  );
  const unpublish = vi.fn(
    async (..._args: unknown[]): Promise<Awaited<ReturnType<Deps['unpublish']>>> => ({
      found: true,
      unpublished: true,
    }),
  );
  const deps: Deps = {
    origin: ORIGIN,
    publish: (a, i, x) => publish(a, i, x),
    status: (a, i, p) => status(a, i, p),
    unpublish: (a, i, p) => unpublish(a, i, p),
  };
  return { deps, publish, status, unpublish };
}
const send = (
  method: string,
  body: unknown,
  init: { origin?: string | null; type?: string | null } = {},
) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers['content-type'] = init.type ?? 'application/json';
  return new Request(`${ORIGIN}/api/connections/1/publication/copy`, {
    method,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
};
const json = async (response: Response) => JSON.parse(await response.text());

describe('publishing a copy of an encrypted file (ROADMAP 3h.2)', () => {
  it('stores the copy it was given, once the person said they understand, and answers the address once', async () => {
    const { deps, publish } = stub();
    const response = await handleCopy(send('POST', GOOD), ALICE, deps, '1');
    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({ token: TOKEN, url: `${ORIGIN}/p/${TOKEN}` });
    expect(publish).toHaveBeenCalledWith('alice', 1, {
      path: PATH,
      title: 'Q4 plan',
      body: GOOD.body,
    });
  });

  it.each([
    ['no agreement', { ...GOOD, understood: undefined }],
    ['an agreement that is false', { ...GOOD, understood: false }],
    ['an agreement as text', { ...GOOD, understood: 'true' }],
    ['an agreement as a number', { ...GOOD, understood: 1 }],
  ])("stores nothing without the person's agreement: %s is 422", async (_name, sent) => {
    const { deps, publish } = stub();
    const response = await handleCopy(send('POST', sent), ALICE, deps, '1');
    expect(response.status).toBe(422);
    expect((await json(response)).error.code).toBe('not_agreed');
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ['no path', { ...GOOD, path: undefined }],
    ['a path at the top', { ...GOOD, path: 'Plan.md' }],
    ['a path that climbs out', { ...GOOD, path: 'Secret/../x.md.age' }],
    ['an absolute path', { ...GOOD, path: '/Secret/Plan.md.age' }],
    ['a title with a line break', { ...GOOD, title: 'a\nb' }],
    ['a title that is too long', { ...GOOD, title: 'x'.repeat(201) }],
    ['a title that is not text', { ...GOOD, title: 5 }],
    ['no text', { ...GOOD, body: undefined }],
    ['a text over the limit', { ...GOOD, body: 'x'.repeat(MAX_COPY_BODY_CHARS + 1) }],
    ['a text with an unpaired surrogate', { ...GOOD, body: 'a\ud800b' }],
  ])('refuses %s with 400, without asking', async (_name, sent) => {
    const { deps, publish } = stub();
    expect((await handleCopy(send('POST', sent), ALICE, deps, '1')).status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });

  it("is for someone signed in (401), from this site (403), by GET, POST or DELETE (405), and for the caller's own connection (404)", async () => {
    const { deps, publish, status, unpublish } = stub();
    expect((await handleCopy(send('POST', GOOD), null, deps, '1')).status).toBe(401);
    for (const origin of ['https://evil.example', `${ORIGIN}.evil.example`, 'null', null]) {
      expect(
        (await handleCopy(send('POST', GOOD, { origin }), ALICE, deps, '1')).status,
        String(origin),
      ).toBe(403);
      expect(
        (await handleCopy(send('DELETE', { path: PATH }, { origin }), ALICE, deps, '1')).status,
        String(origin),
      ).toBe(403);
    }
    expect((await handleCopy(send('PUT', GOOD), ALICE, deps, '1')).status).toBe(405);
    expect(
      (await handleCopy(send('POST', GOOD, { type: 'text/plain' }), ALICE, deps, '1')).status,
    ).toBe(415);
    expect(publish).not.toHaveBeenCalled();
    expect(unpublish).not.toHaveBeenCalled();
    for (const id of ['0', '01', 'x', '1'.repeat(17)])
      expect((await handleCopy(send('POST', GOOD), ALICE, deps, id)).status, id).toBe(404);
    publish.mockResolvedValueOnce({ found: false });
    expect((await handleCopy(send('POST', GOOD), ALICE, deps, '1')).status).toBe(404);
    status.mockResolvedValueOnce({ found: false });
    expect(
      (
        await handleCopy(
          new Request(`${ORIGIN}/x?path=${encodeURIComponent(PATH)}`),
          ALICE,
          deps,
          '1',
        )
      ).status,
    ).toBe(404);
  });

  it('says why a file cannot be published as a copy, and never echoes the text or the address', async () => {
    const { deps, publish } = stub();
    publish.mockResolvedValueOnce({ found: true, result: { ok: false, reason: 'not_encrypted' } });
    const refused = await handleCopy(send('POST', GOOD), ALICE, deps, '1');
    expect(refused.status).toBe(422);
    const body = await json(refused);
    expect(body.error.code).toBe('not_encrypted');
    expect(JSON.stringify(body)).not.toContain('The plan.');
    publish.mockResolvedValueOnce({ found: true, result: { ok: false, reason: 'unavailable' } });
    expect((await handleCopy(send('POST', GOOD), ALICE, deps, '1')).status).toBe(502);
  });

  it("looks at a file's state and ends its address, by path", async () => {
    const { deps, status, unpublish } = stub();
    status.mockResolvedValueOnce({ found: true, publishedAt: 5 });
    expect(
      await json(
        await handleCopy(
          new Request(`${ORIGIN}/x?path=${encodeURIComponent(PATH)}`),
          ALICE,
          deps,
          '1',
        ),
      ),
    ).toEqual({ published: true, publishedAt: 5 });
    expect(status).toHaveBeenCalledWith('alice', 1, PATH);
    expect(await json(await handleCopy(send('DELETE', { path: PATH }), ALICE, deps, '1'))).toEqual({
      unpublished: true,
    });
    expect(unpublish).toHaveBeenCalledWith('alice', 1, PATH);
    expect(
      (await handleCopy(new Request(`${ORIGIN}/x?path=..%2Fx`), ALICE, deps, '1')).status,
    ).toBe(400);
  });
});
