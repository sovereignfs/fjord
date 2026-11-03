"use client";

import { useState } from "react";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import type { Properties } from "../document";

/**
 * The fields of a header that a form can set (ROADMAP 3g.2, RFC 0002): for a site, `draft` and `description`; for any Doc, every other key whose value is text or
 * a yes or no, and a way to add one. A value of another shape (a list, a mapping) is shown by the panel and kept as it is. Each change is one key, written by
 * `fjord-core` (`withField`): every other key stays where it was, in its order, so nothing a site's engine reads is lost to a form.
 */
export function FieldsForm({
  properties,
  site,
  disabled,
  onField,
}: {
  properties: Properties;
  /** Whether to offer `draft` and `description` by name: a site's posts have them. */
  site: boolean;
  disabled: boolean;
  /** Ask for one field to be set (text, a yes or no, or null to take it away); the answer is a message when it could not be. */
  onField: (key: string, value: string | boolean | null) => Promise<string | null>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function set(key: string, value: string | boolean | null) {
    setBusy(key);
    setProblem(null);
    const message = await onField(key, value);
    setBusy(null);
    if (message !== null) setProblem(message);
  }

  const editable = properties.others.filter((other) => other.editable !== undefined);
  if (!site && editable.length === 0 && properties.others.length === 0) return <AddField disabled={disabled} busy={busy !== null} set={set} problem={problem} />;

  return (
    <div data-testid="fields-form">
      {site ? (
        <>
          <label style={{ display: "block" }}>
            <input type="checkbox" name="draft" checked={properties.draft === true} disabled={disabled || busy === "draft"} onChange={(event) => void set("draft", event.target.checked)} /> Draft: not for the site yet
          </label>
          <TextField name="description" label="Description" value={properties.description ?? ""} disabled={disabled} busy={busy === "description"} set={set} />
        </>
      ) : null}
      {editable.map((other) =>
        other.editable === "flag" ? (
          <label key={other.key} style={{ display: "block" }}>
            <input type="checkbox" name={other.key} checked={other.value === "true"} disabled={disabled || busy === other.key} onChange={(event) => void set(other.key, event.target.checked)} /> {other.key}
          </label>
        ) : (
          <TextField key={other.key} name={other.key} label={other.key} value={other.value} disabled={disabled} busy={busy === other.key} set={set} />
        ),
      )}
      <AddField disabled={disabled} busy={busy !== null} set={set} problem={problem} />
    </div>
  );
}

function TextField({ name, label, value, disabled, busy, set }: { name: string; label: string; value: string; disabled: boolean; busy: boolean; set: (key: string, value: string | null) => Promise<void> }) {
  const [text, setText] = useState(value);
  const unchanged = text === value;
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void set(name, text === "" ? null : text);
      }}
    >
      <FormField label={label}>{(field) => <Input {...field} name={name} autoComplete="off" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} disabled={disabled || busy} />}</FormField>
      <div className={styles.actions}>
        <Button type="submit" variant="secondary" size="sm" loading={busy} disabled={disabled || unchanged}>
          Set {label}
        </Button>
      </div>
    </form>
  );
}

function AddField({ disabled, busy, set, problem }: { disabled: boolean; busy: boolean; set: (key: string, value: string | null) => Promise<void>; problem: string | null }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const valid = /^[A-Za-z0-9_-]{1,64}$/.test(key) && !["id", "created", "fjord"].includes(key);
  return (
    <form
      className={styles.form}
      aria-label="Add a field"
      onSubmit={(event) => {
        event.preventDefault();
        void set(key, value).then(() => (setKey(""), setValue("")));
      }}
    >
      <FormField label="Add a field" hint="A name (letters, digits, - and _) and its text, for a key your site or another tool reads. It is added at the end of the header.">
        {(field) => <Input {...field} name="field-name" autoComplete="off" maxLength={64} value={key} onChange={(e) => setKey(e.target.value)} disabled={disabled || busy} />}
      </FormField>
      <FormField label="Its text">{(field) => <Input {...field} name="field-value" autoComplete="off" maxLength={2000} value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled || busy} />}</FormField>
      {problem ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="The field was not changed">
            {problem}
          </Alert>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" variant="secondary" size="sm" disabled={disabled || busy || !valid || value === ""}>
          Add
        </Button>
      </div>
    </form>
  );
}
