"use client";

import { useState } from "react";
import { Alert, Dialog, Icon } from "../../ui";
import shell from "../../ui/AppShell.module.css";
import { ConnectForm } from "./ConnectForm";

/**
 * The rail's `+`: *Connect a repository* as a modal dialog over whatever page is open. On success it closes, unless there is something to tell the person, and the
 * page behind it is refreshed by the form, so the repository is in the rail at once. Without an instance key nothing can be kept, and the dialog says so.
 */
export function ConnectDialog({ canConnect }: { canConnect: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={shell.icon} title="Connect a repository" aria-label="Connect a repository" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="plus" aria-hidden />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} size="md" aria-label="Connect a repository" title="Connect a repository">
        <div style={{ padding: "var(--sv-space-5)" }}>
          {canConnect ? (
            <ConnectForm onConnected={(warnings) => warnings.length === 0 && setOpen(false)} />
          ) : (
            <Alert variant="info" heading="Repositories cannot be connected yet">
              This instance has no encryption key, which it needs to keep an access token safely. Whoever runs it can set <code>FJORD_ENCRYPTION_KEY</code> (<code>openssl rand -base64 32</code>) and
              restart it.
            </Alert>
          )}
          <p style={{ marginBottom: 0 }}>
            <a href="/repositories">Connect with the GitHub App, or disconnect a repository</a>
          </p>
        </div>
      </Dialog>
    </>
  );
}
