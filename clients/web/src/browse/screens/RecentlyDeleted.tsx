"use client";

import { useState } from "react";
import { Alert, Button, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { sendRestore } from "../../files/client";
import { repositoryHref } from "../links";

/** One deletion (a file, or a folder's files that went in one commit) as the list shows it. */
export interface DeletedGroup {
  ids: number[];
  paths: string[];
  /** When, as text (the server writes it, so the page and the browser say the same). */
  when: string;
}

/**
 * Recently deleted (ROADMAP 1b.12): what was deleted through the app within the restore window, newest first. A file is
 * put back where it was or at a place the person chooses; a folder's files, all together where they were. Never over
 * anything: if a path is taken, nothing is put back and the taken ones are named.
 */
export function RecentlyDeleted({ connectionId, groups, days }: { connectionId: number; groups: DeletedGroup[]; days: number }) {
  if (groups.length === 0) {
    return <p>Nothing was deleted in the last {days === 1 ? "day" : `${days} days`}. Files deleted earlier are still in the repository&apos;s history.</p>;
  }
  return (
    <>
      <p className={styles.itemMeta}>
        Deleted in the last {days === 1 ? "day" : `${days} days`}. Files deleted earlier are still in the repository&apos;s history.
      </p>
      <ul className={styles.list} aria-label="Recently deleted">
        {groups.map((group) => (
          <li key={group.ids[0]} className={styles.item}>
            <Row connectionId={connectionId} group={group} />
          </li>
        ))}
      </ul>
    </>
  );
}

function Row({ connectionId, group }: { connectionId: number; group: DeletedGroup }) {
  const single = group.paths.length === 1;
  const [where, setWhere] = useState(group.paths[0] as string);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; taken: string[] } | null>(null);
  const [restored, setRestored] = useState<string[] | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    const done = await sendRestore(connectionId, group.ids, single && where !== group.paths[0] ? where : undefined);
    if (done.ok) setRestored(done.paths);
    else setError({ message: done.message, taken: done.taken });
    setBusy(false);
  }

  if (restored) {
    return (
      <Alert variant="success" heading="Put back">
        {restored.length === 1 ? <a href={repositoryHref(connectionId, ...restored[0]!.split("/"))}>{restored[0]}</a> : `${restored.length} files, where they were.`}
      </Alert>
    );
  }
  return (
    <div style={{ width: "100%" }}>
      <p>
        {single ? <code>{group.paths[0]}</code> : <strong>{group.paths.length} files</strong>} <span className={styles.itemMeta}>· deleted {group.when}</span>
      </p>
      {single ? null : (
        <details>
          <summary className={styles.itemMeta}>Which files</summary>
          <ul>
            {group.paths.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {single ? <Input aria-label={`Put ${group.paths[0]} back at`} value={where} onChange={(e) => setWhere(e.target.value)} disabled={busy} /> : null}
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Nothing was put back">
            {error.message}
            {error.taken.length > 0 ? (
              <ul>
                {error.taken.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            ) : null}
          </Alert>
        </div>
      ) : null}
      <Button size="sm" variant="secondary" onClick={restore} loading={busy}>
        {single ? "Put back" : "Put all back"}
      </Button>
    </div>
  );
}
