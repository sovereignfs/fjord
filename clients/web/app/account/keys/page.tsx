import { AccountHeader } from "../../../src/auth/screens/AccountHeader";
import { localAuthConfig, requireSession } from "../../../src/auth/server";
import { KeyManager } from "../../../src/keys/screens/KeyManager";
import { Card } from "../../../src/ui";
import styles from "../../../src/auth/screens/screens.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Encryption identity" };

/** The age identity kept in this browser (ROADMAP 2a.1). Nothing about it is known to the server: the page only hosts the component that keeps it. */
export default async function KeysPage() {
  const { user } = await requireSession();
  return (
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} security={localAuthConfig() !== undefined} />
      <div className={styles.account}>
        <h1 className={styles.title}>Encryption identity</h1>
        <Card as="div" padding="lg">
          <KeyManager />
        </Card>
      </div>
    </main>
  );
}
