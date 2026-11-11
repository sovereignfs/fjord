import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CACHE_NAME, OFFLINE_PATH, PRECACHE, workerSource } from './worker';

/**
 * The service worker is run here, on a stand-in for what a browser gives it (`self`, `caches`, `fetch`), because what matters is what it does with a request:
 * it must not keep anyone's page or data, and must not stand between a person and a server that answers.
 */
const ORIGIN = 'https://fjord.example.com';

interface FakeRequest {
  method: string;
  url: string;
  mode: string;
}
const request = (path: string, over: Partial<FakeRequest> = {}): FakeRequest => ({
  method: 'GET',
  url: path.startsWith('http') ? path : `${ORIGIN}${path}`,
  mode: 'cors',
  ...over,
});

class FakeCache {
  entries = new Map<string, unknown>();
  async addAll(requests: { url: string }[]) {
    for (const r of requests) this.entries.set(new URL(r.url, ORIGIN).pathname, `stored ${r.url}`);
  }
  async match(r: { url: string } | string) {
    const url = typeof r === 'string' ? r : r.url;
    return this.entries.get(new URL(url, ORIGIN).pathname);
  }
  async put(r: { url: string }, response: unknown) {
    this.entries.set(new URL(r.url, ORIGIN).pathname, response);
  }
}

function boot(network: (r: FakeRequest) => Promise<unknown>) {
  const stores = new Map<string, FakeCache>();
  const listeners: Record<string, (event: never) => void> = {};
  const fetched: string[] = [];
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name)!;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  let claimed = false;
  let skipped = false;
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners[type] = listener;
    },
    clients: { claim: async () => void (claimed = true) },
    skipWaiting: () => void (skipped = true),
  };
  runInNewContext(workerSource(), {
    self,
    caches,
    URL,
    Request: class {
      url: string;
      constructor(path: string) {
        this.url = new URL(path, ORIGIN).href;
      }
    },
    Response: { error: () => 'network error' },
    Promise,
    fetch: (r: FakeRequest) => {
      fetched.push(new URL(r.url).pathname);
      return network(r);
    },
  });

  const lifecycle = async (type: 'install' | 'activate') => {
    let waiting: Promise<unknown> = Promise.resolve();
    listeners[type]!({ waitUntil: (p: Promise<unknown>) => void (waiting = p) } as never);
    await waiting;
  };
  /** What the worker answers a request with, or `undefined` when it leaves the request to the browser. */
  const ask = async (r: FakeRequest) => {
    let answer: Promise<unknown> | undefined;
    listeners['fetch']!({
      request: r,
      respondWith: (p: Promise<unknown>) => void (answer = p),
    } as never);
    return answer ? { answered: true as const, value: await answer } : { answered: false as const };
  };
  return {
    stores,
    fetched,
    ask,
    lifecycle,
    state: () => ({ claimed, skipped }),
  };
}

const up = async (r: FakeRequest) => ({
  ok: true,
  type: 'basic',
  status: 200,
  body: `live ${new URL(r.url).pathname}`,
  clone() {
    return this;
  },
});
const down = async () => {
  throw new TypeError('Failed to fetch');
};

describe('installing', () => {
  it('keeps the offline page and nothing else, fetched past the browser cache', async () => {
    const worker = boot(up);
    await worker.lifecycle('install');
    expect([...worker.stores.keys()]).toEqual([CACHE_NAME]);
    const kept = [...worker.stores.get(CACHE_NAME)!.entries.keys()];
    expect(kept.sort()).toEqual([...PRECACHE].sort());
    expect(kept).toContain(OFFLINE_PATH);
  });

  it('never skips waiting: a new worker does not replace the code of a window someone is writing in', async () => {
    const worker = boot(up);
    await worker.lifecycle('install');
    expect(worker.state().skipped).toBe(false);
    expect(workerSource()).not.toContain('skipWaiting');
  });
});

