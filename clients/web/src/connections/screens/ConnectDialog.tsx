"use client";

import { useState } from "react";
import { Alert, Dialog, Icon, useToast } from "../../ui";
import shell from "../../ui/AppShell.module.css";
import { ConnectForm } from "./ConnectForm";

/**
 * The rail's `+`: *Connect a repository* as a modal dialog over whatever page is open. Once the repository is connected the dialog closes, always, and the page behind it is
 * refreshed by the form, so the repository is in the rail and on the home page at once; anything worth telling the person (a token that reaches more than it needs to) is a
 * notice that stays a while after the dialog has gone. Without an instance key nothing can be kept, and the dialog says so.
 */
export function ConnectDialog({ canConnect }: { canConnect: boolean }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  return (
    <>
      <button type="button" className={shell.icon} title="Connect a repository" aria-label="Connect a repository" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="plus" aria-hidden />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} size="md" aria-label="Connect a repository" title="Connect a repository">
        <div style={{ padding: "var(--sv-space-5)" }}>
          {canConnect ? (
            <ConnectForm
              onConnected={(warnings) => {
                setOpen(false);
                for (const warning of warnings) toast.show({ title: "Repository connected", message: warning, category: "warning", duration: 12000 });
              }}
            />
          ) : (
            <Alert variant="info" heading="Repositories cannot be connected yet">
              This instance has no encryption key, which it needs to keep an access token safely. Whoever runs it can set <code>FJORD_ENCRYPTION_KEY</code> (<code>openssl rand -base64 32</code>) and
              restart it.
            </Alert>
          )}
        </div>
      </Dialog>
    </>
  );
}
