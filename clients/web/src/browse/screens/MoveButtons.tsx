"use client";

import { useState } from "react";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { type DeleteTarget, sendMove } from "../../files/client";
import { MAX_TITLE_CHARS } from "../../files/limits";
import { repositoryHref } from "../links";

/**
 * Rename and move a note, a document or a folder (ROADMAP 1b.11), from the page of the file or the folder. Rename edits the
 * name before the extension, which stays, so a document never becomes a note; move picks a folder of a plaintext vault
 * from those the page knows. Either is one commit that puts the same files at the new path: the page sends what it showed
 * (the file's blob, the folder's file count), and the server checks the name by the format's rules and never goes over
 * anything. Afterwards the page of the new place opens. Nothing is lost on the way: an unsaved draft is saved as a version first.
 */
export function MoveButtons({
  connectionId,
  vault,
  target,
  suffix,
  destinations,
  canRename = true,
}: {
  connectionId: number;
  vault: string;
  target: DeleteTarget;
  /** What stays of a file's name when it is renamed: `.md` or `.fj.md`. Empty for a folder. */
  suffix: string;
  /** Folders of plaintext vaults, repository-relative (a vault's own directory is its top), that it can be moved to. */
  destinations: string[];
  /** False for a file whose name is its identifier (a vault that names its files by id): it is moved, and renamed by the name inside it. */
  canRename?: boolean;
}) {
  const [mode, setMode] = useState<"rename" | "move" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; lookAgain: boolean; taken: string[] } | null>(null);

  const leaf = target.path.slice(target.path.lastIndexOf("/") + 1);
  const parent = target.path.includes("/") ? target.path.slice(0, target.path.lastIndexOf("/")) : "";
  const stem = suffix === "" ? leaf : leaf.slice(0, leaf.length - suffix.length);
  const [name, setName] = useState(stem);
  // Not where it is, and for a folder not into itself.
  const places = destinations.filter((place) => place !== parent && (target.type === "file" || (place !== target.path && !place.startsWith(`${target.path}/`))));
  const [place, setPlace] = useState(places[0] ?? "");

  async function go(destination: string) {
    setBusy(true);
    setError(null);
    const done = await sendMove(connectionId, vault, target, destination);
    if (done.ok) {
      window.location.assign(repositoryHref(connectionId, ...destination.split("/")));
      return;
    }
    setError({ message: done.message, lookAgain: done.lookAgain, taken: done.taken });
    setBusy(false);
  }

  const noun = target.type === "folder" ? "folder" : "file";
  return (
    <div>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading={`The ${noun} was not changed`}>
            {error.message}{" "}
            {error.lookAgain ? (
              <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
                Look again
              </Button>
            ) : null}
          </Alert>
        </div>
      ) : null}
      {mode === "rename" ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void go(`${parent}/${name.trim()}${suffix}`);
          }}
        >
          <FormField label="New name" hint={suffix === "" ? undefined : `It stays ${suffix}.`}>
            {(field) => <Input {...field} name="name" autoComplete="off" maxLength={MAX_TITLE_CHARS} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />}
          </FormField>
          <div className={styles.actions}>
            <Button type="submit" size="sm" loading={busy} disabled={name.trim() === "" || name.trim() === stem}>
              Rename
            </Button>{" "}
            <Button variant="secondary" size="sm" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : mode === "move" ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void go(`${place}/${leaf}`);
          }}
        >
          <FormField label="Move to">
            {(field) => (
              <select {...field} name="place" value={place} onChange={(e) => setPlace(e.target.value)} disabled={busy}>
                {places.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <div className={styles.actions}>
            <Button type="submit" size="sm" loading={busy} disabled={place === ""}>
              Move
            </Button>{" "}
            <Button variant="secondary" size="sm" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <p>
          {canRename ? (
            <Button variant="secondary" size="sm" onClick={() => setMode("rename")}>
              {target.type === "folder" ? "Rename folder" : "Rename"}
            </Button>
          ) : null}{" "}
          {places.length > 0 ? (
            <Button variant="secondary" size="sm" onClick={() => setMode("move")}>
              {target.type === "folder" ? "Move folder" : "Move"}
            </Button>
          ) : null}
        </p>
      )}
    </div>
  );
}
