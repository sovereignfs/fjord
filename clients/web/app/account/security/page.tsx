import { notFound } from "next/navigation";
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
  // The settings here are the local methods': an instance that signs people in only through
  // Sovereign has none, and nothing here to show.
  const config = localAuthConfig();
  if (!config) notFound();

  return (
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} security />
      <div className={styles.account}>
        <h1 className={styles.title}>Account security</h1>
        <Card as="div" padding="lg">
          <PasswordSection minLength={config.passwordMinLength} />
        </Card>
        <Card as="div" padding="lg">
          <TwoFactorSection enabled={"twoFactorEnabled" in user && user.twoFactorEnabled === true} />
        </Card>
        <Card as="div" padding="lg">
          <PasskeysSection />
        </Card>
      </div>
    </main>
  );
}
