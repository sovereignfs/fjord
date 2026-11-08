import { connectionService } from '../../connections/server';
import { encryptionKeyring } from '../../crypto/server';
import { KeyManager } from '../../keys/screens/KeyManager';
import { Alert, Card } from '@sovereignfs/ui';
import { oauthErrorMessage } from '../messages';
import { listAccounts, localAuthConfig, sovereignAuthConfig } from '../server';
import { type AccountQuery, sectionOf } from './account-query';
import { AccountShell } from './AccountShell';
import { AccountTabs } from './AccountTabs';
import { PreferencesSection } from './PreferencesSection';
import { ProfileSection } from './ProfileSection';
import { PasskeysSection } from './security/PasskeysSection';
import { PasswordSection } from './security/PasswordSection';
import { SovereignSection } from './security/SovereignSection';
import { TwoFactorSection } from './security/TwoFactorSection';
import styles from './screens.module.css';

export type { AccountQuery } from './account-query';

/**
 * The account, in one place (the owner's request, after the legacy Sovereign's account dialog): *Profile*, *Security* and *Preferences*, as a dialog over the page it was opened
 * from, or at an address of its own as a page. Security is what it was: the encryption identity kept in this browser (ROADMAP 2a.1), and the security of the sign-in: a password,
 * two-factor, passkeys, and the link to Sovereign (the local methods' and Sovereign's, so an instance that signs in only through Sovereign has none of it and shows just the key).
 * Nothing about the key is known to the server: the component that keeps it runs in the browser.
 */
export async function AccountPanel({
  user,
  query,
}: {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null | undefined;
    twoFactorEnabled?: boolean | null | undefined;
  };
  query: AccountQuery;
}) {
  const connections =
    encryptionKeyring() !== undefined ? await (await connectionService()).list(user.id) : [];
  const signIns = await listAccounts();
  const deleting = {
    hasPassword: signIns.some((account) => account.providerId === 'credential'),
    onServer: connections
      .filter((connection) => connection.provider === 'local')
      .map((connection) => connection.name),
    inGit: connections.filter((connection) => connection.provider !== 'local').length,
  };
  return (
    <AccountShell
      initial={sectionOf(query)}
      profile={
        <ProfileSection
          name={user.name}
          email={user.email}
          image={user.image}
          editable={localAuthConfig() !== undefined}
          deleting={deleting}
          sovereignLinked={signIns.some((account) => account.providerId === 'sovereign')}
        />
      }
      security={await securityOf(user, query)}
      preferences={<PreferencesSection />}
    />
  );
}

async function securityOf(
  user: { twoFactorEnabled?: boolean | null | undefined; email: string },
  query: AccountQuery,
) {
  const keys = (
    <Card as="div" padding="lg">
      <KeyManager />
    </Card>
  );
  const config = localAuthConfig();
  if (!config) return <AccountTabs initial="keys" keys={keys} security={null} />;

  const accounts = await listAccounts();
  // A person who came in through Sovereign has no password, and so nothing of a password's: not the
  // password itself, not two-factor (which asks for it) and not passkeys, which Sovereign has its own of.
  const hasPassword = accounts.some((account) => account.providerId === 'credential');
  const sovereignAccount = accounts.find((account) => account.providerId === 'sovereign');
  const sovereign = sovereignAuthConfig() !== undefined;
  const twoFactorOn = user.twoFactorEnabled === true;
  const problem = oauthErrorMessage(query.error);

  const security = (
    <div className={styles.workspace}>
      {problem ? (
        <div className={styles.notice}>
          <Alert variant="error">{problem}</Alert>
        </div>
      ) : null}
      {query.linked === '1' && sovereignAccount ? (
        <div className={styles.notice}>
          <Alert variant="success">Sovereign is linked. You can sign in with it now.</Alert>
        </div>
      ) : null}
      {query.unlinked === '1' && !sovereignAccount ? (
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
          <h2 className={styles.title} style={{ fontSize: 'var(--sv-font-size-lg)' }}>
            You sign in with Sovereign
          </h2>
          <p>
            This account has no password: Sovereign is how you sign in, and its password, two-factor
            and passkeys are managed there.
          </p>
        </Card>
      )}
      {sovereign ? (
        <Card as="div" padding="lg">
          <SovereignSection
            linkedAccountId={sovereignAccount?.id ?? null}
            canUnlink={hasPassword}
            email={user.email}
            twoFactorOn={twoFactorOn}
          />
        </Card>
      ) : null}
    </div>
  );
  // General is what opens, and so it is for the way back from linking Sovereign, or its failure; only `?tab=keys` opens the key.
  const initial = query.tab === 'keys' ? 'keys' : 'general';
  return <AccountTabs initial={initial} keys={keys} security={security} />;
}
