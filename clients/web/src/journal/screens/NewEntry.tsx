"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { repositoryHref } from "../../browse/links";
import { type CreateAttempt, sendCreateEncrypted, sendEntry } from "../../files/client";
import { loadModule } from "../../keys/module";
import { Alert, Button } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { newEncryptedEntry } from "../seal";

/**
 * "New entry" (ROADMAP 3b.1, 3f.1): one action. It makes an entry dated now in this browser's own time, with no title (the title and the date are
 * the properties panel's, on the entry), and opens it in the editor. In a plaintext journal the server writes it where `fjord-core` files it; in an
 * encrypted one it is written and encrypted here, to the journal's recipients, and the server is given only the ciphertext. Nothing is written until the
 * button is pressed: opening the journal changes nothing.
 */
export function NewEntry({ connectionId, repo, vault, encrypted }: { connectionId: number; /** What the repository is called in an address. */ repo: string; vault: string; /** The journal's recipients, when it is encrypted, or why it cannot be written to. */ encrypted?: { ok: true; text: string } | { ok: false; message: string } }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (encrypted && !encrypted.ok) {
    return (
      <Alert variant="info" heading="New entries cannot be written here yet">
        {encrypted.message}
      </Alert>
    );
  }

  async function write() {
    setBusy(true);
    setError(null);
    let made: CreateAttempt;
    if (encrypted?.ok) {
      try {
        const sealed = newEncryptedEntry(await loadModule(), { title: "", recipients: encrypted.text, now: new Date(), random: crypto.getRandomValues(new Uint8Array(16)) });
        made = await sendCreateEncrypted(connectionId, { vault, folder: sealed.folder, title: "", ciphertext: sealed.ciphertext });
      } catch {
        made = { ok: false, message: "The entry could not be encrypted here, so nothing was made." };
      }
    } else {
      made = await sendEntry(connectionId, "");
    }
    if (made.ok) {
      router.push(repositoryHref(repo, ...made.path.split("/")));
      return;
    }
    setError(made.message);
    setBusy(false);
  }

  return (
    <div aria-label="New entry">
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="No entry was made">
            {error}
          </Alert>
        </div>
      ) : null}
      <p>
        <Button loading={busy} onClick={() => void write()}>
          New entry
        </Button>
      </p>
    </div>
  );
}
