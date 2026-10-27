"use client";

import { Button, FormField, Input } from "../ui";
import styles from "../auth/screens/screens.module.css";

/**
 * The question a password link asks (ROADMAP 1c.5): one field, sent to a server action with the document it is for. A form that posts
 * to the server, so it needs no script to work; the password goes in the body of that post and nowhere else, never an address.
 */
export function PasswordForm({ docId, action }: { docId: string; action: (formData: FormData) => void | Promise<void> }) {
  return (
    <form className={styles.form} action={action}>
      <input type="hidden" name="doc" value={docId} />
      <FormField label="Password">{(field) => <Input {...field} type="password" name="password" autoComplete="off" required />}</FormField>
      <div className={styles.actions}>
        <Button type="submit">Open</Button>
      </div>
    </form>
  );
}
