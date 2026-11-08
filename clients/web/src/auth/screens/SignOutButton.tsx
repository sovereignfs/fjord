'use client';

import { useState } from 'react';
import { authClient } from '../client';
import { Button, Icon } from '@sovereignfs/ui';
import shell from '../../ui/AppShell.module.css';

async function signOut() {
  await authClient.signOut();
  window.location.assign('/');
}

/** The way out: a button with its name, or, in the shell's rail, an icon with the same name for a screen reader. */
export function SignOutButton({ icon = false }: { icon?: boolean }) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    setBusy(true);
    await signOut();
  };
  if (icon) {
    return (
      <button
        type="button"
        className={shell.icon}
        title="Sign out"
        aria-label="Sign out"
        disabled={busy}
        onClick={click}
      >
        <Icon name="log-out" aria-hidden />
      </button>
    );
  }
  return (
    <Button variant="secondary" loading={busy} onClick={click}>
      Sign out
    </Button>
  );
}
