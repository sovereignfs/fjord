"use client";

import { useState } from "react";
import { Alert, Button } from "../../ui";
import { localMomentText } from "../../ui/dates";
import { useConfirm } from "../../ui/useConfirm";
import type { FileVersion } from "../../providers/types";
import styles from "../../auth/screens/screens.module.css";
import { ActionDialog } from "./ActionDialog";
import { IconButton } from "./IconButton";
import { NodeIcon } from "../../ui/icons";

/**
 * A file's versions, from its page (research 0002, G7): who changed it and when, what any version said, and a way to put one back. Putting back makes the text a draft: nothing is committed until it is
 * saved as a version, and the versions in between stay in the repository. `open` turns a version's bytes into its text, which for an encrypted file is done in the browser with the identity kept there.
 */
export function History({ connectionId, path, open, restore, blocked }: { connectionId: number; path: string; open: (bytes: Uint8Array) => Promise<string>; restore: (text: string) => Promise<void>; /** Why a version cannot be put back just now. */ blocked?: string | undefined }) {
  const [shown, setShown] = useState(false);
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [more, setMore] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ version: FileVersion; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, asking] = useConfirm();

  const place = `path=${encodeURIComponent(path)}`;

  async function load() {
    setShown(true);
    setError(null);
    setViewing(null);
    setVersions(null);
    try {
      const response = await fetch(`/api/connections/${connectionId}/history?${place}`, { credentials: "same-origin" });
      const body = (await response.json().catch(() => null)) as { versions?: FileVersion[]; more?: boolean; supported?: boolean; error?: { message?: string } } | null;
      if (!response.ok) {
        setError(body?.error?.message ?? "The history could not be read just now. Try again in a moment.");
        return;
      }
      setVersions(body?.versions ?? []);
      setMore(body?.more === true);
      setSupported(body?.supported !== false);
    } catch {
      setError("Could not reach this server. Try again.");
    }
  }

  async function textOf(version: FileVersion): Promise<string | null> {
    try {
      const response = await fetch(`/api/connections/${connectionId}/history/file?${place}&commit=${version.commit}`, { credentials: "same-origin" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "That version could not be read just now.");
        return null;
      }
      return await open(new Uint8Array(await response.arrayBuffer()));
    } catch (failure) {
      setError(failure instanceof Error && failure.message !== "" ? failure.message : "That version could not be opened.");
      return null;
    }
  }

  async function view(version: FileVersion) {
    setBusy(version.commit);
    setError(null);
    const text = await textOf(version);
    if (text !== null) setViewing({ version, text });
    setBusy(null);
  }

  async function putBack(version: FileVersion, known?: string) {
    if (!(await ask({ message: `Put this version back, from ${localMomentText(version.date)}? It becomes a draft of this file: nothing is saved to the repository until you save a version, and every version stays in its history.`, confirm: "Put it back" }))) return;
    setBusy(version.commit);
    setError(null);
    const text = known ?? (await textOf(version));
    if (text === null) {
      setBusy(null);
      return;
    }
    try {
      await restore(text);
      setShown(false);
    } catch (failure) {
      setError(failure instanceof Error && failure.message !== "" ? failure.message : "That version could not be put back. Nothing was changed.");
    }
    setBusy(null);
  }

  return (
    <>
      <IconButton label="History" onClick={() => void load()}>
        <NodeIcon name="history" aria-hidden />
      </IconButton>
      <ActionDialog open={shown} onClose={busy ? () => undefined : () => setShown(false)} title="History">
        {asking}
        {error ? (
          <div className={styles.notice}>
            <Alert variant="error">{error}</Alert>
          </div>
        ) : null}
        {blocked ? <p className={styles.itemMeta}>{blocked}</p> : null}
        {viewing ? (
          <div data-testid="history-version">
            <p className={styles.itemMeta}>
              {viewing.version.message} · {viewing.version.author ?? "Someone"} · {localMomentText(viewing.version.date)}
            </p>
            <pre style={{ maxHeight: "24rem", overflow: "auto", padding: "var(--sv-space-3)", background: "var(--sv-color-surface-sunken)", borderRadius: "var(--sv-radius-md)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--sv-font-family-mono)", fontSize: "var(--sv-font-size-sm)" }}>{viewing.text}</pre>
            <div className={styles.actions}>
              <Button size="sm" variant="secondary" onClick={() => setViewing(null)}>
                Back to the list
              </Button>{" "}
              {!blocked && versions?.[0]?.commit !== viewing.version.commit ? (
                <Button size="sm" onClick={() => void putBack(viewing.version, viewing.text)} loading={busy === viewing.version.commit}>
                  Put this version back
                </Button>
              ) : null}
            </div>
          </div>
        ) : versions === null && !error ? (
          <p className={styles.itemMeta}>Reading the history…</p>
        ) : !supported ? (
          <p>This repository&apos;s host does not say. Its history is in git.</p>
        ) : versions !== null && versions.length === 0 ? (
          <p>No saved versions of this file are known.</p>
        ) : versions !== null ? (
          <>
            <ul className={styles.list} aria-label="Versions">
              {versions.map((version, index) => (
                <li key={version.commit} className={styles.item}>
                  <span>
                    {version.message || "(no message)"} {index === 0 ? <span className={styles.itemMeta}>· the one saved now</span> : null}
                    <br />
                    <span className={styles.itemMeta}>
                      {version.author ?? "Someone"} · {localMomentText(version.date)} · <code>{version.commit.slice(0, 7)}</code>
                    </span>
                  </span>
                  <span className={styles.actions} style={{ flexWrap: "nowrap" }}>
                    <Button size="sm" variant="secondary" onClick={() => void view(version)} loading={busy === version.commit}>
                      View
                    </Button>
                    {index > 0 && !blocked ? (
                      <Button size="sm" variant="secondary" onClick={() => void putBack(version)} disabled={busy !== null}>
                        Put back
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {more ? <p className={styles.itemMeta}>These are the newest {versions.length}. The rest are in git.</p> : null}
            <p className={styles.itemMeta}>History goes back to when the file got its current name and place; before that, it is in git under the old one.</p>
          </>
        ) : null}
      </ActionDialog>
    </>
  );
}
