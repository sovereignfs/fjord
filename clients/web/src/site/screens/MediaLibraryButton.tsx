'use client';

import { useState } from 'react';
import { Button, Dialog, Icon } from '@sovereignfs/ui';
import { MediaLibrary } from './MediaLibrary';

/** The site's *Media library* action (RFC 0004): the library in a dialog over the page, to browse, add and delete pictures. */
export function MediaLibraryButton({ connectionId }: { connectionId: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        <Icon name="folder" aria-hidden /> Media library
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        aria-label="Media library"
        title="Media library"
      >
        {open ? <MediaLibrary connectionId={connectionId} mode="manage" /> : null}
      </Dialog>
    </>
  );
}
