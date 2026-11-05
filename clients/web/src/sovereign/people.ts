import { sql } from "drizzle-orm";
import { SOVEREIGN_PROVIDER_ID } from "../auth/config";
import type { Database } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as postgresAuth from "../db/schema/postgres/auth";
import * as sqliteSchema from "../db/schema/sqlite";
import * as sqliteAuth from "../db/schema/sqlite/auth";
import type { Editor } from "../working/service";

/**
 * What Fjord Web does about a person when their Sovereign instance tells it something about them: their core session ended (the
 * back-channel logout), or they deleted their account there (core-app §4.5 in sovereignfs/sovereign; DESIGN.md §17).
 *
 * A person is known to Fjord Web by the `sub` Sovereign signs them in as: the `account_id` of the row better-auth keeps for the provider
 * `sovereign`, whose `user_id` is the Fjord account (`DESIGN.md §6`). Nothing is matched by email.
 *
 * Both are safe to run again. A deletion that failed half way is answered `500`, Sovereign sends it again with a new token, and what was
 * done is not done twice: each step deletes what is there, and the row that links the `sub` to the account goes last, so that a second run
 * can still find the account.
 */

/** What replaces the author of a comment that others have answered, and the name in a log or a resolution: nothing of the person remains. */
export const DELETED_AUTHOR = "Deleted account";
/** What replaces the words of a comment that others have answered. */
export const DELETED_COMMENT = "This comment was deleted.";

/** What the account's connections are removed through (`ConnectionService`), so that this has one way to remove a repository and not two. */
export interface ConnectionRemover {
  removeAll(accountId: string): Promise<number>;
}

export interface PeopleDeps {
  /** The app's store: connections, shares, comments, drafts. */
  app: Database;
  /** better-auth's store: accounts and sessions. */
  auth: Database;
  connections: ConnectionRemover;
}

const authTables = (database: Database) => (database.dialect === "postgres" ? postgresAuth : sqliteAuth);
const appTables = (database: Database) => (database.dialect === "postgres" ? postgresSchema : sqliteSchema);

export class People {
  constructor(private readonly deps: PeopleDeps) {}

  /** The Fjord accounts a `sub` is linked to. Normally one; none when the person never signed in here, or everything is already gone. */
  async accountsOf(sub: string): Promise<string[]> {
    const { account } = authTables(this.deps.auth);
    const rows = await dbAll<{ userId: string }>(
      this.deps.auth,
      sql`SELECT user_id AS "userId" FROM ${account} WHERE provider_id = ${SOVEREIGN_PROVIDER_ID} AND account_id = ${sub}`,
    );
    return [...new Set(rows.map((row) => row.userId))];
  }

  /**
   * Ends every session the person has here. A logout token names the core session (`sid`) too, but Fjord Web does not keep core's `sid`,
   * and ending only some of a person's sessions on a guess would leave others open after they signed out, so it ends them all: signing out of
   * the instance signs the person out of Fjord Web everywhere. Returns how many sessions ended.
   */
  async endSessions(sub: string): Promise<number> {
    let ended = 0;
    const { session } = authTables(this.deps.auth);
    for (const userId of await this.accountsOf(sub)) {
      const rows = await dbAll<{ id: string }>(this.deps.auth, sql`SELECT id FROM ${session} WHERE user_id = ${userId}`);
      await dbRun(this.deps.auth, sql`DELETE FROM ${session} WHERE user_id = ${userId}`);
      ended += rows.length;
    }
    return ended;
  }

  /** Deletes what Fjord Web holds of the person, and the account. Nothing in a repository is touched: the files are theirs, in their git host. */
  async deletePerson(sub: string): Promise<void> {
    for (const userId of await this.accountsOf(sub)) await this.deleteAccount(userId);
    // Last, so that a run that stopped before here can be run again and still find the account.
    const { account } = authTables(this.deps.auth);
    await dbRun(this.deps.auth, sql`DELETE FROM ${account} WHERE provider_id = ${SOVEREIGN_PROVIDER_ID} AND account_id = ${sub}`);
  }

  /**
   * A person deletes their own account, from a signed-in session (`src/account/`): the same as Sovereign's notice, and the row that would link their `sub` goes with it, because nothing
   * will come to run it again for them.
   */
  async deleteOwnAccount(userId: string): Promise<void> {
    await this.deleteAccount(userId);
    const { account } = authTables(this.deps.auth);
    await dbRun(this.deps.auth, sql`DELETE FROM ${account} WHERE user_id = ${userId}`);
  }

  private async deleteAccount(userId: string): Promise<void> {
    const { auth } = this.deps;
    const { user, session, account, passkey, twoFactor, verification } = authTables(auth);
    const who = await dbGet<{ name: string; email: string }>(auth, sql`SELECT name, email FROM ${user} WHERE id = ${userId}`);

    // The app's store first. A person with sessions open can no longer reach it once their sessions are gone, so end them now: nothing they
    // do while this runs is kept.
    await dbRun(auth, sql`DELETE FROM ${session} WHERE user_id = ${userId}`);
    await this.deleteAppData(userId, who?.name);

    await dbRun(auth, sql`DELETE FROM ${passkey} WHERE user_id = ${userId}`);
    await dbRun(auth, sql`DELETE FROM ${twoFactor} WHERE user_id = ${userId}`);
    // A link to verify an address, or to reset a password: by the address it was sent to, or by the account it is for.
    if (who) await dbRun(auth, sql`DELETE FROM ${verification} WHERE identifier = ${who.email} OR value = ${userId}`);
    else await dbRun(auth, sql`DELETE FROM ${verification} WHERE value = ${userId}`);
    // The accounts linked to it (its Sovereign sign-in, and a password if it has one), then the person. Where foreign keys are enforced the
    // second is a cascade of the first, and where they are not (SQLite by default) this is what does it.
    await dbRun(auth, sql`DELETE FROM ${account} WHERE user_id = ${userId} AND provider_id <> ${SOVEREIGN_PROVIDER_ID}`);
    await dbRun(auth, sql`DELETE FROM ${user} WHERE id = ${userId}`);
  }

