import { DocIndex } from '../browse/doc-index';
import { authConfig, getSession } from '../auth/server';
import { getAuthDatabase } from '../db/boot';
import { credentialStore, encryptionKeyring } from '../crypto/server';
import { findUser } from '../auth/users';
import { hashPassword } from '../sharing/password';
import { connectionService } from '../connections/server';
import { getDatabase } from '../db/boot';
import { fjord } from '../format/wasm';
import { documentIn, sourceOfOwner } from '../sharing/server';
import type { Caller } from '../working/http';
import { checkVault } from '../files/create';
import { readConnection } from '../browse/server';
import type { Deps as CopyDeps } from './copy-http';
import type { Deps } from './http';
import { type OpenedPublication, askedPassword, openPublished } from './open';
import { PublicationService, copyKey } from './publications';
import { type UnlockPublicationResult, tryUnlockPublication } from './unlock';

/** The pages' store: with the credential store where there is a key, so that a page's address is kept sealed and its owner can be shown it again; without one, an address is shown once. */
async function publicationService(): Promise<PublicationService> {
  const database = await getDatabase();
  const vault = encryptionKeyring() === undefined ? undefined : await credentialStore();
  return new PublicationService(database, Date.now, undefined, vault);
}

/** The server's secret, which the proof that a page's password was given is keyed with. */
function secretOf(): string {
  const config = authConfig();
  if (!config.enabled) throw new Error('publishing needs sign-in settings');
  return config.secret;
}

/** The page a token is the address of, for whoever asks (with the proof that its password was given, if it has one): its title, rendered body and who made it, or that it is locked, or nothing. */
export async function openPublishedFor(
  token: string,
  proof?: string,
): Promise<OpenedPublication | undefined> {
  const database = await getDatabase();
  const accounts = await getAuthDatabase();
  return openPublished(
    {
      publications: new PublicationService(database),
      sourceOf: await sourceOfOwner(),
      index: new DocIndex(database),
      format: fjord(),
      nameOf: async (id) => (await findUser(accounts, id))?.name,
      secret: secretOf(),
    },
    token,
    proof,
  );
}

/** Give a page's password: the proof that opens it if it is right, or why not. */
export async function unlockPublishedFor(
  token: string,
  password: unknown,
): Promise<UnlockPublicationResult> {
  return tryUnlockPublication(
    { publications: new PublicationService(await getDatabase()), secret: secretOf() },
    { token, password },
  );
}

/** Whether this token is a page that asks for a password. */
export async function publishedAsksPassword(token: string): Promise<boolean> {
  return askedPassword({ publications: new PublicationService(await getDatabase()) }, token);
}

/** Who is calling, and what `http.ts` needs to answer them. Null when the instance has no sign-in at all (404). */
export async function publishingContext(): Promise<{ caller: Caller | null; deps: Deps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  const owns = async (accountId: string, id: number) =>
    (await (await connectionService()).get(accountId, id)) !== undefined;
  const publications = await publicationService();
  return {
    caller: session
      ? { accountId: session.user.id, name: session.user.name, email: session.user.email }
      : null,
    deps: {
      origin: config.url,
      publish: async (accountId, id, docId, settings) => {
        if (!(await owns(accountId, id))) return { found: false };
        const kind = await documentIn(accountId, id, docId);
        if (kind !== 'document')
          return {
            found: true,
            result: { ok: false, reason: kind === 'unavailable' ? 'unavailable' : 'gone' },
          };
        const passwordHash =
          typeof settings.password === 'string' ? await hashPassword(settings.password) : null;
        return {
          found: true,
          result: {
            ok: true,
            ...(await publications.publish(id, docId, accountId, {
              passwordHash,
              ...(settings.comments ? { comments: settings.comments } : {}),
            })),
          },
        };
      },
      status: async (accountId, id, docId) => {
        if (!(await owns(accountId, id))) return { found: false };
        const status = await publications.status(id, docId);
        const token = status ? await publications.address(id, docId) : undefined;
        return {
          found: true,
          publishedAt: status?.publishedAt ?? null,
          passwordProtected: status?.passwordProtected ?? false,
          comments: status?.comments ?? 'off',
          ...(token ? { token } : {}),
        };
      },
      update: async (accountId, id, docId, settings) => {
        if (!(await owns(accountId, id))) return { found: false };
        const passwordHash =
          settings.password === undefined
            ? undefined
            : settings.password === null
              ? null
              : await hashPassword(settings.password);
        return {
          found: true,
          updated: await publications.update(id, docId, {
            ...(passwordHash !== undefined ? { passwordHash } : {}),
            ...(settings.comments ? { comments: settings.comments } : {}),
          }),
        };
      },
      unpublish: async (accountId, id, docId) =>
        !(await owns(accountId, id))
          ? { found: false }
          : { found: true, unpublished: await publications.unpublish(id, docId) },
    },
  };
}

/** The same for `/api/connections/<id>/publication/copy` (ROADMAP 3h.2): a copy of a file of an encrypted vault, which the browser decrypted. */
export async function copyContext(): Promise<{ caller: Caller | null; deps: CopyDeps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  const owns = async (accountId: string, id: number) =>
    (await (await connectionService()).get(accountId, id)) !== undefined;
  const publications = await publicationService();
  return {
    caller: session
      ? { accountId: session.user.id, name: session.user.name, email: session.user.email }
      : null,
    deps: {
      origin: config.url,
      publish: async (accountId, id, input) => {
        const connection = await (await connectionService()).get(accountId, id);
        if (!connection) return { found: false };
        const outcome = await readConnection(accountId, connection);
        if (!outcome.ok) return { found: true, result: { ok: false, reason: 'unavailable' } };
        // Only a file of an encrypted vault is published as a copy: a plaintext one is read from the repository, and never held here.
        if (checkVault(outcome.read.discovery.vaults, input.path) !== 'encrypted_vault')
          return { found: true, result: { ok: false, reason: 'not_encrypted' } };
        return {
          found: true,
          result: {
            ok: true,
            ...(await publications.publishCopy(id, input.path, accountId, {
              title: input.title,
              body: input.body,
            })),
          },
        };
      },
      status: async (accountId, id, path) => {
        if (!(await owns(accountId, id))) return { found: false };
        const status = await publications.status(id, copyKey(path));
        const token = status ? await publications.address(id, copyKey(path)) : undefined;
        return {
          found: true,
          publishedAt: status?.publishedAt ?? null,
          ...(token ? { token } : {}),
        };
      },
      unpublish: async (accountId, id, path) =>
        !(await owns(accountId, id))
          ? { found: false }
          : { found: true, unpublished: await publications.unpublish(id, copyKey(path)) },
    },
  };
}
