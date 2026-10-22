import { AccountHeader } from "../../../src/auth/screens/AccountHeader";
import { PasskeysSection } from "../../../src/auth/screens/security/PasskeysSection";
import { PasswordSection } from "../../../src/auth/screens/security/PasswordSection";
import { TwoFactorSection } from "../../../src/auth/screens/security/TwoFactorSection";
import { localAuthConfig, requireSession } from "../../../src/auth/server";
import { Card } from "../../../src/ui";
import styles from "../../../src/auth/screens/screens.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account security" };

export default async function SecurityPage() {
  const { user } = await requireSession();
  const config = localAuthConfig();

  return (
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} />
      <div className={styles.account}>
        <h1 className={styles.title}>Account security</h1>
        <Card as="div" padding="lg">
          <PasswordSection minLength={config?.passwordMinLength ?? 10} />
        </Card>
        <Card as="div" padding="lg">
          <TwoFactorSection enabled={user.twoFactorEnabled === true} />
        </Card>
        <Card as="div" padding="lg">
          <PasskeysSection />
        </Card>
      </div>
    </main>
  );
}