describe('activating', () => {
  it("removes the caches of earlier releases, and only this app's own, then takes over", async () => {
    const worker = boot(up);
    await worker.lifecycle('install');
    worker.stores.set('fjord-0.0.1', new FakeCache());
    worker.stores.set('someone-elses', new FakeCache());
    await worker.lifecycle('activate');
    expect([...worker.stores.keys()].sort()).toEqual([CACHE_NAME, 'someone-elses'].sort());
    expect(worker.state().claimed).toBe(true);
  });
});

describe('a page', () => {
  it('is left to the browser while the network works, and is never stored', async () => {
    const worker = boot(up);
    await worker.lifecycle('install');
    for (const path of ['/', '/home', '/d/01HZX3', '/repo/abc/Notes/a.md', '/s/tok', '/p/tok']) {
      const answer = await worker.ask(request(path, { mode: 'navigate' }));
      // It may answer by fetching, but what it fetched is the network's, and nothing is put away.
      if (answer.answered) expect(answer.value).toMatchObject({ body: `live ${path}` });
    }
    expect([...worker.stores.get(CACHE_NAME)!.entries.keys()].sort()).toEqual([...PRECACHE].sort());
  });

  it('is replaced by the offline page when the network is down, and only then', async () => {
    const worker = boot(down);
    await worker.lifecycle('install');
    const answer = await worker.ask(request('/d/01HZX3', { mode: 'navigate' }));
    expect(answer).toEqual({ answered: true, value: `stored ${ORIGIN}${OFFLINE_PATH}` });
  });

  it("is the server's own answer when the server answers, an error included", async () => {
    const worker = boot(async () => ({ ok: false, status: 500, type: 'basic', body: 'oops' }));
    await worker.lifecycle('install');
    const answer = await worker.ask(request('/home', { mode: 'navigate' }));
    expect(answer).toEqual({
      answered: true,
      value: { ok: false, status: 500, type: 'basic', body: 'oops' },
    });
  });

  it('is not a page when it is an API, a raw document or a build file, which fail as they should', async () => {
    const worker = boot(down);
    await worker.lifecycle('install');
    for (const path of ['/api/health', '/api/auth/callback/sovereign', '/raw/abc', '/_next/data/x'])
      expect((await worker.ask(request(path, { mode: 'navigate' }))).answered, path).toBe(false);
  });
});

describe('everything that is not a page', () => {
  it('is left alone unless it is a static file: an API call, a write, another origin, the format module', async () => {
    const worker = boot(up);
    await worker.lifecycle('install');
    for (const r of [
      request('/api/connections'),
      request('/d/01HZX3/comments'),
      request('/d/01HZX3/draft', { method: 'PUT' }),
      request('/api/auth/sign-out', { method: 'POST' }),
      request('https://cdn.example.org/_next/static/a.js'),
      request('/fjord-wasm/fjord_wasm_bg.wasm'),
      request('/manifest.webmanifest'),
    ])
      expect((await worker.ask(r)).answered, `${r.method} ${r.url}`).toBe(false);
    expect(worker.fetched).toEqual([]);
  });

  it("keeps the build's static files and the icons once they have been fetched, and serves them without the network after", async () => {
    let online = true;
    const worker = boot((r) => (online ? up(r) : down()));
    await worker.lifecycle('install');
    const file = request('/_next/static/chunks/app-1a2b3c.js', { mode: 'no-cors' });
    expect(await worker.ask(file)).toMatchObject({ answered: true, value: { ok: true } });
    online = false;
    expect(await worker.ask(file)).toMatchObject({
      answered: true,
      value: { body: 'live /_next/static/chunks/app-1a2b3c.js' },
    });
  });

  it('does not keep a failed answer or a redirect for a static file', async () => {
    const worker = boot(async () => ({ ok: false, status: 404, type: 'basic', clone: () => ({}) }));
    await worker.lifecycle('install');
    await worker.ask(request('/_next/static/chunks/gone.js'));
    expect(worker.stores.get(CACHE_NAME)!.entries.has('/_next/static/chunks/gone.js')).toBe(false);
  });
});
