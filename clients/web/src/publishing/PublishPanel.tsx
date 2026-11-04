"use client";

import { useEffect, useState } from "react";
import { Alert, Button } from "../ui";
import styles from "../sharing/Sharing.module.css";
import { getStatus, publish, unpublish } from "./client";

/**
 * "Publish as a page" (the Page tab of the sharing dialog; DESIGN.md §12, ROADMAP 3h.1): the Doc as a read-only page at an address anyone can open, no account needed. It is the owner's choice, said in
 * words first: the page shows the saved version, a change shows on it after the next version is saved, and anyone who has the address can read it. The address is shown
 * **once**, when it is made; publishing again makes a new address and ends the old one, and *Unpublish* ends it at once.
 */
export function PublishPanel({ connectionId, docId }: { connectionId: number; docId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [published, setPublished] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- it is read once, as the tab opens.
  }, []);

  async function load() {
    const status = await getStatus(connectionId, docId);
    if (status.ok) setPublished(status.published);
    else setProblem(status.message);
    setLoaded(true);
  }

  async function make() {
    setBusy(true);
    setProblem(null);
    const made = await publish(connectionId, docId);
    setBusy(false);
    if (made.ok) {
      setUrl(new URL(made.url, window.location.origin).href);
      setPublished(true);
      setAsking(false);
    } else setProblem(made.message);
  }

  async function end() {
    setBusy(true);
    setProblem(null);
    const ended = await unpublish(connectionId, docId);
    setBusy(false);
    if (ended.ok) {
      setPublished(false);
      setUrl(null);
    } else setProblem(ended.message);
  }

  return (
    <div className={styles.panel} data-testid="publish-panel">
      {problem ? (
        <Alert variant="error" heading="Publishing">
          {problem}
        </Alert>
      ) : null}
      {url ? (
        <Alert variant="success" heading="Published">
          Anyone with this address can read the page. It is shown only now; keep it, or publish again for a new one.
          <br />
          <code data-testid="page-address">{url}</code>
        </Alert>
      ) : null}
      {published ? (
        <>
          {url ? null : <p className={styles.muted}>This document is published. Its address was shown when it was made and is not kept; publish again for a new one, which ends the old.</p>}
          <div className={styles.actions}>
            <Button type="button" variant="secondary" loading={busy} onClick={() => void end()}>
              Unpublish
            </Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setAsking(true)}>
              Publish again
            </Button>
          </div>
        </>
      ) : null}
      {!published || asking ? (
        <div className={styles.card}>
          <h3 className={styles.heading}>Publish as a page</h3>
          <p className={styles.muted}>
            A published page shows this document&apos;s saved version, read-only, to anyone with its address, with no account. Raw HTML in it is shown as text, and pictures and
            scripts are not loaded. A change shows on the page after you save a version.
          </p>
          <div className={styles.actions}>
            <Button type="button" loading={busy} onClick={() => void make()}>
              {published ? "Publish with a new address" : "Publish"}
            </Button>
            {asking ? (
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setAsking(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
