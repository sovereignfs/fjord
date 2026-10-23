import { AccountHeader } from "../../src/auth/screens/AccountHeader";
import { localAuthConfig, requireSession } from "../../src/auth/server";
import { Alert, Card } from "../../src/ui";
import styles from "../../src/auth/screens/screens.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home" };

/**
 * What someone signed in sees at `/` (the proxy shows this page there). It will be the default
 * repository's view (ROADMAP 1a.9); until there are repositories it says so.
 */
export default async function HomePage() {
  const { user } = await requireSession();
  const security = localAuthConfig() !== undefined;
  return (
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} security={security} />
      <div className={styles.account}>
        <Card as="article" padding="lg">
          <h1 className={styles.title}>Hello, {user.name}</h1>
          <p className={styles.lead}>You are signed in as {user.email}.</p>
          <Alert variant="info" heading="Browsing is next">
            You can connect a repository now; browsing and editing its documents are the next things to be built.{security ? " You can also set up how you sign in." : ""}
          </Alert>
          <p style={{ marginTop: "var(--sv-space-5)" }}>
            <a href="/repositories">Repositories</a>
          </p>
          {security ? (
            <p style={{ marginTop: "var(--sv-space-5)" }}>
              <a href="/account/security">Account security</a>
            </p>
          ) : null}
        </Card>
      </div>
    </main>
  );
}
