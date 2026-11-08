'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, FormField, Icon, Input } from '../../ui';
import { NodeIcon } from '../../ui/icons';
import { MAX_MESSAGE_CHARS } from '../../working/limits';
import { ActionDialog } from './ActionDialog';
import { IconButton } from './IconButton';
import styles from './FileActions.module.css';

/**
 * *Save version* for a document that has changes kept as a draft (the owner's request): a save icon among the document's other icons, and an arrow after it that opens a small menu with the
 * other way to save, **with a message** for the repository's history, asked for in a dialog. The icon alone saves with the message the repository would give it (*Edit <name>*), which is
 * what most saves want; the arrow is for the one that does not. It is there with nothing to save, and disabled, so that where saving is does not come and go.
 */
export function SaveControl({
  unsettled,
  hasDraft,
  saving,
  error,
  asking,
  setAsking,
  onSave,
}: {
  unsettled: boolean;
  hasDraft: boolean;
  saving: boolean;
  error: string | null;
  /** Whether the dialog for a message is open, which the page keeps, to say an error in one place. */ asking: boolean;
  setAsking: (asking: boolean) => void;
  onSave: (message: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [message, setMessage] = useState('');
  const group = useRef<HTMLSpanElement>(null);
  const label = unsettled ? 'Save version anyway' : 'Save version';

  useEffect(() => {
    if (!menu) return;
    const outside = (event: MouseEvent) => {
      if (!group.current?.contains(event.target as Node)) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);

  return (
    <>
      <span ref={group} className={styles.split}>
        <IconButton
          label={label}
          haspopup={false}
          disabled={!hasDraft || saving}
          onClick={() => onSave('')}
        >
          <NodeIcon name="save" aria-hidden />
        </IconButton>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.arrow}`}
          title="Save options"
          aria-label="Save options"
          aria-haspopup="menu"
          aria-expanded={menu}
          disabled={!hasDraft || saving}
          onClick={() => setMenu((open) => !open)}
        >
          <Icon name="chevron-down" aria-hidden />
        </button>
        {menu ? (
          <ul className={styles.menu} role="menu" aria-label="Save options">
            <li role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setAsking(true);
                }}
              >
                Save with a message…
              </button>
            </li>
          </ul>
        ) : null}
      </span>
      <ActionDialog
        open={asking}
        onClose={saving ? () => undefined : () => setAsking(false)}
        title="Save with a message"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave(message);
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sv-space-3)' }}
        >
          <FormField
            label="Message"
            hint="What changed, for the repository's history. Leave it empty for “Edit <name>”."
          >
            {(field) => (
              <Input
                {...field}
                name="message"
                autoComplete="off"
                autoFocus
                maxLength={MAX_MESSAGE_CHARS}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={saving}
              />
            )}
          </FormField>
          {error ? (
            <Alert variant="error" heading="No version was made">
              {error}
            </Alert>
          ) : null}
          <div style={{ display: 'flex', gap: 'var(--sv-space-2)' }}>
            <Button type="submit" variant={unsettled ? 'secondary' : 'primary'} loading={saving}>
              {label}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setAsking(false)}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </form>
      </ActionDialog>
    </>
  );
}
