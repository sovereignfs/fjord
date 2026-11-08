'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, FormField, Input, Select } from '@sovereignfs/ui';
import styles from '../sharing/Sharing.module.css';
import { type CommentSetting, getStatus, publish, unpublish, updatePublication } from './client';
import { PageAddress } from './PageAddress';

/**
 * "Publish as a page" (the *Publish* tab of the sharing dialog; DESIGN.md §12, ROADMAP 3h.1): the Doc as a read-only page at an address anyone can open, no account needed. It is the owner's choice,
 * said in words first: the page shows the saved version, a change shows on it after the next version is saved, and anyone who has the address can read it. How it is open is chosen with it and
 * changed after without a new address: an **optional password** (asked of everyone who opens the page, signed in or not) and **who may comment**. Comments are not built, so the choice is shown and only *Off* can be
 * made; the setting is kept for when they are., and publishing again makes a new address and ends the old one; *Unpublish* ends it at once. **The address is kept, sealed under the instance key, and shown to its owner whenever the dialog opens** (a page made before that has only a hash of it, and says so).
 */
export function PublishPanel({ connectionId, docId }: { connectionId: number; docId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [published, setPublished] = useState(false);
  const [protectedNow, setProtectedNow] = useState(false);
  const [comments, setComments] = useState<CommentSetting>('off');
  const [url, setUrl] = useState<string | null>(null);
  const [justMade, setJustMade] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // What is being typed: a password for a new page or a new one for a page that has one, and whether to take the one it has off.
  const [password, setPassword] = useState('');
  const [removePassword, setRemovePassword] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
    // The dependencies are empty on purpose: it is read once, as the tab opens.
  }, []);

  async function load() {
    const status = await getStatus(connectionId, docId);
    if (status.ok) {
      setPublished(status.published);
      setProtectedNow(status.passwordProtected);
      setComments(status.comments);
      setUrl(status.url);
    } else setProblem(status.message);
    setLoaded(true);
  }

  async function make() {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    const made = await publish(connectionId, docId, {
      ...(password !== '' ? { password } : {}),
      comments,
    });
    setBusy(false);
    if (made.ok) {
      setUrl(new URL(made.url, window.location.origin).href);
      setJustMade(true);
      setPublished(true);
      setProtectedNow(password !== '');
      setPassword('');
      setAsking(false);
    } else setProblem(made.message);
  }

  async function save() {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    const changed = await updatePublication(connectionId, docId, {
      ...(removePassword ? { password: null } : password !== '' ? { password } : {}),
      comments,
    });
    setBusy(false);
    if (!changed.ok) return setProblem(changed.message);
    if (removePassword) setProtectedNow(false);
    else if (password !== '') setProtectedNow(true);
    setPassword('');
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
      setJustMade(false);
      setSaved(false);
    } else setProblem(ended.message);
  }

  const commentsField = (
    <FormField
      label="Comments"
      hint="Comments on a published page are coming later. When they are, you will choose here who may leave them."
    >
      {(field) => (
        <Select
          {...field}
          value={comments}
          onChange={(event) => setComments(event.target.value as CommentSetting)}
          disabled={busy}
        >
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
      {justMade ? (
        <Alert variant="success" heading="Published">
          Anyone with the address below can read the page
          {protectedNow ? ', once they give its password' : ''}.
        </Alert>
      ) : null}
      {published ? (
        <div className={styles.card}>
          <h3 className={styles.heading}>
            Published as a page {protectedNow ? <Badge>Password</Badge> : null}
          </h3>
          {url ? (
            <>
              <h4 className={styles.heading}>Address</h4>
              <PageAddress url={url} />
            </>
          ) : (
            <p className={styles.muted}>
              This page was published before its address was kept, so it cannot be shown. Publish
              again for a new address, which ends the old one.
            </p>
          )}
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <FormField
              label={protectedNow ? 'New password' : 'Password'}
              hint={
                protectedNow
                  ? 'Leave empty to keep the password it has. A new one ends what the old one opened.'
                  : 'Optional. Eight characters or more; asked of everyone who opens the page.'
              }
            >
              {(field) => (
                <Input
                  {...field}
                  type="password"
                  name="page-password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy || removePassword}
                />
              )}
            </FormField>
            {protectedNow ? (
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={removePassword}
                  onChange={(e) => setRemovePassword(e.target.checked)}
                  disabled={busy}
                />{' '}
                Remove the password
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
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setAsking(true)}
            >
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
          <h3 className={styles.heading}>
            {published ? 'Publish with a new address' : 'Publish as a page'}
          </h3>
          <p className={styles.muted}>
            A published page shows this document&apos;s saved version, read-only, to anyone with its
            address, with no account. Raw HTML in it is shown as text, and pictures and scripts are
            not loaded. A change shows on the page after you save a version.
          </p>
          <FormField
            label="Password"
            hint="Optional. Eight characters or more; asked of everyone who opens the page, signed in or not."
          >
            {(field) => (
              <Input
                {...field}
                type="password"
                name="publish-password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            )}
          </FormField>
          {commentsField}
          <div className={styles.actions}>
            <Button type="submit" loading={busy}>
              {published ? 'Publish with a new address' : 'Publish'}
            </Button>
            {asking ? (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setAsking(false)}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
