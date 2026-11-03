import { DocIndex } from "../browse/doc-index";
import { authConfig, getSession } from "../auth/server";
import { connectionService } from "../connections/server";
import { getDatabase } from "../db/boot";
import { fjord } from "../format/wasm";
import { documentIn, sourceOfOwner } from "../sharing/server";
import type { Caller } from "../working/http";
import { checkVault } from "../files/create";
import { readConnection } from "../browse/server";
import type { Deps as CopyDeps } from "./copy-http";
import type { Deps } from "./http";
import { openPublished } from "./open";
import { PublicationService, copyKey } from "./publications";

/** The page a token is the address of, for whoever asks: its title and rendered body, or nothing. */
export async function openPublishedFor(token: string): Promise<{ title: string; html: string } | undefined> {
  const database = await getDatabase();
  return openPublished({ publications: new PublicationService(database), sourceOf: await sourceOfOwner(), index: new DocIndex(database), format: fjord() }, token);
}

/** Who is calling, and what `http.ts` needs to answer them. Null when the instance has no sign-in at all (404). */
export async function publishingContext(): Promise<{ caller: Caller | null; deps: Deps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  const owns = async (accountId: string, id: number) => (await (await connectionService()).get(accountId, id)) !== undefined;
  const publications = new PublicationService(await getDatabase());
  return {
    caller: session ? { accountId: session.user.id, name: session.user.name, email: session.user.email } : null,
    deps: {
      origin: config.url,
      publish: async (accountId, id, docId) => {
        if (!(await owns(accountId, id))) return { found: false };
        const kind = await documentIn(accountId, id, docId);
        if (kind !== "document") return { found: true, result: { ok: false, reason: kind === "unavailable" ? "unavailable" : "gone" } };
        return { found: true, result: { ok: true, ...(await publications.publish(id, docId, accountId)) } };
      },
      status: async (accountId, id, docId) => (!(await owns(accountId, id)) ? { found: false } : { found: true, publishedAt: (await publications.status(id, docId))?.publishedAt ?? null }),
      unpublish: async (accountId, id, docId) => (!(await owns(accountId, id)) ? { found: false } : { found: true, unpublished: await publications.unpublish(id, docId) }),
    },
  };
}

/** The same for `/api/connections/<id>/publication/copy` (ROADMAP 3h.2): a copy of a file of an encrypted vault, which the browser decrypted. */
export async function copyContext(): Promise<{ caller: Caller | null; deps: CopyDeps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  const owns = async (accountId: string, id: number) => (await (await connectionService()).get(accountId, id)) !== undefined;
  const publications = new PublicationService(await getDatabase());
  return {
    caller: session ? { accountId: session.user.id, name: session.user.name, email: session.user.email } : null,
    deps: {
      origin: config.url,
      publish: async (accountId, id, input) => {
        const connection = await (await connectionService()).get(accountId, id);
        if (!connection) return { found: false };
        const outcome = await readConnection(accountId, connection);
        if (!outcome.ok) return { found: true, result: { ok: false, reason: "unavailable" } };
        // Only a file of an encrypted vault is published as a copy: a plaintext one is read from the repository, and never held here.
        if (checkVault(outcome.read.discovery.vaults, input.path) !== "encrypted_vault") return { found: true, result: { ok: false, reason: "not_encrypted" } };
        return { found: true, result: { ok: true, ...(await publications.publishCopy(id, input.path, accountId, { title: input.title, body: input.body })) } };
      },
      status: async (accountId, id, path) => (!(await owns(accountId, id)) ? { found: false } : { found: true, publishedAt: (await publications.status(id, copyKey(path)))?.publishedAt ?? null }),
      unpublish: async (accountId, id, path) => (!(await owns(accountId, id)) ? { found: false } : { found: true, unpublished: await publications.unpublish(id, copyKey(path)) }),
    },
  };
}
