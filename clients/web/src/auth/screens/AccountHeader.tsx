import { SignOutButton } from "./SignOutButton";
import styles from "./screens.module.css";

/**
 * The top of a signed-in page: where you are, who you are, and a way out. `security` is whether
 * there is a page of security settings, which is the local methods' (a password, two-factor, passkeys).
 */
export function AccountHeader({ name, email, security }: { name: string; email: string; security: boolean }) {
  return (
    <div className={styles.accountHeader}>
      <a className={styles.brand} href="/">
        Fjord
      </a>
      <nav className={styles.actions} aria-label="Account">
        <a href="/repositories">Repositories</a>
        <a href="/account/keys">Keys</a>
        {security ? <a href="/account/security">Security</a> : null}
        <span className={styles.itemMeta} title={email}>
          {name}
        </span>
        <SignOutButton />
      </nav>
    </div>
  );
}
