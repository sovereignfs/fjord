"use client";

import { DocumentEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, FormField, Input } from "../ui";
import styles from "../auth/screens/screens.module.css";
import { DraftSaver, type SaverStatus } from "../working/saver";
import { MAX_NAME_CHARS, cleanGuestName } from "./guest-name";
import { NAME_KEY, sendGuestDraft } from "./guest-client";

/**
 * A document opened to be edited through a link (DESIGN.md §12, ROADMAP 1c.6). **A name comes first**: until the person has given one the
 * editor can only be read, and the name they give is kept in their browser and shown on what they change. What they type is kept as the
 * document's working copy on the server, a second after they stop (`DraftSaver`, as for the owner), where the owner sees it and saves a
 * version that credits them by that name. Nothing typed here goes to the repository.
 */
export function GuestEditor({ docId, title, body }: { docId: string; title: string; body: string }) {
  const [name, setName] = useState<string | undefined>(undefined);
  const [asking, setAsking] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<SaverStatus>({ state: "idle" });

  // The name this browser gave before, if it did.
  useEffect(() => {
    try {
      const kept = cleanGuestName(window.localStorage.getItem(NAME_KEY));
      if (kept) setName(kept);
    } catch {
      // No storage (a private window): the name is asked for each time.
    }
    setLoaded(true);
  }, []);

  const saver = useMemo(() => (name === undefined ? undefined : new DraftSaver({ initial: body, send: (text) => sendGuestDraft(docId, name, text) })), [docId, name, body]);

  useEffect(() => {
    if (!saver) return;
    setStatus(saver.status);
    const stop = saver.subscribe(setStatus);
    const leaving = () => void saver.flush();
    const hidden = () => {
      if (document.visibilityState === "hidden") leaving();
    };
    const warn = (event: BeforeUnloadEvent) => {
      const trouble = saver.status.state === "retrying" || saver.status.state === "stopped" || saver.status.state === "refused";
      if (trouble && saver.unsaved) event.preventDefault();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    window.addEventListener("beforeunload", warn);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("beforeunload", warn);
      stop();
      void saver.flush();
    };
  }, [saver]);

  function choose(value: string) {
    const given = cleanGuestName(value);
    if (!given) return;
    try {
      window.localStorage.setItem(NAME_KEY, given);
    } catch {
      // Not remembering it only means it is asked for again.
    }
    setName(given);
  }

  const invalid = asking.trim() !== "" && cleanGuestName(asking) === undefined;
  return (
    <div>
      {loaded && name === undefined ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            choose(asking);
          }}
        >
          <FormField label="Your name" hint="Shown on what you change, and in the version it is saved in. Nothing else is asked.">
            {(field) => <Input {...field} name="name" autoComplete="nickname" maxLength={MAX_NAME_CHARS} value={asking} onChange={(e) => setAsking(e.target.value)} aria-invalid={invalid} />}
          </FormField>
          <div className={styles.actions}>
            <Button type="submit" disabled={cleanGuestName(asking) === undefined}>
              Start editing
            </Button>
          </div>
        </form>
      ) : null}
      {name !== undefined ? (
        <p className={styles.itemMeta}>
          Editing as <strong data-testid="guest-name">{name}</strong>.{" "}
          <Button variant="secondary" size="sm" onClick={() => setName(undefined)}>
            Change name
          </Button>
        </p>
      ) : null}
      <DocumentEditor aria-label={title} role={name === undefined ? "view" : "edit"} value={body} onChange={(next) => saver?.change(next)} />
      {name !== undefined ? (
        <p className={styles.itemMeta} role="status" aria-live="polite" data-testid="guest-status">
          {describe(status)}
        </p>
      ) : null}
      {status.state === "refused" || status.state === "stopped" ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Your changes are not being kept">
            {status.message}
          </Alert>
        </div>
      ) : null}
    </div>
  );
}

function describe(status: SaverStatus): string {
  switch (status.state) {
    case "idle":
      return "What you change is kept for the owner, who saves it as a version with your name on it.";
    case "pending":
      return "Unsaved changes…";
    case "saving":
      return "Saving…";
    case "kept":
      return "Changes kept for the owner to save.";
    case "retrying":
      return "Could not keep your changes. Trying again…";
    case "refused":
    case "stopped":
      return "Changes are not being kept.";
  }
}
