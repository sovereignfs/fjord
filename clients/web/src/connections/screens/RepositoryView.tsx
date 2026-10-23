import { AccountHeader } from "../../auth/screens/AccountHeader";
import { Badge, Card } from "../../ui";
import type { ConnectionInfo } from "../service";
import { MakeDefaultButton } from "./MakeDefaultButton";
import styles from "../../auth/screens/screens.module.css";

/**
 * A repository's page: which one it is, a way to move between the account's repositories, and,
 * for now, a note that its documents are the next thing to be built (ROADMAP 1a.11). `/` shows the
 * default repository's, and `/p/<id>` any of the account's own.
 */
export function RepositoryView({
  user,
  connections,
  current,
  security,
}: {
  user: { name: string; email: string };
  connections: ConnectionInfo[];
  current: ConnectionInfo;
  security: boolean;
}) {
  const label = `${current.owner}/${current.name}`;
  return (
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} security={security} />
      <div className={styles.account}>
        <h1 className={styles.title}>{label}</h1>
        <p className={styles.lead}>
          Branch {current.branch}
          {current.isDefault ? (
            <>
              {" "}
              <Badge>Default</Badge>
            </>
          ) : null}
        </p>
        <Card as="article" padding="lg">
          <p>Its documents and notes will be listed here: browsing a repository is the next thing to be built.</p>
          {current.isDefault ? null : <MakeDefaultButton id={current.id} label={label} />}
        </Card>
        {connections.length > 1 ? (
          <Card as="div" padding="lg">
            <h2 className={styles.title} style={{ fontSize: "var(--sv-font-size-lg)" }}>
              Your repositories
            </h2>
            <ul className={styles.list} aria-label="Your repositories">
              {connections.map((connection) => (
                <li key={connection.id} className={styles.item}>
                  <a href={`/p/${connection.id}`} aria-current={connection.id === current.id ? "page" : undefined}>
                    {connection.owner}/{connection.name}
                  </a>
                  {connection.isDefault ? <Badge>Default</Badge> : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <p>
          <a href="/repositories">Connect or disconnect repositories</a>
        </p>
      </div>
    </main>
  );
}
