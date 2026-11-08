import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JournalEntrySummary } from '../format/types';
import { wasmAvailable, wasmDirectory } from '../format/wasm';
import { fromBase64, openCiphertext } from '../keys/files';
import type { CryptoModule } from '../keys/module';
import { ciphertextFetcher, readEncryptedEntries } from './encrypted-timeline';
import { newEncryptedEntry } from './seal';
import { arrange } from './timeline';

/**
 * An encrypted journal's timeline is built in the browser, and nothing of an entry reaches the server (ROADMAP 3b.2's privacy test, RFC
 * 0001): every request the page sends to read the timeline is recorded, and none carries an entry's date, title or tag. The entries are made,
 * encrypted and read with the real module, as the page does.
 */
const available = wasmAvailable();
const load = () =>
  createRequire(import.meta.url)(join(wasmDirectory(), 'fjord_wasm.js')) as CryptoModule;

describe.runIf(available)("an encrypted journal's timeline", () => {
  it('is read by asking for ciphertext by its identifier alone, and no date, title or tag is in any request', async () => {
    const module = load();
    const identity = module.generateIdentity();
    const recipients = `${module.identityRecipient(identity)}\n`;
    // The day is public (the folder it is filed in, by the owner's choice: workstream 0003); the time, the title, the tags and the text are not.
    const secrets = ['Night walk', 'Doctor visit', '01-00', 'health', 'Private'];

    // Two entries, each stored as the server would: under a new identifier, the ciphertext and nothing else.
    const stored = new Map<string, Uint8Array>();
    for (const [title, offsetMinutes, at] of [
      ['Night walk', -330, 1_793_559_600_000 + 30 * 60_000],
      ['Doctor visit', -330, 1_793_900_000_000],
    ] as const) {
      const now = new Date(at);
      now.getTimezoneOffset = () => offsetMinutes;
      const sealed = newEncryptedEntry(module, {
        title,
        recipients,
        now,
        random: crypto.getRandomValues(new Uint8Array(16)),
      });
      // A tag is put in the header before sealing, as the properties panel would.
      const opened = openCiphertext(
        module,
        { with: (use) => use(identity) },
        fromBase64(sealed.ciphertext),
        'id',
        'x.age',
      );
      if (opened.kind !== 'text') throw new Error('not text');
      const tagged = module.withTags(opened.text, JSON.stringify(['health', 'Private'])) ?? '';
      const resealed = module.encrypt(
        module.wrapContainer(opened.name, new TextEncoder().encode(tagged)),
        recipients,
        false,
      );
      stored.set(
        `Journal/${sealed.folder}/${module.newUlid(at, crypto.getRandomValues(new Uint8Array(16)))}.age`,
        resealed,
      );
    }

    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const recording = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const path = new URL(String(url), 'https://fjord.example').searchParams.get('path') ?? '';
      const bytes = stored.get(path);
      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
    }) as typeof fetch;

    const found = await readEncryptedEntries(
      {
        fetchCiphertext: ciphertextFetcher(7, recording),
        open: (ciphertext) => {
          const shown = openCiphertext(
            module,
            { with: (use) => use(identity) },
            ciphertext,
            'id',
            'entry.md',
          );
          return shown.kind === 'text' ? { name: shown.name, text: shown.text } : undefined;
        },
        summarise: (text, name) =>
          JSON.parse(module.journalEntry(text, name)) as JournalEntrySummary,
      },
      [...stored.keys()].map((path) => ({ path })),
    );

    // It reads what it was meant to, in the writer's own days.
    const timeline = arrange(module, found.entries);
    expect(timeline.days.map((day) => day.day)).toEqual(['2026-11-05', '2026-11-02']);
    expect(timeline.tags.map((t) => t.tag).sort()).toEqual(['Private', 'health']);

    // And every request is a GET for one identifier's ciphertext in its day's folder, with no body: of an entry, only its day is in what leaves the page.
    expect(requests).toHaveLength(2);
    for (const { url, init } of requests) {
      expect(url).toMatch(
        /^\/api\/connections\/7\/ciphertext\?path=Journal%2F\d{4}-\d{2}-\d{2}%2F[0-9a-z]{26}\.age$/,
      );
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.body).toBeUndefined();
      for (const secret of secrets)
        expect(`${url} ${JSON.stringify(init)}`.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });
});
