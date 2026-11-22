import { TAKE_OVER_MESSAGE } from '@sovereignfs/pwa';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CACHE_NAME, OFFLINE_PATH, PRECACHE, workerSource } from './worker';

/**
 * The service worker is run here, on a stand-in for what a browser gives it (`self`, `caches`, `fetch`), because what matters is what it does with a request:
 * it must not keep anyone's page or data, and must not stand between a person and a server that answers.
 */
const ORIGIN = 'https://fjord.example.com';

type Listener = (event: Record<string, unknown>) => void;

function boot(network: (r: Request) => Promise<Response>) {
  const stores = new Map<string, Map<string, Response>>();
  const listeners: Record<string, Listener[]> = {};
  const fetched: string[] = [];
  const state = { claimed: false, tookOver: false };
  const keyOf = (r: Request | string) => (typeof r === 'string' ? new URL(r, ORIGIN).href : r.url);
  const cacheOf = (name: string) => {
    let store = stores.get(name);
    if (!store) stores.set(name, (store = new Map()));
    const kept = store;
    return {
      match: async (r: Request | string) => kept.get(keyOf(r))?.clone(),
      put: async (r: Request | string, response: Response) => void kept.set(keyOf(r), response),
    };
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) =>
      void (listeners[type] ??= []).push(listener),
    clients: { claim: async () => void (state.claimed = true) },
    skipWaiting: () => void (state.tookOver = true),
  };
  runInNewContext(workerSource(), {
    self,
    caches: {
      open: async (name: string) => cacheOf(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
    URL,
    Request,
    Response,
    Headers,
    Promise,
    setTimeout,
    clearTimeout,
    // A browser's fetch of its own origin answers with a response of type `basic`, the only kind the worker keeps.
    fetch: async (r: Request) => {
      fetched.push(new URL(r.url).pathname);
      return Object.defineProperty(await network(r), 'type', { value: 'basic' });
    },
  });

  const fire = async (type: string, event: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    let answer: Promise<Response> | undefined;
    for (const listener of listeners[type] ?? [])
      listener({
        ...event,
        waitUntil: (p: Promise<unknown>) => void waits.push(p),
        respondWith: (p: Promise<Response>) => void (answer = p),
      });
    await Promise.all(waits);
    return answer ? await answer : undefined;
  };
  const ask = (path: string, init: { mode?: RequestMode; method?: string } = {}) => {
    const request = new Request(new URL(path, ORIGIN), { method: init.method ?? 'GET' });
    Object.defineProperty(request, 'mode', { value: init.mode ?? 'cors' });
    return fire('fetch', { request });
  };
  const kept = () =>
    [...(stores.get(CACHE_NAME)?.keys() ?? [])].map((url) => new URL(url).pathname);
  return { stores, fetched, fire, ask, kept, state };
}

const live = async (r: Request) => new Response(`live ${new URL(r.url).pathname}`);
const down = async (): Promise<Response> => {
  throw new TypeError('Failed to fetch');
};

describe('installing', () => {
  it('keeps the offline page and the mark it shows, and nothing else', async () => {
    const worker = boot(live);
    await worker.fire('install');
    expect([...worker.stores.keys()]).toEqual([CACHE_NAME]);
    expect(worker.kept().sort()).toEqual([...PRECACHE].sort());
    expect(worker.kept()).toContain(OFFLINE_PATH);
  });

  it('does not take over a window someone is writing in until a page asks, which the registration does when they choose Reload', async () => {
    const worker = boot(live);
    await worker.fire('install');
    await worker.fire('message', { data: 'something else' });
    expect(worker.state.tookOver).toBe(false);
    await worker.fire('message', { data: TAKE_OVER_MESSAGE });
    expect(worker.state.tookOver).toBe(true);
  });
});

describe('activating', () => {
  it("removes the caches of earlier releases, and only this app's own, then takes over", async () => {
    const worker = boot(live);
    await worker.fire('install');
    worker.stores.set('fjord-0.0.1', new Map());
    worker.stores.set('someone-elses', new Map());
    await worker.fire('activate');
    expect([...worker.stores.keys()].sort()).toEqual([CACHE_NAME, 'someone-elses'].sort());
    expect(worker.state.claimed).toBe(true);
  });
});

describe('a page', () => {
  it('is the network’s while the network works, and is never stored', async () => {
    const worker = boot(live);
    await worker.fire('install');
    for (const path of [
      '/',
      '/home',
      '/d/01HZX3',
      '/repo/abc/Notes/a.md',
      '/s/tok',
      '/p/tok',
      '/raw/abc',
    ]) {
      const answer = await worker.ask(path, { mode: 'navigate' });
      expect(await answer?.text(), path).toBe(`live ${path}`);
    }
    expect(worker.kept().sort()).toEqual([...PRECACHE].sort());
  });

  it('is replaced by the offline page when the network is down, and only then', async () => {
    let online = true;
    const worker = boot((r) => (online ? live(r) : down()));
    await worker.fire('install');
    online = false;
    const answer = await worker.ask('/d/01HZX3', { mode: 'navigate' });
    expect(await answer?.text()).toBe(`live ${OFFLINE_PATH}`);
  });

  it("is the server's own answer when the server answers, an error included", async () => {
    const worker = boot(async () => new Response('oops', { status: 500 }));
    const answer = await worker.ask('/home', { mode: 'navigate' });
    expect(answer?.status).toBe(500);
    expect(await answer?.text()).toBe('oops');
  });
});

describe('everything that is not a page', () => {
  it('is left alone unless it is a static file: an API call, a write, another origin, the format module', async () => {
    const worker = boot(live);
    await worker.fire('install');
    worker.fetched.length = 0;
    for (const [path, method] of [
      ['/api/connections', 'GET'],
      ['/d/01HZX3/comments', 'GET'],
      ['/d/01HZX3/draft', 'PUT'],
      ['/api/auth/sign-out', 'POST'],
      ['https://cdn.example.org/_next/static/a.js', 'GET'],
      ['/fjord-wasm/fjord_wasm_bg.wasm', 'GET'],
    ] as const)
      expect(await worker.ask(path, { method }), `${method} ${path}`).toBeUndefined();
    expect(worker.fetched).toEqual([]);
  });

  it("keeps the build's static files and the icons once they have been fetched, and serves them without the network after", async () => {
    let online = true;
    const worker = boot((r) => (online ? live(r) : down()));
    const file = '/_next/static/chunks/app-1a2b3c.js';
    expect(await (await worker.ask(file, { mode: 'no-cors' }))?.text()).toBe(`live ${file}`);
    online = false;
    expect(await (await worker.ask(file, { mode: 'no-cors' }))?.text()).toBe(`live ${file}`);
  });

  it('does not keep a failed answer for a static file', async () => {
    const worker = boot(async () => new Response('gone', { status: 404 }));
    await worker.ask('/_next/static/chunks/gone.js');
    expect(worker.kept()).not.toContain('/_next/static/chunks/gone.js');
  });
});
