"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, FormField, Input, Select } from "../ui";
import styles from "../sharing/Sharing.module.css";
import { type CommentSetting, getStatus, publish, unpublish, updatePublication } from "./client";

/**
 * "Publish as a page" (the *Publish* tab of the sharing dialog; DESIGN.md §12, ROADMAP 3h.1): the Doc as a read-only page at an address anyone can open, no account needed. It is the owner's choice,
 * said in words first: the page shows the saved version, a change shows on it after the next version is saved, and anyone who has the address can read it. How it is open is chosen with it and
 * changed after without a new address: an **optional password** (asked of everyone who opens the page, signed in or not) and **who may comment**. Comments are not built, so the choice is shown and only *Off* can be
 * made; the setting is kept for when they are. The address is shown **once**, when it is made; publishing again makes a new address and ends the old one, and *Unpublish* ends it at once.
 */
export function PublishPanel({ connectionId, docId }: { connectionId: number; docId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [published, setPublished] = useState(false);
  const [protectedNow, setProtectedNow] = useState(false);
  const [comments, setComments] = useState<CommentSetting>("off");
  const [url, setUrl] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // What is being typed: a password for a new page or a new one for a page that has one, and whether to take the one it has off.
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- it is read once, as the tab opens.
  }, []);

  async function load() {
    const status = await getStatus(connectionId, docId);
    if (status.ok) {
      setPublished(status.published);
      setProtectedNow(status.passwordProtected);
      setComments(status.comments);
    } else setProblem(status.message);
    setLoaded(true);
  }

  async function make() {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    const made = await publish(connectionId, docId, { ...(password !== "" ? { password } : {}), comments });
    setBusy(false);
    if (made.ok) {
      setUrl(new URL(made.url, window.location.origin).href);
      setPublished(true);
      setProtectedNow(password !== "");
      setPassword("");
      setAsking(false);
    } else setProblem(made.message);
  }

  async function save() {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    const changed = await updatePublication(connectionId, docId, { ...(removePassword ? { password: null } : password !== "" ? { password } : {}), comments });
    setBusy(false);
    if (!changed.ok) return setProblem(changed.message);
    if (removePassword) setProtectedNow(false);
    else if (password !== "") setProtectedNow(true);
    setPassword("");
    setRemovePassword(false);
    setSaved(true);
  }

  async function end() {
    setBusy(true);
    setProblem(null);
    const ended = await unpublish(connectionId, docId);
    setBusy(false);
    if (ended.ok) {
      setPublished(false);
      setProtectedNow(false);
      setUrl(null);
      setSaved(false);
    } else setProblem(ended.message);
  }

  const commentsField = (
    <FormField label="Comments" hint="Comments on a published page are coming later. When they are, you will choose here who may leave them.">
      {(field) => (
        <Select {...field} value={comments} onChange={(event) => setComments(event.target.value as CommentSetting)} disabled={busy}>
          <option value="off">Off</option>
          <option value="anyone" disabled>
            Anyone with the address (coming later)
          </option>
          <option value="users" disabled>
            People with an account here (coming later)
          </option>
        </Select>
      )}
    </FormField>
  );

  return (
    <div className={styles.panel} data-testid="publish-panel">
      {problem ? (
        <Alert variant="error" heading="Publishing">
          {problem}
        </Alert>
      ) : null}
      {url ? (
        <Alert variant="success" heading="Published">
          Anyone with this address can read the page{protectedNow ? ", once they give its password" : ""}. It is shown only now; keep it, or publish again for a new one.
          <br />
          <code data-testid="page-address">{url}</code>
        </Alert>
      ) : null}
      {published ? (
        <div className={styles.card}>
          <h3 className={styles.heading}>
            Published as a page{" "}
            {protectedNow ? <Badge>Password</Badge> : null}
          </h3>
          {url ? null : <p className={styles.muted}>Its address was shown when it was made and is not kept; publish again for a new one, which ends the old.</p>}
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <FormField label={protectedNow ? "New password" : "Password"} hint={protectedNow ? "Leave empty to keep the password it has. A new one ends what the old one opened." : "Optional. Eight characters or more; asked of everyone who opens the page."}>
              {(field) => <Input {...field} type="password" name="page-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy || removePassword} />}
            </FormField>
            {protectedNow ? (
              <label className={styles.checkbox}>
                <input type="checkbox" checked={removePassword} onChange={(e) => setRemovePassword(e.target.checked)} disabled={busy} /> Remove the password
              </label>
            ) : null}
            {commentsField}
            <div className={styles.actions}>
              <Button type="submit" loading={busy}>
                Save settings
              </Button>
              {saved ? <span className={styles.muted}>Saved.</span> : null}
            </div>
          </form>
          <div className={styles.actions}>
            <Button type="button" variant="secondary" loading={busy} onClick={() => void end()}>
              Unpublish
            </Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setAsking(true)}>
              Publish again
            </Button>
          </div>
        </div>
      ) : null}
      {!published || asking ? (
        <form
          className={styles.card}
          onSubmit={(event) => {
            event.preventDefault();
            void make();
          }}
        >
          <h3 className={styles.heading}>{published ? "Publish with a new address" : "Publish as a page"}</h3>
          <p className={styles.muted}>
            A published page shows this document&apos;s saved version, read-only, to anyone with its address, with no account. Raw HTML in it is shown as text, and pictures and
            scripts are not loaded. A change shows on the page after you save a version.
          </p>
          <FormField label="Password" hint="Optional. Eight characters or more; asked of everyone who opens the page, signed in or not.">
            {(field) => <Input {...field} type="password" name="publish-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />}
          </FormField>
          {commentsField}
          <div className={styles.actions}>
            <Button type="submit" loading={busy}>
              {published ? "Publish with a new address" : "Publish"}
            </Button>
            {asking ? (
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setAsking(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
