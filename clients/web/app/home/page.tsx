import { AccountHeader } from "../../src/auth/screens/AccountHeader";
import { requireSession } from "../../src/auth/server";
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
  return (
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} />
      <div className={styles.account}>
        <Card as="article" padding="lg">
          <h1 className={styles.title}>Hello, {user.name}</h1>
          <p className={styles.lead}>You are signed in as {user.email}.</p>
          <Alert variant="info" heading="Repositories are next">
            Connecting a Git repository and browsing your documents are the next things to be built. For now you can set up how you sign in.
          </Alert>
          <p style={{ marginTop: "var(--sv-space-5)" }}>
            <a href="/account/security">Account security</a>
          </p>
        </Card>
      </div>
    </main>
  );
}
