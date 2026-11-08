'use client';

import { useRouter } from 'next/navigation';
import { startTransition, useEffect, useState } from 'react';
import { Icon } from '../ui';
import { ActionDialog } from '../browse/screens/ActionDialog';
import { IconButton } from '../browse/screens/IconButton';
import { PublishPanel } from '../publishing/PublishPanel';
import { SharePanel } from './SharePanel';
import { IdentifyStep } from './IdentifyAndShare';

/** What is kept across the page's move to the file's new address (it is a new page, so the dialog is made again): the identifier of the file the dialog was open for. */
const RESUME = 'fjord:share-dialog';

/**
 * Sharing a document, from an icon at the end of its title: one dialog over the page, whatever state the file is in. A Doc (a file with an `id`) opens on the sharing controls: the people it is
 * shared with, the links, and publishing it as a page. A file that has no identifier opens on the one step that gives it one, in the same dialog, and when that is done the dialog **stays open and
 * becomes the sharing controls** (the owner's request: it used to close the dialog and reload the page, which looked like something had gone wrong). The page behind is refreshed in the background, so that
 * it has the file as it now is: the header, and the version of it a later save is made on.
 */
export function ShareDialog({
  connectionId,
  docId,
  path,
  blob,
  hasDraft,
}: {
  connectionId: number;
  docId: string | undefined;
  path: string | undefined;
  blob: string | undefined;
  hasDraft: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const id = docId ?? made;

  // The file has an address by its identifier now, which the page moves to: the dialog is made again there, and opens on the sharing controls where it left off.
  useEffect(() => {
    if (docId === undefined) return;
    try {
      if (window.sessionStorage.getItem(RESUME) !== docId) return;
      window.sessionStorage.removeItem(RESUME);
    } catch {
      return;
    }
    setResumed(true);
    setOpen(true);
  }, [docId]);

  return (
    <>
      <IconButton label="Share" onClick={() => setOpen(true)}>
        <Icon name="share-2" aria-hidden />
      </IconButton>
      <ActionDialog open={open} onClose={() => setOpen(false)} title="Sharing">
        {id ? (
          <div data-testid="share-panel">
            <SharePanel
              connectionId={connectionId}
              docId={id}
              publish={<PublishPanel connectionId={connectionId} docId={id} />}
              justIdentified={made !== null || resumed}
            />
          </div>
        ) : path !== undefined && blob !== undefined ? (
          <IdentifyStep
            connectionId={connectionId}
            path={path}
            blob={blob}
            hasDraft={hasDraft}
            onMade={(docId) => {
              try {
                window.sessionStorage.setItem(RESUME, docId);
              } catch {
                // Without it the dialog is simply closed by the move; the file is shared from its icon.
              }
              setMade(docId);
              startTransition(() => router.refresh());
            }}
          />
        ) : null}
      </ActionDialog>
    </>
  );
}
