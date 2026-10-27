"use client";

import { useState } from "react";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { MAX_TITLE_CHARS } from "../../files/limits";
import type { Properties } from "../document";

/**
 * The Document properties panel (ROADMAP 1b.5, DESIGN.md §9): what the header of a note or a document says, beside the editor
 * and not in it. The title can be changed; the identifier and the day it was made are the format's (spec §8) and are only
 * shown; every other key is something Fjord does not know, shown as it is written and kept as it is. When the file has no
 * header yet, the panel says one is added the first time it is edited, which is when `properties` is the one it will get.
 */
export function DocumentProperties({
  properties,
  pending,
  disabled,
  onTitle,
}: {
  properties: Properties;
  /** True while the header is still to be added, on the first edit. */
  pending: boolean;
  disabled: boolean;
  /** Ask for the title to be set; the answer is a message when it could not be. */
  onTitle: (title: string) => Promise<string | null>;
}) {
  const [title, setTitle] = useState(properties.title ?? "");
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const unchanged = title.trim() === (properties.title ?? "");

  async function change() {
    setChanging(true);
    setProblem(null);
    const message = await onTitle(title);
    setChanging(false);
    if (message !== null) setProblem(message);
  }

  return (
    <details className={styles.itemMeta} data-testid="document-properties">
      <summary>Properties</summary>
      {pending ? <p>This file has no header yet. One is added, with an identifier, a title and the date, the first time you edit it. Nothing changes until then.</p> : null}
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void change();
        }}
      >
        <FormField label="Title" hint="Advisory: the file's name is not changed.">
          {(field) => <Input {...field} name="title" autoComplete="off" maxLength={MAX_TITLE_CHARS} value={title} onChange={(e) => setTitle(e.target.value)} disabled={disabled || pending || changing} />}
        </FormField>
        {problem ? (
          <div className={styles.notice}>
            <Alert variant="error" heading="The title was not changed">
              {problem}
            </Alert>
          </div>
        ) : null}
        <div className={styles.actions}>
          <Button type="submit" variant="secondary" size="sm" loading={changing} disabled={disabled || pending || unchanged}>
            Set title
          </Button>
        </div>
      </form>
      <dl>
        <dt>Identifier</dt>
        <dd>
          <code>{properties.id ?? "none"}</code>
        </dd>
        <dt>Created</dt>
        <dd>{properties.created ?? "not recorded"}</dd>
        {properties.others.map(({ key, value }) => (
          <div key={key} data-testid="other-property">
            <dt>{key}</dt>
            <dd>
              <code>{value}</code>
            </dd>
          </div>
        ))}
      </dl>
      {properties.others.length > 0 ? <p>Properties Fjord does not know are kept as they are.</p> : null}
    </details>
  );
}
