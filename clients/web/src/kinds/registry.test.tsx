import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoryManifest } from '../format/types';
import { kindFor, registerKind, registeredKinds, unregisterKind } from './registry';
import type { KindModule } from './types';

const manifest = (
  kind: 'drive' | 'journal' | 'ssg',
  declaredKind: string | null,
  ssgEngine: string | null = null,
): RepositoryManifest => ({
  ok: true,
  version: 1,
  id: null,
  name: null,
  createdAt: null,
  kind,
  declaredKind,
  ssgEngine,
  vaultsState: 'entries',
  vaults: [],
  raw: {},
});

const standIn = (id: string): KindModule => ({
  id,
  label: `Stand-in ${id}`,
  editor: 'note',
  writingView: false,
  EntryView: () => <p>the {id} entry view</p>,
  contentModel: { placement: 'anywhere', fields: [] },
  actions: [{ id: 'wave', label: 'Wave' }],
});

afterEach(() => {
  unregisterKind('wiki');
});

describe('which module presents a repository (RFC 0001, spec §3.1)', () => {
  it('is the drive with no fjord.json, one that cannot be read, no kind, and kind drive', () => {
    expect(kindFor(null).id).toBe('drive');
    expect(kindFor({ ok: false, error: 'not JSON' }).id).toBe('drive');
    expect(kindFor(manifest('drive', null)).id).toBe('drive');
    expect(kindFor(manifest('drive', 'drive')).id).toBe('drive');
  });

  it('is the drive for a kind no module presents, and for a defined kind whose engine this build does not know', () => {
    expect(kindFor(manifest('drive', 'wiki')).id).toBe('drive');
    expect(kindFor(manifest('journal', 'journal')).id).toBe('journal');
    // The format module presents an ssg with an unknown engine as a drive; so does the client, though it has a module for the site.
    expect(kindFor(manifest('drive', 'ssg', 'hugo')).id).toBe('drive');
    expect(kindFor(manifest('ssg', 'ssg', 'astro')).id).toBe('ssg');
    expect(kindFor(manifest('ssg', 'ssg', 'jekyll')).label).toBe('Site');
  });

  it('is a registered module, whose entry view is shown and nothing else changes', () => {
    registerKind(standIn('wiki'));
    const module = kindFor(manifest('drive', 'wiki'));
    expect(module.id).toBe('wiki');
    const { EntryView } = module;
    const html = renderToStaticMarkup(
      <>{EntryView({ accountId: 'a', connection: {} as never, read: {} as never, query: {} })}</>,
    );
    expect(html).toBe('<p>the wiki entry view</p>');
    expect(kindFor(manifest('drive', null)).id).toBe('drive');
    expect(registeredKinds()[0]?.id).toBe('drive');
  });

  it('never loses the drive, which every kind falls back to', () => {
    unregisterKind('drive');
    expect(kindFor(null).id).toBe('drive');
  });
});
