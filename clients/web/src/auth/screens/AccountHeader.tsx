import { SignOutButton } from "./SignOutButton";
import styles from "./screens.module.css";

/** The top of a signed-in page: where you are, who you are, and a way out. */
export function AccountHeader({ name, email }: { name: string; email: string }) {
  return (
    <div className={styles.accountHeader}>
      <a className={styles.brand} href="/">
        Fjord
      </a>
      <nav className={styles.actions} aria-label="Account">
        <a href="/account/security">Security</a>
        <span className={styles.itemMeta} title={email}>
          {name}
        </span>
        <SignOutButton />
      </nav>
    </div>
  );
}
