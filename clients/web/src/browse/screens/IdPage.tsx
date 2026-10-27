import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { AccountHeader } from "../../auth/screens/AccountHeader";
import styles from "../../auth/screens/screens.module.css";
import { localAuthConfig, requireSession } from "../../auth/server";
import { connectionService } from "../../connections/server";
import { encryptionKeyring } from "../../crypto/server";
import { Alert, Badge, Card } from "../../ui";
import { SharedBody } from "../../sharing/SharedBody";
import { openLinkedFor, openSharedFor } from "../../sharing/server";
import { isDocId } from "../ids";
import { repositoryHref } from "../links";
import { findDocId } from "../server";
import { RepositoryScreen } from "./RepositoryScreen";

/**
 * `/doc/<id>` and `/note/<id>` (DESIGN.md §9, ROADMAP 1b.6): a file by its Doc `id`, wherever it is among the account's own
 * repositories. One match is shown as `/repo/<connection>/<path>` is, at this address; a note asked for as a document (or the
 * other way round) is sent to the address that is its own; several (an id is unique within a repository, not across them, and a
 * copy is a copy) are listed to choose from; none is a 404, and an id that is not one is too. Another account's file is none.
 */
export async function IdPage({ route, id, token }: { route: "doc" | "note"; id: string; token?: string | undefined }) {
  // A share link (ROADMAP 1c.3) needs no account. A token that opens nothing now (never made, for another document, expired or
  // revoked) is not told apart from one that was never given: the page is then what it is for anyone who has no link.
  if (route === "doc" && token !== undefined && isDocId(id) && encryptionKeyring() !== undefined) {
    const linked = await openLinkedFor(token, id);
    if (linked) {
      return (
        <main className={styles.page}>
          <div className={styles.account}>
            <h1 className={styles.title}>{linked.title}</h1>
            <Card as="article" padding="lg">
              <p className={styles.itemMeta}>
                Shared with you by a link <Badge>{linked.role === "view" ? "Can view" : linked.role === "comment" ? "Can comment" : "Can edit"}</Badge>
              </p>
              {linked.role === "view" ? null : <p className={styles.itemMeta}>Commenting and editing a shared document come later; for now it is shown to read.</p>}
              <SharedBody title={linked.title} body={linked.body} />
            </Card>
          </div>
        </main>
      );
    }
  }
  const { user } = await requireSession();
  if (!isDocId(id) || encryptionKeyring() === undefined) notFound();

  const found = await findDocId(user.id, id);
  const [only, ...others] = found.matches;
  if (only === undefined && route === "doc") {
    // Not in any repository of theirs: it may have been shared with them (ROADMAP 1c.2), and then it is shown to be read.
    const shared = await openSharedFor(user.id, id);
    if (shared) {
      return (
        <Shell user={user} title={shared.title}>
          <p className={styles.itemMeta}>
            Shared with you{shared.sharedBy ? ` by ${shared.sharedBy}` : ""} <Badge>{shared.role === "view" ? "Can view" : shared.role === "comment" ? "Can comment" : "Can edit"}</Badge>
          </p>
          {shared.role === "view" ? null : <p className={styles.itemMeta}>Commenting and editing a shared document come later; for now it is shown to read.</p>}
          <SharedBody title={shared.title} body={shared.body} />
        </Shell>
      );
    }
  }
  if (only === undefined) {
    // The search stopped at its limit, or a repository could not be asked: that is not the same as there being no such file.
    if (found.incomplete || found.unreachable) {
      return (
        <Shell user={user} title="Not found yet">
          <Alert variant="info" heading={found.incomplete ? "Still looking" : "Some repositories could not be read"}>
            {found.incomplete
              ? "There are more files than could be searched at once. What was searched is remembered, so trying again goes further."
              : "A repository could not be reached just now, so this file may be in it. Try again in a moment."}
          </Alert>
        </Shell>
      );
    }
    notFound();
  }

  if (others.length === 0) {
    const own = only.kind === "document" ? "doc" : "note";
    if (own !== route) redirect(`/${own}/${id}`);
    return <RepositoryScreen connection={String(only.connectionId)} path={only.path.split("/")} />;
  }

  const connections = await (await connectionService()).list(user.id);
  const named = new Map(connections.map((connection) => [connection.id, `${connection.owner}/${connection.name}`]));
  return (
    <Shell user={user} title="More than one file has this id">
      <p>
        Each of these says it is the one with this id. Ids are meant to be unique within a repository, so one of them is probably a copy of another. Choose
        the one you mean.
      </p>
      <ul aria-label="Files with this id">
        {found.matches.map((match) => (
          <li key={`${match.connectionId}/${match.path}`}>
            <a href={repositoryHref(match.connectionId, ...match.path.split("/"))}>{match.path}</a>{" "}
            <span className={styles.itemMeta}>
              {match.kind === "document" ? "Document" : "Note"} in {named.get(match.connectionId) ?? "a repository"}
            </span>
          </li>
        ))}
      </ul>
    </Shell>
  );

}

function Shell({ user, title, children }: { user: { name: string; email: string }; title: string; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} security={localAuthConfig() !== undefined} />
      <div className={styles.account}>
        <h1 className={styles.title}>{title}</h1>
        <Card as="article" padding="lg">
          {children}
        </Card>
      </div>
    </main>
  );
}
