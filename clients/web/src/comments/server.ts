import { authConfig, getSession } from "../auth/server";
import { DocIndex } from "../browse/doc-index";
import { connectionService } from "../connections/server";
import { getDatabase } from "../db/boot";
import type { Grant } from "../access/policy";
import { proofIsRight } from "../sharing/password";
import { LinkService } from "../sharing/links";
import { ShareService } from "../sharing/shares";
import { parseShareCookie } from "../sharing/unlock";
import { type AccessDeps, type Viewer, commentsAccess, commentsWatch } from "./access";
import { commentBus } from "./bus";
import type { EventDeps } from "./events";
import type { Caller, Deps } from "./http";
import { CommentService } from "./service";

/**
 * Who is asking about a document's comments, and what that lets them (ROADMAP 1d.1): the owner (a document of one of their connections), a
 * named account it was shared with, and/or the holder of a link's cookie. Each gives a grant for the policy to decide on, and the
 * connection the comments are kept under. The owner's is read from what the index recorded of their own connections' files, so it cannot be
 * claimed; a share and a link are looked up by what they name.
 */
async function viewerOf(input: { docId: string; account: { id: string; name: string } | undefined; cookie: string | undefined }): Promise<Viewer | undefined> {
  const database = await getDatabase();
  let found: { connectionId: number; grants: Grant[] } | undefined;

  if (input.account) {
    const ids = (await (await connectionService()).list(input.account.id)).map((connection) => connection.id);
    const owned = (await new DocIndex(database).find(ids, input.docId)).find((row) => row.file.kind === "document");
    if (owned) found = { connectionId: owned.connectionId, grants: [{ kind: "owner" }] };
    else {
      const shared = (await new ShareService(database).find(input.account.id, input.docId))[0];
      if (shared) found = { connectionId: shared.connectionId, grants: [{ kind: "user", role: shared.role }] };
    }
  }

  let linkId: number | undefined;
  if (!found && input.cookie !== undefined) {
    const config = authConfig();
    const { token, proof } = parseShareCookie(input.cookie);
    const link = await new LinkService(database).byToken(token);
    const proven = link && (link.passwordHash === null || (config.enabled && proofIsRight(config.secret, link.id, link.passwordHash, proof)));
    if (link && proven && link.docId === input.docId) {
      found = { connectionId: link.connectionId, grants: [{ kind: "link", role: link.role, expiresAt: link.expiresAt, revoked: link.revokedAt !== null }] };
      linkId = link.id;
    }
  }
  if (!found) return undefined;
  return { connectionId: found.connectionId, grants: found.grants, ...(input.account ? { account: input.account } : {}), ...(linkId === undefined ? {} : { linkId }) };
}

export async function commentsContext(): Promise<{ caller: Caller | null; deps: Deps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  const deps: AccessDeps = { viewer: viewerOf, comments: commentService(await getDatabase()) };
  return { caller: session ? { accountId: session.user.id, name: session.user.name } : null, deps: { origin: config.url, run: commentsAccess(deps) } };
}

/** The service, which tells the live streams of this process when it changes something (ROADMAP 1d.3). */
const commentService = (database: Awaited<ReturnType<typeof getDatabase>>) => new CommentService(database, Date.now, (connectionId, docId) => commentBus().publish(connectionId, docId));

/** The same, for the live stream of a document's comments (ROADMAP 1d.3). */
export async function eventsContext(): Promise<{ caller: Caller | null; deps: EventDeps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  const comments = commentService(await getDatabase());
  return { caller: session ? { accountId: session.user.id, name: session.user.name } : null, deps: { open: commentsWatch({ viewer: viewerOf, comments, subscribe: (connectionId, docId, listener) => commentBus().subscribe(connectionId, docId, listener) }) } };
}
