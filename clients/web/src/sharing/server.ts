import { findAccountByEmail, findUser } from "../auth/users";
import { readConnection } from "../browse/server";
import { resolveDocId } from "../browse/ids";
import { DocIndex } from "../browse/doc-index";
import { connectionService } from "../connections/server";
import { getAuthDatabase, getDatabase } from "../db/boot";
import { fjord } from "../format/wasm";
import { type AccessDeps, sharingAccess } from "./access";
import { ShareService } from "./shares";
import { type SharedDocument, type SharedListing, asksForPassword, listShared, openByLink, openShared } from "./open";
import { authConfig } from "../auth/server";
import { type UnlockResult, tryUnlock } from "./unlock";
import { RateLimiter } from "../limits/rate";
import { type GuestSave, saveGuestDraft } from "./guest";
import { saveMemberDraft } from "./member";
import { WorkingCopyService } from "../working/service";
import { LinkService } from "./links";
import { linksAccess } from "./links-access";
import { readRepository } from "../browse/repository";
import { heads } from "../browse/head-cache";
import { TreeCache } from "../browse/tree-cache";
import { describeProblem } from "../browse/problems";

/** What a Doc `id` is in one of the account's repositories now: a document, or not there; the host may not answer. */
export async function documentIn(accountId: string, id: number, docId: string): Promise<"document" | "gone" | "unavailable"> {
  const service = await connectionService();
  const connection = await service.get(accountId, id);
  if (!connection) return "gone";
  const outcome = await readConnection(accountId, connection);
  const used = outcome.ok ? await service.provider(accountId, id) : undefined;
  if (!outcome.ok || !used) return "unavailable";
  const source = { connectionId: id, ref: { owner: connection.owner, name: connection.name }, read: outcome.read, provider: used.provider };
  const { matches, incomplete } = await resolveDocId({ index: new DocIndex(await getDatabase()), format: fjord() }, [source], docId);
  if (matches.length > 0) return "document";
  return incomplete ? "unavailable" : "gone";
}

export async function sharingAccessFor(): Promise<ReturnType<typeof sharingAccess>> {
  const accounts = await getAuthDatabase();
  const deps: AccessDeps = {
    owns: async (accountId, id) => (await (await connectionService()).get(accountId, id)) !== undefined,
    documentIn,
    accountByEmail: (email) => findAccountByEmail(accounts, email),
    accountById: (id) => findUser(accounts, id),
    shares: new ShareService(await getDatabase()),
  };
  return sharingAccess(deps);
}

/**
 * The document with this Doc `id`, if it was shared with this account (ROADMAP 1c.2): read with the owner's token, as it is in
 * the repository now. Undefined when nothing was shared, or what was shared is not there.
 */
export async function openSharedFor(accountId: string, docId: string): Promise<SharedDocument | undefined> {
  const database = await getDatabase();
  const accounts = await getAuthDatabase();
  return openShared(
    {
      shares: new ShareService(database),
      sourceOf: await sourceOfOwner(),
      index: new DocIndex(database),
      format: fjord(),
      nameOf: async (id) => (await findUser(accounts, id))?.name,
      drafts: new WorkingCopyService(database),
    },
    accountId,
    docId,
  );
}

/** What was shared with this account, for its *Shared with you* page. */
export async function sharedWithFor(accountId: string): Promise<{ documents: SharedListing[]; unreadable: number }> {
  const database = await getDatabase();
  const accounts = await getAuthDatabase();
  const shares = new ShareService(database);
  return listShared({ shares, sourceOf: await sourceOfOwner(), index: new DocIndex(database), format: fjord(), nameOf: async (id) => (await findUser(accounts, id))?.name }, accountId);
}

/** The server's secret, which the proof that a link's password was given is keyed with. */
function secretOf(): string {
  const config = authConfig();
  if (!config.enabled) throw new Error("sharing needs sign-in settings");
  return config.secret;
}

/**
 * The document a link opens, for whoever presents its token (and, for a link with a password, the proof that it was given). Undefined
 * for a token that opens nothing now.
 */
export async function openLinkedFor(token: string, docId: string, proof?: string): Promise<SharedDocument | undefined> {
  const database = await getDatabase();
  return openByLink({ links: new LinkService(database), sourceOf: await sourceOfOwner(), index: new DocIndex(database), format: fjord(), secret: secretOf(), drafts: new WorkingCopyService(database) }, token, docId, proof);
}

/** Whether to ask for a password for this token and document (ROADMAP 1c.5). */
export async function passwordWanted(token: string, docId: string): Promise<boolean> {
  return asksForPassword({ links: new LinkService(await getDatabase()) }, token, docId);
}

/** Give a link's password (ROADMAP 1c.5): the cookie that opens it if it is right, or why not. */
export async function unlockFor(docId: string, password: unknown, pendingToken: string | undefined): Promise<UnlockResult> {
  return tryUnlock({ links: new LinkService(await getDatabase()), secret: secretOf() }, { docId, password, pendingToken });
}

/** A repository read with its owner's token, for a share or a link that names it; undefined if it cannot be read. */
export async function sourceOfOwner() {
  const database = await getDatabase();
  const service = await connectionService();
  return async (connectionId: number) => {
    const used = await service.providerForShare(connectionId);
    if (!used) return undefined;
    try {
      const read = await readRepository({ provider: used.provider, cache: new TreeCache(database), format: fjord(), heads }, { id: used.id, ref: used.ref, branch: used.branch });
      return { connectionId, ref: used.ref, read, provider: used.provider };
    } catch (error) {
      // The host cannot be reached, or the repository is gone: the share finds nothing, as if it were not there.
      if (describeProblem(error)) return undefined;
      throw error;
    }
  };
}

export async function linksAccessFor(): Promise<ReturnType<typeof linksAccess>> {
  return linksAccess({
    owns: async (accountId, id) => (await (await connectionService()).get(accountId, id)) !== undefined,
    documentIn,
    links: new LinkService(await getDatabase()),
  });
}

/** An edit of a document shared with this account at the edit role: into the document's working copy, for the owner to review. */
export async function saveMemberDraftFor(accountId: string, docId: string, body: string): Promise<GuestSave> {
  const database = await getDatabase();
  return saveMemberDraft({ shares: new ShareService(database), sourceOf: await sourceOfOwner(), index: new DocIndex(database), format: fjord(), drafts: new WorkingCopyService(database), limiter: new RateLimiter(database) }, { accountId, docId, body });
}

/** A guest's edit of a document through a link's cookie (ROADMAP 1c.6): into the document's working copy, under the name they gave. */
export async function saveGuestDraftFor(input: { cookie: string | undefined; docId: string; name: unknown; body: string }): Promise<GuestSave> {
  const database = await getDatabase();
  return saveGuestDraft(
    { links: new LinkService(database), secret: secretOf(), sourceOf: await sourceOfOwner(), index: new DocIndex(database), format: fjord(), drafts: new WorkingCopyService(database), limiter: new RateLimiter(database) },
    input,
  );
}
