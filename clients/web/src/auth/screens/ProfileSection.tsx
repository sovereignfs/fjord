"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Alert, Avatar, Button, FormField, Input } from "../../ui";
import { authClient } from "../client";
import { ChangeEmail } from "../../account/screens/ChangeEmail";
import { DeleteAccount } from "../../account/screens/DeleteAccount";
import { messageFor } from "../messages";
import styles from "./AccountShell.module.css";

/** The longest a display name may be: a line, as a person writes their own. */
export const MAX_NAME_LENGTH = 100;

/**
 * Account, Profile: who the person is here. Their avatar (what Sovereign sent, or their initials), the name they are shown under, which they can change when the account is Fjord's own,
 * and their address, which they change with their password unless it is Sovereign's to give. Where the account is only Sovereign's (this instance signs in
 * through it and has no sign-in of its own) the name is Sovereign's to give, so it is shown and not edited.
 */
export function ProfileSection({ name, email, image, editable, deleting, sovereignLinked = false }: { sovereignLinked?: boolean; name: string; email: string; image?: string | null | undefined; editable: boolean; /** What deleting the account needs to know, and says. */ deleting: { hasPassword: boolean; onServer: string[]; inGit: number } }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const trimmed = value.trim();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed === "" || trimmed.length > MAX_NAME_LENGTH) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const { error: failure } = await authClient.updateUser({ name: trimmed });
    setBusy(false);
    if (failure) {
      setError(messageFor(failure));
      return;
    }
    setValue(trimmed);
    setSaved(true);
    // The menu and every page that says who is signed in read it from the session.
    router.refresh();
  }

  return (
    <>
      <div className={styles.group}>
        <h2>Avatar</h2>
        <div className={styles.row}>
          <Avatar name={name} {...(image ? { src: image } : {})} size="lg" />
          <p className={styles.hint}>{image ? "From your sign-in." : "Your initials. A picture comes with your sign-in, where it has one."}</p>
        </div>
      </div>
      <div className={styles.group}>
        <h2>Display name</h2>
        {editable ? (
          <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--sv-space-3)" }} aria-label="Display name">
            {error ? <Alert variant="error">{error}</Alert> : null}
            {saved ? <Alert variant="success">Your name is saved.</Alert> : null}
            <FormField label="Name" required error={trimmed.length > MAX_NAME_LENGTH ? `At most ${MAX_NAME_LENGTH} characters.` : undefined}>
              {(field) => <Input {...field} name="name" autoComplete="name" value={value} onChange={(e) => (setValue(e.target.value), setSaved(false))} disabled={busy} />}
            </FormField>
            <div>
              <Button type="submit" loading={busy} disabled={trimmed === "" || trimmed === name || trimmed.length > MAX_NAME_LENGTH}>
                Save name
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className={styles.value}>{name}</p>
            <p className={styles.hint}>Your name is given by Sovereign, which you sign in through.</p>
          </>
        )}
      </div>
      <div className={styles.group}>
        <h2>Email</h2>
        <p className={styles.value}>{email}</p>
        {deleting.hasPassword && !sovereignLinked ? (
          <ChangeEmail email={email} />
        ) : (
          <p className={styles.hint}>Your address is the one Sovereign has{deleting.hasPassword ? ", because the two are linked" : ""}. Change it there.</p>
        )}
      </div>
      <DeleteAccount email={email} {...deleting} />
    </>
  );
}
