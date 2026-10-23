import { notFound } from "next/navigation";
import { oauthErrorMessage } from "../../../src/auth/messages";
import { AccountHeader } from "../../../src/auth/screens/AccountHeader";
import { PasskeysSection } from "../../../src/auth/screens/security/PasskeysSection";
import { PasswordSection } from "../../../src/auth/screens/security/PasswordSection";
import { SovereignSection } from "../../../src/auth/screens/security/SovereignSection";
import { TwoFactorSection } from "../../../src/auth/screens/security/TwoFactorSection";
import { listAccounts, localAuthConfig, requireSession, sovereignAuthConfig } from "../../../src/auth/server";
import { Alert, Card } from "../../../src/ui";
import styles from "../../../src/auth/screens/screens.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account security" };

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ error?: string; linked?: string; unlinked?: string }> }) {
  const { user } = await requireSession();
  // The settings here are the local methods' and Sovereign's link to them: an instance that signs
  // people in only through Sovereign has none, and nothing here to show.
  const config = localAuthConfig();
  if (!config) notFound();
  const { error, linked, unlinked } = await searchParams;

  const accounts = await listAccounts();
  // A person who came in through Sovereign has no password, and so nothing of a password's: not the
  // password itself, not two-factor (which asks for it) and not passkeys, which Sovereign has its own of.
  const hasPassword = accounts.some((account) => account.providerId === "credential");
  const sovereignAccount = accounts.find((account) => account.providerId === "sovereign");
  const sovereign = sovereignAuthConfig() !== undefined;
  const twoFactorOn = "twoFactorEnabled" in user && user.twoFactorEnabled === true;
  const problem = oauthErrorMessage(error);

  return (
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} security />
      <div className={styles.account}>
        <h1 className={styles.title}>Account security</h1>
        {problem ? (
          <div className={styles.notice}>
            <Alert variant="error">{problem}</Alert>
          </div>
        ) : null}
        {linked === "1" && sovereignAccount ? (
          <div className={styles.notice}>
            <Alert variant="success">Sovereign is linked. You can sign in with it now.</Alert>
          </div>
        ) : null}
        {unlinked === "1" && !sovereignAccount ? (
          <div className={styles.notice}>
            <Alert variant="success">Sovereign is unlinked.</Alert>
          </div>
        ) : null}
        {hasPassword ? (
          <>
            <Card as="div" padding="lg">
              <PasswordSection minLength={config.passwordMinLength} />
            </Card>
            <Card as="div" padding="lg">
              <TwoFactorSection enabled={twoFactorOn} />
            </Card>
            <Card as="div" padding="lg">
              <PasskeysSection />
            </Card>
          </>
        ) : (
          <Card as="div" padding="lg">
            <h2 className={styles.title} style={{ fontSize: "var(--sv-font-size-lg)" }}>
              You sign in with Sovereign
            </h2>
            <p>This account has no password: Sovereign is how you sign in, and its password, two-factor and passkeys are managed there.</p>
          </Card>
        )}
        {sovereign ? (
          <Card as="div" padding="lg">
            <SovereignSection linkedAccountId={sovereignAccount?.id ?? null} canUnlink={hasPassword} email={user.email} twoFactorOn={twoFactorOn} />
          </Card>
        ) : null}
      </div>
    </main>
  );
}
