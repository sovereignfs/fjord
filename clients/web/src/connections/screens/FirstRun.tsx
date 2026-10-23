import { AccountHeader } from "../../auth/screens/AccountHeader";
import { Alert, Card } from "../../ui";
import { ConnectForm } from "./ConnectForm";
import styles from "../../auth/screens/screens.module.css";

/**
 * What someone sees at `/` before they have connected a repository: the one thing to do next. The
 * first one they connect becomes their default, and `/` is that repository from then on.
 */
export function FirstRun({ user, canConnect, security }: { user: { name: string; email: string }; canConnect: boolean; security: boolean }) {
  return (
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} security={security} />
      <div className={styles.account}>
        <h1 className={styles.title}>Hello, {user.name}</h1>
        <p className={styles.lead}>You are signed in as {user.email}. Fjord works on a Git repository of yours: connect your first one to begin.</p>
        <Card as="div" padding="lg">
          {canConnect ? (
            <ConnectForm heading="Connect your first repository" />
          ) : (
            <Alert variant="info" heading="Repositories cannot be connected yet">
              This instance has no encryption key, which it needs to keep an access token safely. Whoever runs it can set <code>FJORD_ENCRYPTION_KEY</code> (<code>openssl rand -base64 32</code>) and
              restart it.
            </Alert>
          )}
        </Card>
      </div>
    </main>
  );
}
