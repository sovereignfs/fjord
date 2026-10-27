"use client";

import { NoteEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import { useState } from "react";
import { Alert, Button } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { discardDraft, sendResolve } from "../../working/client";
import type { Preview } from "../../working/resolve";

/**
 * A note whose draft is of an older version than the repository has (DESIGN.md §11, ROADMAP 1b.10): someone changed the
 * note from the CLI, Obsidian or another device while it was being edited. Nothing is committed over their change. Both
 * versions are shown, side by side and only to be read, and the person chooses:
 *
 *  - **Combine** the two edits (the server merges them, as the CLI does; where both changed the same lines, both are kept
 *    between markers for the person to settle),
 *  - **Keep mine**: the draft becomes the next version's text as it is, and theirs stays in the repository's history, or
 *  - **Take theirs**: the draft is thrown away.
 *
 * The first two move the draft onto the version shown and read the page again, where it is an ordinary draft; neither
 * writes to the repository. What the server needs to know is which version the person was shown, so that a note that
 * changed yet again is looked at again, not decided about blind.
 */
export function UpstreamChanged({
  connectionId,
  path,
  label,
  mine,
  theirs,
  upstreamBlob,
  preview,
}: {
  connectionId: number;
  path: string;
  label: string;
  /** The draft's text. */
  mine: string;
  /** The note as the repository has it now. */
  theirs: string;
  /** The blob of `theirs`. */
  upstreamBlob: string;
  preview: Preview;
}) {
  const [busy, setBusy] = useState<"mine" | "combine" | "theirs" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function go(choice: "mine" | "combine") {
    setBusy(choice);
    setError(null);
    const done = await sendResolve(connectionId, path, choice, upstreamBlob);
    if (done.ok || done.lookAgain) {
      // Either it is done, or the page was out of date: in both the page is read again.
      window.location.reload();
      return;
    }
    setError(done.message);
    setBusy(null);
  }

  async function takeTheirs() {
    setBusy("theirs");
    setError(null);
    if (await discardDraft(connectionId, path)) {
      window.location.reload();
      return;
    }
    setError("Could not discard your changes. Try again.");
    setBusy(null);
  }

  return (
    <div>
      <div className={styles.notice}>
        <Alert variant="warning" heading="This note changed in the repository while you were editing it">
          Someone changed it, from another device or tool. Nothing of yours or theirs has been lost: your changes are kept, and nothing was committed over their change. Choose how to go on.
        </Alert>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))", gap: "var(--sv-space-4, 1rem)" }}>
        <section aria-labelledby="mine-title">
          <h3 id="mine-title" className={styles.itemMeta}>
            Your version (not saved)
          </h3>
          <NoteEditor aria-label={`Your version of ${label}`} value={mine} readOnly />
        </section>
        <section aria-labelledby="theirs-title">
          <h3 id="theirs-title" className={styles.itemMeta}>
            In the repository now
          </h3>
          <NoteEditor aria-label={`${label} in the repository now`} value={theirs} readOnly />
        </section>
      </div>

      <p className={styles.itemMeta} data-testid="combine-preview">
        {preview.state === "clean"
          ? "Your changes and theirs are in different places, so they can be combined without a conflict."
          : preview.state === "conflicts"
            ? `Your changes and theirs touch the same lines in ${preview.conflicts === 1 ? "1 place" : `${preview.conflicts} places`}. Combining keeps both there, between markers, for you to settle.`
            : "These cannot be combined here (one of the versions could not be read as text). You can still keep yours or take theirs."}
      </p>

      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Nothing was changed">
            {error}
          </Alert>
        </div>
      ) : null}

      <ul className={styles.list} aria-label="Ways to go on">
        {preview.state !== "unavailable" ? (
          <li className={styles.item}>
            <span>
              <strong>Combine both.</strong> <span className={styles.itemMeta}>Their change is brought into your version. Nothing of either is dropped.</span>
            </span>
            <Button size="sm" onClick={() => go("combine")} loading={busy === "combine"} disabled={busy !== null && busy !== "combine"}>
              Combine
            </Button>
          </li>
        ) : null}
        <li className={styles.item}>
          <span>
            <strong>Keep mine.</strong> <span className={styles.itemMeta}>Your version is what you save next. Theirs stays in the repository&apos;s history.</span>
          </span>
          <Button variant="secondary" size="sm" onClick={() => go("mine")} loading={busy === "mine"} disabled={busy !== null && busy !== "mine"}>
            Keep mine
          </Button>
        </li>
        <li className={styles.item}>
          <span>
            <strong>Take theirs.</strong> <span className={styles.itemMeta}>Throw your changes away and show the note as the repository has it.</span>
          </span>
          {confirming ? (
            <span>
              <Button variant="destructive" size="sm" onClick={takeTheirs} loading={busy === "theirs"} disabled={busy !== null && busy !== "theirs"}>
                Yes, discard mine
              </Button>{" "}
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={busy !== null}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConfirming(true)} disabled={busy !== null}>
              Take theirs
            </Button>
          )}
        </li>
      </ul>
    </div>
  );
}
