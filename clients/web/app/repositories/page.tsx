import { AccountHeader } from "../../src/auth/screens/AccountHeader";
import { localAuthConfig, requireSession } from "../../src/auth/server";
import { connectionService } from "../../src/connections/server";
import { ConnectForm } from "../../src/connections/screens/ConnectForm";
import { ConnectionList } from "../../src/connections/screens/ConnectionList";
import { GitHubAppPanel } from "../../src/connections/screens/GitHubAppPanel";
import { encryptionKeyring } from "../../src/crypto/server";
import { gitHubApp } from "../../src/github-app/server";
import { Alert, Card } from "../../src/ui";
import styles from "../../src/auth/screens/screens.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repositories" };

/** The repositories this account has connected, and a way to connect another. */
export default async function RepositoriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requireSession();
  const query = await searchParams;
  const one = (name: string) => (typeof query[name] === "string" ? (query[name] as string) : undefined);
  // Without an instance key nothing can be stored, so there is nothing to list and no form to offer.
  const canConnect = encryptionKeyring() !== undefined;
  const connections = canConnect ? await (await connectionService()).list(user.id) : [];

  return (
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} security={localAuthConfig() !== undefined} />
      <div className={styles.account}>
        <h1 className={styles.title}>Repositories</h1>
        {canConnect ? (
          <>
            <Card as="div" padding="lg">
              <ConnectionList connections={connections} />
            </Card>
            {gitHubApp() ? (
              <Card as="div" padding="lg">
                <GitHubAppPanel result={{ github_app: one("github_app"), added: one("added"), already: one("already"), skipped: one("skipped") }} />
              </Card>
            ) : null}
            <Card as="div" padding="lg">
              <ConnectForm heading={gitHubApp() ? "Or connect one repository with a token" : "Connect a repository"} />
            </Card>
          </>
        ) : (
          <Card as="div" padding="lg">
            <Alert variant="info" heading="Repositories cannot be connected yet">
              This instance has no encryption key, which it needs to keep an access token safely. Whoever runs it can set <code>FJORD_ENCRYPTION_KEY</code> (<code>openssl rand -base64 32</code>) and
              restart it.
            </Alert>
          </Card>
        )}
      </div>
    </main>
  );
}
