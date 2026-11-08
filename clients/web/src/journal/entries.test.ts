import { describe, expect, it } from 'vitest';
import { fjord, wasmAvailable } from '../format/wasm';
import { MemoryProvider } from '../providers/memory';
import type { RepositoryRef } from '../providers/types';
import { createEntry, journalVault } from './entries';

/** A journal entry made on the server (ROADMAP 3b.1): dated in the writer's time, filed where `fjord-core` says, one commit each. */
const available = wasmAvailable();
const REF: RepositoryRef = { owner: 'acme', name: 'diary' };
const AUTHOR = { name: 'Alice', email: 'alice@example.com' };
// 2026-11-01T19:00:00Z: half past midnight on the 2nd in Colombo (+05:30), seven at night in UTC.
const AT = 1_793_559_600_000 + 5 * 60 * 1000 * 6;

function journal() {
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
  });
  return host;
}

async function text(host: MemoryProvider, path: string) {
  const head = await host.getHead(REF, 'main');
  if (!head.changed) throw new Error('no head');
  const entry = (await host.getTree(REF, head.head.commit)).entries.find(
    (candidate) => candidate.path === path,
  );
  return entry ? new TextDecoder().decode(await host.readBlob(REF, entry.id)) : undefined;
}

describe.skipIf(!available)('a journal entry', () => {
  const deps = (host: MemoryProvider) => ({
    provider: host,
    ref: REF,
    branch: 'main',
    format: fjord(),
    now: () => AT,
    random: () => new Uint8Array(16).fill(7),
  });

  it("is on the writer's local day, whatever the day is in UTC, with its date's offset kept, named by the minute and not by the title", async () => {
    const host = journal();
    // 19:30 UTC on the 1st is 01:00 on the 2nd at +05:30.
    const made = await createEntry(deps(host), {
      vault: 'journal',
      at: AT,
      offsetMinutes: 330,
      title: 'Late thoughts',
      author: AUTHOR,
    });
    expect(made).toMatchObject({
      ok: true,
      path: 'journal/2026-11-02/01-00.md',
      date: '2026-11-02T01:00:00+05:30',
    });
    const written = await text(host, 'journal/2026-11-02/01-00.md');
    expect(written).toContain('date: "2026-11-02T01:00:00+05:30"');
    expect(written).toContain('title: Late thoughts');
    // The same moment in Los Angeles is still the 1st.
    const there = await createEntry(deps(host), {
      vault: 'journal',
      at: AT,
      offsetMinutes: -480,
      title: '',
      author: AUTHOR,
    });
    expect(there).toMatchObject({ ok: true, path: 'journal/2026-11-01/11-30.md' });
  });

  it('is never written over: a second one in the same minute takes a number', async () => {
    const host = journal();
    const first = await createEntry(deps(host), {
      vault: 'journal',
      at: AT,
      offsetMinutes: 0,
      title: 'Run',
      author: AUTHOR,
    });
    const second = await createEntry(deps(host), {
      vault: 'journal',
      at: AT,
      offsetMinutes: 0,
      title: 'Run',
      author: AUTHOR,
    });
    expect(first).toMatchObject({ ok: true, path: 'journal/2026-11-01/19-30.md' });
    expect(second).toMatchObject({ ok: true, path: 'journal/2026-11-01/19-30-2.md' });
    expect(first.ok && second.ok && first.commit !== second.commit).toBe(true);
  });

  it("is made only in a journal's one plaintext vault", () => {
    const vault = (directory: string, encrypted: boolean | null, fileNaming = 'plain') => ({
      directory,
      id: null,
      name: directory,
      encrypted,
      fileNaming,
      suffix: '.age',
      manifestError: null,
      files: [],
    });
    expect(journalVault([])).toBe('none');
    expect(journalVault([vault('a', false), vault('b', false)])).toBe('none');
    expect(journalVault([vault('j', true, 'id')])).toBe('encrypted');
    expect(journalVault([vault('j', false, 'id')])).toBe('unsupported');
    expect(journalVault([vault('j', false)])).toMatchObject({ directory: 'j' });
  });
});
