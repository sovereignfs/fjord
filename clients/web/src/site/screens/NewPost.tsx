'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { repositoryHref } from '../../browse/links';
import { sendPost } from '../../files/client';
import { MAX_TITLE_CHARS } from '../../files/limits';
import { Alert, Button, FormField, Input } from '../../ui';
import styles from '../../auth/screens/screens.module.css';

/**
 * "New post" (ROADMAP 3c.2): a Markdown file dated now in the writer's own time, put where the site's engine reads it, with a title if one is
 * typed, then opened in the note editor. As a draft it is not built into the site: Astro's `draft: true`, or Jekyll's `_drafts`.
 */
export function NewPost({
  connectionId,
  repo,
  engine,
}: {
  connectionId: number;
  /** What the repository is called in an address. */ repo: string;
  engine: 'astro' | 'jekyll';
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const made = await sendPost(connectionId, title, draft);
    if (made.ok) {
      router.push(repositoryHref(repo, ...made.path.split('/')));
      return;
    }
    setError(made.message);
    setBusy(false);
  }

  if (!open) {
    return (
      <p>
        <Button onClick={() => setOpen(true)}>New post</Button>
      </p>
    );
  }

  return (
    <form
      className={styles.form}
      onSubmit={onSubmit}
      aria-label="New post"
      style={{ marginTop: 0 }}
    >
      <FormField
        label="Title"
        hint={
          engine === 'jekyll'
            ? "It names the file: Jekyll's posts are called by their day and title."
            : "It names the file, and is the post's address."
        }
      >
        {(field) => (
          <Input
            {...field}
            name="title"
            autoComplete="off"
            autoFocus
            maxLength={MAX_TITLE_CHARS}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
          />
        )}
      </FormField>
      <label style={{ display: 'block' }}>
        <input
          type="checkbox"
          checked={draft}
          onChange={(e) => setDraft(e.target.checked)}
          disabled={busy}
        />{' '}
        A draft: not built into the site yet
      </label>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="No post was made">
            {error}
          </Alert>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" loading={busy}>
          Write it
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