  private async deleteAppData(userId: string, name: string | undefined): Promise<void> {
    const { app } = this.deps;
    const t = appTables(app);

    // Comments first, while the shares that say which documents the person could reach are still there.
    await this.deleteComments(userId, name);

    // Their repositories, with what hangs on each: trees, drafts, the record of deletions, the index, shares, links, sealed copies, the comments on
    // those documents and the credential. (Their own comments on those go with them.)
    await this.deps.connections.removeAll(userId);

    // What was shared with them, and where they were an editor of someone else's draft. (What they typed stays in the draft, which is the
    // owner's; the list of who edited it, which would credit them in a version, no longer names them.)
    await dbRun(app, sql`DELETE FROM ${t.shareUser} WHERE account_id = ${userId}`);
    await dbRun(app, sql`DELETE FROM ${t.accountDefault} WHERE account_id = ${userId}`);
    await this.forgetEditor(userId);

    // How much they had done in the current window, for the rate limits. (Account ids are not patterns; if one had a `_` it would match more
    // than it should, and a counter is all that is lost.)
    await dbRun(app, sql`DELETE FROM ${t.rateBucket} WHERE "key" LIKE ${`%account:${userId}%`}`);
  }

  /**
   * What the person said on other people's documents (their own repositories' comments went with those): everything they wrote is gone,
   * and nobody else's words are lost with it.
   *
   * - A **reply** of theirs is deleted.
   * - A **thread** they opened that nobody else answered is deleted, with its log.
   * - A thread they opened that others answered stays, so their answers keep what they answered: its opening words become
   *   `DELETED_COMMENT` and its author `DELETED_AUTHOR`.
   * - A log entry or a resolution with their name, in a document they could reach or a thread they took part in, names `DELETED_AUTHOR`. (The
   *   log keeps names and not ids, so this goes by the name they had, and only among the documents above.)
   */
  private async deleteComments(userId: string, name: string | undefined): Promise<void> {
    const { app } = this.deps;
    const t = appTables(app);
    if (name !== undefined) {
      const reachable = sql`EXISTS (SELECT 1 FROM ${t.shareUser} s WHERE s.account_id = ${userId} AND s.connection_id = ${t.commentActivity}.connection_id AND s.doc_id = ${t.commentActivity}.doc_id)`;
      const took = sql`${t.commentActivity}.thread_id IN (SELECT id FROM ${t.commentThread} WHERE author_kind = 'account' AND author_id = ${userId} UNION SELECT thread_id FROM ${t.commentReply} WHERE author_kind = 'account' AND author_id = ${userId})`;
      await dbRun(app, sql`UPDATE ${t.commentActivity} SET actor_name = ${DELETED_AUTHOR} WHERE actor_kind = 'account' AND actor_name = ${name} AND (${reachable} OR ${took})`);
      await dbRun(
        app,
        sql`UPDATE ${t.commentThread} SET resolved_by = ${DELETED_AUTHOR} WHERE resolved_by = ${name}
            AND EXISTS (SELECT 1 FROM ${t.shareUser} s WHERE s.account_id = ${userId} AND s.connection_id = ${t.commentThread}.connection_id AND s.doc_id = ${t.commentThread}.doc_id)`,
      );
    }

    await dbRun(app, sql`DELETE FROM ${t.commentReply} WHERE author_kind = 'account' AND author_id = ${userId}`);
    const unanswered = sql`author_kind = 'account' AND author_id = ${userId} AND NOT EXISTS (SELECT 1 FROM ${t.commentReply} r WHERE r.thread_id = ${t.commentThread}.id)`;
    await dbRun(app, sql`DELETE FROM ${t.commentActivity} WHERE thread_id IN (SELECT id FROM ${t.commentThread} WHERE ${unanswered})`);
    await dbRun(app, sql`DELETE FROM ${t.commentThread} WHERE ${unanswered}`);
    await dbRun(
      app,
      sql`UPDATE ${t.commentThread} SET body = ${DELETED_COMMENT}, author_id = '', author_name = ${DELETED_AUTHOR}
          WHERE author_kind = 'account' AND author_id = ${userId}`,
    );
  }

  /** Takes the person out of the list of who edited each draft they are on. */
  private async forgetEditor(userId: string): Promise<void> {
    const { app } = this.deps;
    const { workingCopy } = appTables(app);
    const rows = await dbAll<{ id: number; editors: string }>(app, sql`SELECT id, editors FROM ${workingCopy} WHERE editors LIKE ${`%${userId}%`}`);
    for (const row of rows) {
      const editors = JSON.parse(row.editors) as Editor[];
      const kept = editors.filter((editor) => !(editor.type === "account" && editor.id === userId));
      if (kept.length !== editors.length) await dbRun(app, sql`UPDATE ${workingCopy} SET editors = ${JSON.stringify(kept)} WHERE id = ${row.id}`);
    }
  }
}
