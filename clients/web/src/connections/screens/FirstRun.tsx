import { SignedInShell } from "../../auth/screens/SignedInShell";
import { Alert, Card } from "../../ui";
import { localLimits } from "../../local/limits";
import { NewRepositoryForm } from "../../local/screens/NewRepositoryForm";
import { ConnectForm } from "./ConnectForm";
import styles from "../../auth/screens/screens.module.css";

/**
 * What someone sees at `/` before they have connected a repository: the one thing to do next. The
 * first one they connect becomes their default, and `/` is that repository from then on.
 */
export function FirstRun({ user, canConnect, shared = 0 }: { user: { name: string; email: string }; canConnect: boolean; /** How many documents others have shared with this person, who may have come here for them and nothing else. */ shared?: number }) {
  return (
    <SignedInShell user={user} connections={[]} place="index">
      <div className={styles.workspace}>
        <h1 className={styles.title}>Hello, {user.name}</h1>
        <p className={styles.lead}>You are signed in as {user.email}. Fjord works on a Git repository of yours: connect your first one to begin{localLimits().repositories > 0 ? ", or create one here and connect it to git later" : ""}.</p>
        {shared > 0 ? (
          <Alert variant="info" heading={shared === 1 ? "A document is shared with you" : `${shared} documents are shared with you`}>
            <a href="/shared">Open what is shared with you</a>. You need no repository of your own to read it, comment on it or edit it.
          </Alert>
        ) : null}
        {canConnect && localLimits().repositories > 0 ? (
          <Card as="div" padding="lg">
            <NewRepositoryForm heading="Create your first repository" />
          </Card>
        ) : null}
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
    </SignedInShell>
  );
}
