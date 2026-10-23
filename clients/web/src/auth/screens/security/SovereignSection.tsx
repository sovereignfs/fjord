"use client";

import { useState } from "react";
import { authClient } from "../../client";
import { messageFor } from "../../messages";
import { Alert, Button } from "../../../ui";
import styles from "../screens.module.css";

/**
 * Whether this account can be signed into through Sovereign (ROADMAP 1a.4). Linking sends the person to
 * Sovereign and back; it only works when Sovereign's email address is this account's own, which Fjord
 * checks and says. Unlinking is refused for an account with no other way to sign in.
 */
export function SovereignSection({
  linkedAccountId,
  canUnlink,
  email,
  twoFactorOn,
}: {
  /** better-auth's id for the linked account row, when linked. */
  linkedAccountId: string | null;
  /** Whether the account has another way to sign in, so that Sovereign can go. */
  canUnlink: boolean;
  email: string;
  twoFactorOn: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLink() {
    setBusy(true);
    setError(null);
    // On success the browser is sent to Sovereign and brought back to this page, with the result.
    const { error: failure } = await authClient.linkSocial({
      provider: "sovereign",
      callbackURL: "/account/security?linked=1",
      errorCallbackURL: "/account/security",
    });
    if (failure) {
      setBusy(false);
      setError(messageFor(failure, "Linking Sovereign did not work. Try again."));
    }
  }

  async function onUnlink() {
    if (!linkedAccountId) return;
    if (!window.confirm("Unlink Sovereign? You will sign in with your password from now on.")) return;
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.unlinkAccount({ accountId: linkedAccountId });
    setBusy(false);
    if (failure) {
      setError(messageFor(failure, "Sovereign was not unlinked. Try again."));
      return;
    }
    window.location.assign("/account/security?unlinked=1");
  }

  return (
    <section className={styles.section} aria-labelledby="sovereign-title">
      <h2 id="sovereign-title">Sovereign</h2>
      {linkedAccountId ? (
        <p>You can sign in with Sovereign as well as with your password. Your Sovereign account uses the same email address as this one, {email}.</p>
      ) : (
        <p>
          Link a Sovereign account to sign in with it as well as with your password. It has to use the same email address as this account, <strong>{email}</strong>: Fjord checks, and links
          nothing if they differ.
        </p>
      )}
      {twoFactorOn ? <p className={styles.itemMeta}>Signing in with Sovereign does not ask for a Fjord two-factor code: Sovereign asks for its own.</p> : null}
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      <div className={styles.actions}>
        {linkedAccountId ? (
          <Button variant="secondary" onClick={onUnlink} loading={busy} disabled={!canUnlink}>
            Unlink Sovereign
          </Button>
        ) : (
          <Button onClick={onLink} loading={busy}>
            Link Sovereign
          </Button>
        )}
      </div>
      {linkedAccountId && !canUnlink ? <p className={styles.itemMeta}>It is the only way you can sign in, so it cannot be unlinked.</p> : null}
    </section>
  );
}
