"use client";

import { DocumentEditor, NoteEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { useComments } from "../../comments/Comments";
import { sendDate, sendField, sendMove, sendTags, sendTitle } from "../../files/client";
import { discardDraft, sendDraft, sendVersion } from "../../working/client";
import { DraftSaver, type SaverStatus } from "../../working/saver";
import { MAX_MESSAGE_CHARS } from "../../working/limits";
import { hasConflictMarkers } from "../../working/markers";
import type { HeaderInfo, Properties } from "../document";
import { repositoryHref } from "../links";
import { DocumentProperties } from "./DocumentProperties";

/** The draft the page found for this note: its text and the version of the note it was started from. */
export interface DraftOfNote {
  content: string;
  baseBlob: string;
  /** The display names of people who edited it through a link (ROADMAP 1c.6): a version made of it credits them. */
  guests?: string[];
}

/**
 * A Doc in the editor its repository's kind chooses (the document editor, or the note editor), kept as a draft as it is edited
 * (ROADMAP 1b.2, 1b.3, 1b.5, 1b.8; RFC 0002). A Doc is a header and a body, and the editors are given the body only: `header.bodyStart` is
 * where the body begins in the text, and the header before it is put back in front of whatever the editor says, so that it is
 * never the editor's to rewrite (DESIGN.md §9). A header that cannot be read means there is no `header`, and the text is
 * edited whole. The header is shown in the properties panel, where its title can be changed; a file that has no header is
 * edited as it is, and is given one only when sharing needs one (RFC 0002). Nothing typed here goes to the
 * repository: the text is sent to the server a moment after the last change (`DraftSaver`), where it waits until
 * **Save version** makes it one commit (1b.9). Closing the page and opening it again finds the draft, and says so.
 *
 * The editor is given the text it starts with and never again: what is on screen is the editor's, and what the saver
 * has is told of each change. Leaving the page sends what is waiting, and a text that could not be kept is not left
 * without a warning.
 */
export function NoteView({
  connectionId,
  path,
  label,
  text,
  blob,
  draft,
  header,
  editor,
  site = false,
  docId,
  tagSuggestions,
  rename,
  updated,
}: {
  connectionId: number;
  path: string;
  label: string;
  text: string;
  blob: string;
  /** Which editor the repository's kind opens a Doc in (RFC 0002): the document editor, or the byte-faithful Markdown one. */
  editor: "document" | "note";
  /** Whether this is a site's post (RFC 0002): it offers `draft` and `description`, and a visual mode beside the Markdown. */
  site?: boolean;
  /** For a Doc whose header has an `id`: the key its comments are kept under (ROADMAP 1d.1). */
  docId?: string | undefined;
  draft: DraftOfNote | null;
  /** For a file with a header that can be read, or none: where its body starts in the text shown (the draft, else the file), and its properties. */
  header?: HeaderInfo | undefined;
  /** Tags in use in the repository, offered while one is typed (ROADMAP 3b.3). */
  tagSuggestions?: string[] | undefined;
  /** For a drive's document: where it is, so that its file's name can be changed from the properties (`sendMove`): the vault, where the repository's addresses begin, and the extension that stays. */
  rename?: { vault: string; repo: string; suffix: string } | undefined;
  /** When the file last changed in the repository (ISO 8601), if the host said: shown in the properties. */
  updated?: string | null | undefined;
}) {
  const start = draft?.content ?? text;
  const { adapter, onNeedName, panel } = useComments(editor === "document" ? docId : undefined, { guest: false });
  const bodyStart = header?.bodyStart;
  // The header in front of the body, as it is now: the one the file has, the one it is promoted to, or one with a new title.
  const headerNow = useRef(bodyStart === undefined ? "" : start.slice(0, bodyStart));
  // A file with no header shows the properties it would be given, which cannot be changed until it has them.
  const noHeader = header !== undefined && header.promotion !== undefined;
  const [properties, setProperties] = useState<Properties | undefined>(header?.properties ?? header?.promotion?.properties);
  // A site's posts are written as Markdown, which is kept as it was, and may be edited visually when the person asks: the visual editor holds only what it
  // can without changing what it means, and says so for the rest (`DocumentEditor`). Switching starts the other editor from the text as it is now.
  const [visual, setVisual] = useState(false);
  const [switched, setSwitched] = useState<string | null>(null);
  const bodyNow = switched ?? (bodyStart === undefined ? start : start.slice(bodyStart));
  function switchEditor() {
    setSwitched(saver.text.slice(headerNow.current.length));
    setVisual((now) => !now);
  }
  const base = draft?.baseBlob ?? blob;
  const saver = useMemo(() => new DraftSaver({ initial: start, send: (content) => sendDraft(connectionId, path, base, content) }), [connectionId, path, start, base]);
  const [status, setStatus] = useState<SaverStatus>(saver.status);
  // Whether the server holds a draft of this note: it did, or something has been kept since.
  const [hasDraft, setHasDraft] = useState(draft !== null);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardFailed, setDiscardFailed] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // The page was reloaded to show a version that has just been made: say so, once.
  useEffect(() => {
    try {
      const key = savedKey(connectionId, path);
      const commit = window.sessionStorage.getItem(key);
      if (commit) {
        window.sessionStorage.removeItem(key);
        setSaved(commit);
      }
    } catch {
      // No storage (a private window): the version was made all the same.
    }
  }, [connectionId, path]);

  useEffect(() => {
    const stop = saver.subscribe((next) => {
      setStatus(next);
      if (next.state === "kept") setHasDraft(true);
    });
    const leaving = () => {
      void saver.flush();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") leaving();
    };
    // A text that is waiting is sent as the page goes; one that could not be sent is the only one to ask about.
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
      void saver.flush(); // the person went to another page of the app
    };
  }, [saver]);

  // What the editor says is the body; the header is put in front of it, as it is. A file with no header is edited as it is (RFC 0002): it is given an
  // identifier only when something needs one, after the person agreed (sharing, `IdentifyAndShare`), never because it was edited.
  function changeBody(body: string) {
    saver.change(headerNow.current + body);
  }

  // The server writes the title into the header (the header alone is sent); what is kept is that header and the body as it is.
  async function changeTitle(title: string): Promise<string | null> {
    const answer = await sendTitle(connectionId, headerNow.current, title);
    if (!answer.ok) return answer.message;
    const body = saver.text.slice(headerNow.current.length);
    headerNow.current = answer.header;
    setProperties((now) => (now ? { ...now, title: title.trim() === "" ? null : title.trim() } : now));
    saver.change(answer.header + body);
    return null;
  }

  async function changeDate(date: string | null): Promise<string | null> {
    const answer = await sendDate(connectionId, headerNow.current, date);
    if (!answer.ok) return answer.message;
    const body = saver.text.slice(headerNow.current.length);
    headerNow.current = answer.header;
    setProperties((now) => (now ? { ...now, date } : now));
    saver.change(answer.header + body);
    return null;
  }

  async function changeTags(tags: string[]): Promise<string | null> {
    const answer = await sendTags(connectionId, headerNow.current, tags);
    if (!answer.ok) return answer.message;
    const body = saver.text.slice(headerNow.current.length);
    headerNow.current = answer.header;
    setProperties((now) => (now ? { ...now, tags: tags.length === 0 ? null : tags } : now));
    saver.change(answer.header + body);
    return null;
  }

  async function changeField(key: string, value: string | boolean | null): Promise<string | null> {
    const answer = await sendField(connectionId, headerNow.current, key, value);
    if (!answer.ok) return answer.message;
    const body = saver.text.slice(headerNow.current.length);
    headerNow.current = answer.header;
    setProperties((now) => {
      if (!now) return now;
      if (key === "draft" && typeof value === "boolean") return { ...now, draft: value };
      if (key === "draft" && value === null) return { ...now, draft: null };
      if (key === "description" && (typeof value === "string" || value === null)) return { ...now, description: value };
      const others = now.others.filter((other) => other.key !== key);
      if (value === null) return { ...now, others };
      const entry = { key, value: String(value), editable: typeof value === "boolean" ? ("flag" as const) : ("text" as const) };
      const at = now.others.findIndex((other) => other.key === key);
      return { ...now, others: at === -1 ? [...others, entry] : now.others.map((other) => (other.key === key ? entry : other)) };
    });
    saver.change(answer.header + body);
    return null;
  }

  // The file's name, changed from the properties: one commit that puts the file at its new name (an unsaved draft is saved as a version first, by the server), and the page of the new place opens.
  const renameFile = rename
    ? {
        stem: label.slice(0, label.length - rename.suffix.length),
        suffix: rename.suffix,
        onRename: async (stem: string): Promise<string | null> => {
          const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          const destination = `${parent}/${stem}${rename.suffix}`;
          await saver.flush();
          const done = await sendMove(connectionId, rename.vault, { type: "file", path, blob }, destination);
          if (!done.ok) return done.message;
          saver.dispose();
          window.location.assign(repositoryHref(rename.repo, ...destination.split("/")));
          return null;
        },
      }
    : undefined;

  async function discard() {
    setDiscarding(true);
    setDiscardFailed(false);
    saver.dispose();
    if (await discardDraft(connectionId, path)) {
      window.location.reload();
      return;
    }
    setDiscarding(false);
    setDiscardFailed(true);
  }

  async function saveVersion() {
    setSaving(true);
    setVersionError(null);
    // What is on screen is kept first, so the version is what the person sees. If that cannot be done, nothing is made.
    await saver.flush();
    if (saver.unsaved) {
      setVersionError("Your latest changes could not be kept on the server yet, so no version was made. Wait for them to be kept, then try again.");
      setSaving(false);
      return;
    }
    const made = await sendVersion(connectionId, path, message);
    if (!made.ok && (made.code === "upstream_changed" || made.code === "gone")) {
      // The note changed in the repository since the draft was started: the page shows both versions, to choose between.
      saver.dispose();
      window.location.reload();
      return;
    }
    if (!made.ok) {
      setVersionError(made.message);
      setSaving(false);
      return;
    }
    // The draft is gone and the note is the version: the page is read again, with nothing more sent for the old text.
    saver.dispose();
    try {
      window.sessionStorage.setItem(savedKey(connectionId, path), made.commit);
    } catch {
      // Not remembering it only means the page does not say so.
    }
    window.location.reload();
  }

  const unsettled = hasConflictMarkers(saver.text);
  return (
    <div>
      {draft ? (
        <div className={styles.notice}>
          <Alert variant="info" heading={draft.guests?.length ? "Changes were kept" : "Your changes were kept"}>
            {draft.guests?.length
              ? `These are changes that have not been saved as a version, made by you and by ${list(draft.guests)} through a link. They are kept on this server, not in the repository; a version credits each of them by name.`
              : "These are changes you made earlier and have not saved as a version. They are kept on this server, not in the repository."}
          </Alert>
        </div>
      ) : null}
      {unsettled ? (
        <div className={styles.notice}>
          <Alert variant="warning" heading="There are conflicts to settle in this text">
            Your changes and the repository&apos;s are both here, between the <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>, <code>=======</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> lines. Keep what you want, and delete the marker lines.
          </Alert>
        </div>
      ) : null}
      {saved ? (
        <div className={styles.notice}>
          <Alert variant="success" heading="Version saved">
            Your changes are now in the repository (commit {saved.slice(0, 7)}).
          </Alert>
        </div>
      ) : null}
      {properties ? <DocumentProperties properties={properties} pending={noHeader} disabled={saving} onTitle={changeTitle} onDate={changeDate} onTags={changeTags} onField={changeField} site={site} tagSuggestions={tagSuggestions} rename={renameFile} updated={updated} /> : null}
      {site && editor === "note" && bodyStart !== undefined ? (
        <p>
          <Button type="button" variant="secondary" size="sm" onClick={switchEditor} disabled={saving} data-testid="switch-editor">
            {visual ? "Edit as Markdown" : "Edit visually"}
          </Button>
        </p>
      ) : null}
      {bodyStart === undefined ? (
        <NoteEditor aria-label={label} value={start} onChange={(next) => saver.change(next)} readOnly={saving} />
      ) : editor === "document" || visual ? (
        <DocumentEditor key="rich" aria-label={label} role={saving ? "view" : "edit"} value={bodyNow} onChange={changeBody} comments={adapter} onNeedName={onNeedName} />
      ) : (
        <NoteEditor key="source" aria-label={label} value={bodyNow} onChange={changeBody} readOnly={saving} />
      )}
      {panel}
      <p className={styles.itemMeta} role="status" aria-live="polite" data-testid="draft-status">
        {describe(status, hasDraft)}
      </p>
      {status.state === "refused" || status.state === "stopped" ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Your changes are not being kept">
            {status.message}
          </Alert>
        </div>
      ) : null}
      {hasDraft ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void saveVersion();
          }}
        >
          <FormField label="Message" hint="What changed, for the repository's history. Leave it empty for “Edit <name>”.">
            {(field) => <Input {...field} name="message" autoComplete="off" maxLength={MAX_MESSAGE_CHARS} value={message} onChange={(e) => setMessage(e.target.value)} disabled={saving} />}
          </FormField>
          {versionError ? (
            <div className={styles.notice}>
              <Alert variant="error" heading="No version was made">
                {versionError}
              </Alert>
            </div>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" variant={unsettled ? "secondary" : "primary"} loading={saving}>
              {unsettled ? "Save version anyway" : "Save version"}
            </Button>
          </div>
        </form>
      ) : null}
      {hasDraft ? (
        <div>
          {discardFailed ? (
            <div className={styles.notice}>
              <Alert variant="error">Could not discard the changes. Try again.</Alert>
            </div>
          ) : null}
          {confirming ? (
            <p>
              Discard everything you changed in this note?{" "}
              <Button variant="destructive" size="sm" onClick={discard} loading={discarding}>
                Yes, discard
              </Button>{" "}
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={discarding}>
                Keep editing
              </Button>
            </p>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
              Discard changes
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

const savedKey = (connectionId: number, path: string) => `fjord:version-saved:${connectionId}:${path}`;

function describe(status: SaverStatus, hasDraft: boolean): string {
  switch (status.state) {
    case "idle":
      return hasDraft ? "" : "No changes yet. What you type is kept as a draft.";
    case "pending":
      return "Unsaved changes…";
    case "saving":
      return "Saving…";
    case "kept":
      return "Changes kept as a draft.";
    case "retrying":
      return "Could not keep your changes. Trying again…";
    case "refused":
    case "stopped":
      return "Changes are not being kept.";
  }
}

/** Names as a sentence: `A`, `A and B`, `A, B and C`. */
function list(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
