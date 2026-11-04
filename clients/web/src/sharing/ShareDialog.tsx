"use client";

import { type ReactNode, useState } from "react";
import { Icon } from "../ui";
import { ActionDialog } from "../browse/screens/ActionDialog";
import { IconButton } from "../browse/screens/IconButton";

/**
 * Sharing a document, from an icon at the end of its title (the owner's request after the first editor screen): the people it is shared with, the links, and publishing it as a page, in a dialog over
 * the page, not in a block at the foot of it. What is in it is the server's to choose (`children`: the panels, or, for a file that has no identifier yet, the offer to give it one); the dialog is the frame.
 */
export function ShareDialog({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label="Share" onClick={() => setOpen(true)}>
        <Icon name="share-2" aria-hidden />
      </IconButton>
      <ActionDialog open={open} onClose={() => setOpen(false)} title="Sharing">
        {children}
      </ActionDialog>
    </>
  );
}
